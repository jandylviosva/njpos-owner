// Vercel Serverless Function — runs on the server, not the browser
// Single gateway for every "dangerous" Dev Console write: license
// create/suspend, store wipe/delete/clear-orders, device removal, dev
// token creation, store profile edits, team management. Uses the
// Supabase service_role key (server-only, never shipped to a browser)
// and only proceeds if the caller presents a session token issued by
// send-dev-otp.js after a real, server-verified OTP.
//
// ROLE ENFORCEMENT — two roles, checked here on every action:
//   owner — can do everything, including managing the team and
//           granting/revoking which agent can see which store.
//   agent — read-only on everything except create_license. Every
//           other action in this file is blocked for agents, even if
//           they craft the request by hand (this is enforced
//           server-side, not just hidden in the UI).
//
// Env vars required (Vercel project settings):
//   SUPA_URL            — same Supabase project URL (falls back to
//                          VITE_SUPA_URL if SUPA_URL isn't set)
//   SUPA_SERVICE_KEY     — Supabase secret key (sb_secret_... or legacy
//                          service_role). NEVER prefix with VITE_.
//   DEV_SESSION_SECRET   — same secret used in send-dev-otp.js

import crypto from "node:crypto";

const ALLOWED_ORIGINS = [
  "https://dev.pospro-portal.com",
  "https://pospro-dev.vercel.app",
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/pospro-dev(-[a-z0-9]+)?\.vercel\.app$/.test(origin);
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function verifySessionToken(token) {
  try {
    const [b64, sig] = String(token).split(".");
    if (!b64 || !sig) return null;
    const expected = crypto
      .createHmac("sha256", process.env.DEV_SESSION_SECRET)
      .update(b64)
      .digest("hex");
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (!payload.email || !payload.role) return null;
    return payload; // { email, role, name, iat, exp }
  } catch {
    return null;
  }
}

async function supa(path, init) {
  const r = await fetch(`${process.env.SUPA_URL || process.env.VITE_SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPA_SERVICE_KEY,
      Prefer: "return=representation",
      ...(init?.headers || {}),
    },
  });
  return r;
}
async function supaJson(path, init) {
  const r = await supa(path, init);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Supabase error (${r.status}): ${text}`);
  }
  return r.json();
}

// Uploads a base64 data: URL to the private payment-screenshots bucket
// and returns a long-lived signed URL (1 year — this is an internal
// admin tool, not something that needs short-lived link expiry). The
// bucket has no public access at all; only the service_role key used
// here can ever write to or read from it.
async function uploadPaymentScreenshot(base64DataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(base64DataUrl || "");
  if (!match) throw new Error("Invalid image data");
  const contentType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  const ext = (contentType.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${crypto.randomUUID()}.${ext}`;
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

  const uploadRes = await fetch(`${SUPA_URL}/storage/v1/object/payment-screenshots/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      apikey: SUPA_SERVICE_KEY,
    },
    body: buffer,
  });
  if (!uploadRes.ok) {
    const t = await uploadRes.text().catch(() => "");
    throw new Error(`Screenshot upload failed: ${t}`);
  }
  // Just the bare storage path is stored — NOT a signed URL. Signed
  // URLs are generated fresh, on demand, only when someone actually
  // clicks to view the screenshot (see signScreenshotPath / the
  // get_screenshot_url action below). This means there's nothing
  // stored that can ever go stale or be built with a wrong prefix —
  // every view re-derives the URL correctly at that moment, which also
  // means old records with the previous (broken, missing /storage/v1)
  // full URL saved just work too, once extracted back down to a bare
  // path by extractScreenshotPath.
  return path;
}

// Generates a working signed URL for a stored screenshot path, fresh,
// right when it's actually needed. Short expiry is fine now (unlike the
// old 1-year expiry) since a new one gets generated on every view.
async function signScreenshotPath(path) {
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  const signRes = await fetch(`${SUPA_URL}/storage/v1/object/sign/payment-screenshots/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      apikey: SUPA_SERVICE_KEY,
    },
    body: JSON.stringify({ expiresIn: 60 * 60 }),
  });
  if (!signRes.ok) {
    const t = await signRes.text().catch(() => "");
    throw new Error(`Failed to sign screenshot URL: ${t}`);
  }
  const signData = await signRes.json();
  // Supabase's sign response returns signedURL as a path like
  // "/object/sign/bucket/file?token=..." — it does NOT include the
  // /storage/v1 prefix, even though every other storage API call does.
  return `${SUPA_URL}/storage/v1${signData.signedURL}`;
}

// Handles both the new format (a bare path, e.g. "abc123.jpg") and
// whatever was saved by the old, buggy upload code (a full URL, with or
// without the missing /storage/v1 prefix) — pulls just the file path
// out of either shape, so old records work without ever needing a
// separate repair step.
function extractScreenshotPath(stored) {
  if (!stored) return null;
  if (!stored.startsWith("http")) return stored;
  const match = /payment-screenshots\/([^?]+)/.exec(stored);
  return match ? match[1] : null;
}

// Rolls a store's next-payment-due date forward by one month, and
// records the amount that was actually paid this cycle as what's
// expected next time (shown/editable in the Scheduler — covers add-ons
// changing a store's real monthly total from month to month).
// Advances from the EXISTING due date if one's set (keeps the billing
// cadence steady — the 15th stays the 15th every month, regardless of
// which day you happen to log the confirmation on) or from today if
// this is the store's first-ever monthly payment.
async function advanceStoreBilling(storeId, paidAmount) {
  const storeRows = await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}&select=next_payment_date`, { method: "GET" });
  const current = storeRows?.[0]?.next_payment_date;
  const base = current ? new Date(current) : new Date();
  const next = new Date(base);
  next.setMonth(next.getMonth() + 1);
  const nextStr = next.toISOString().slice(0, 10);
  const patch = { next_payment_date: nextStr, billing_plan: "monthly" };
  if (paidAmount !== undefined && paidAmount !== null) {
    const amt = Number(paidAmount) || 0;
    patch.next_payment_amount = amt;
    // Auto-advance can only know the total that was actually paid, not
    // which add-ons make it up — defaults to a single "Standard Plan"
    // line for that total. If this store genuinely has add-ons, the
    // owner can break it into separate lines afterward in the
    // Scheduler (Standard Plan + Extra Device Slot, etc.).
    patch.next_payment_breakdown = [{ label: "Standard Plan", amount: amt }];
  }
  await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return nextStr;
}

// Builds the exact reminder email content — used by both the real send
// and the preview action, so what "View Email" shows can never drift
// out of sync with what actually goes out. Shows an itemized breakdown
// (base plan + any add-ons, each on its own line with a total) when
// one's been set, or a single flat amount if not — doesn't mention a
// specific payment method, since that shouldn't be hardcoded into the
// wording for a customer who might pay differently.
function buildReminderEmail(store) {
  const dueDate = store?.next_payment_date
    ? new Date(store.next_payment_date).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" })
    : "soon";
  const breakdown = Array.isArray(store?.next_payment_breakdown) ? store.next_payment_breakdown : [];
  const fmtPeso = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  let amountBlock = "";
  if (breakdown.length > 0) {
    const lines = breakdown
      .map(item => `<tr><td style="padding:4px 0;color:#374151;font-size:14px">${item.label}</td><td style="padding:4px 0;text-align:right;color:#374151;font-size:14px">${fmtPeso(item.amount)}</td></tr>`)
      .join("");
    const total = breakdown.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    amountBlock = `<div style="background:#f5f3ff;border:2px dashed #7c3aed;border-radius:10px;padding:16px;margin:20px 0">
      <table style="width:100%;border-collapse:collapse">${lines}
        <tr><td style="padding-top:8px;border-top:1px solid #ddd6fe;font-weight:800;color:#111;font-size:15px">Total</td><td style="padding-top:8px;border-top:1px solid #ddd6fe;text-align:right;font-weight:800;color:#4f46e5;font-size:18px">${fmtPeso(total)}</td></tr>
      </table>
    </div>`;
  } else if (store?.next_payment_amount) {
    amountBlock = `<div style="background:#f5f3ff;border:2px dashed #7c3aed;border-radius:10px;padding:16px;text-align:center;margin:20px 0">
      <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Amount due</div>
      <div style="font-size:26px;font-weight:800;color:#4f46e5">${fmtPeso(store.next_payment_amount)}</div>
    </div>`;
  }

  // The Pay Now link carries the exact amount/breakdown shown in THIS
  // email, base64-encoded into the URL — not just a store ID that the
  // bill-payment page would re-look-up live. That guarantees whatever
  // the customer sees on that page always matches what they were just
  // told here, even if the store's live billing data changes later
  // (an add-on removed, a manual adjustment) between now and whenever
  // they actually click through.
  const effectiveBreakdown = breakdown.length > 0
    ? breakdown
    : (store?.next_payment_amount ? [{ label: "Standard Plan", amount: store.next_payment_amount }] : []);
  const effectiveTotal = effectiveBreakdown.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const payNowUrl = `https://client.pospro-portal.com/bill-payment?store=${encodeURIComponent(store?.id || "")}`
    + `&storeName=${encodeURIComponent(store?.store_name || "")}`
    + `&amount=${effectiveTotal}`
    + `&breakdown=${encodeURIComponent(Buffer.from(JSON.stringify(effectiveBreakdown)).toString("base64"))}`;

  const subject = `Payment reminder — POS Pro (${store?.store_name || "your store"})`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
    <div style="background:#4f46e5;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
      <div style="color:#fff;font-size:22px;font-weight:800">POS Pro</div>
    </div>
    <h2 style="color:#111">Payment reminder</h2>
    <p style="color:#374151;font-size:15px;line-height:1.6">This is a friendly reminder that your POS Pro subscription payment for <b>${store?.store_name || "your store"}</b> is due on <b>${dueDate}</b>.</p>
    ${amountBlock}
    <div style="text-align:center;margin:24px 0">
      <a href="${payNowUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:15px;font-weight:800">Pay Now</a>
    </div>
    <p style="color:#374151;font-size:15px;line-height:1.6">Please settle your payment to keep your account active without interruption. If you've already paid, you can disregard this message.</p>
    <p style="color:#9ca3af;font-size:12px;margin-top:30px">— The POS Pro Team</p>
  </div>`;

  return { subject, html };
}

function genLicenseCode(prefix = "POS") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

// ─── One-time dateKey correction (UTC-vs-local bug fix) ──────────
// Ported from the standalone fix-datekeys.mjs script — same logic,
// run from inside the Dev Console instead of a terminal. Recomputes
// dateKey/startDateKey from each record's reliable local-time field
// (order.date, shift.startTime, log.ts), fixing records that were
// misfiled under the previous day due to the old .toISOString()-based
// date math (PH is UTC+8, so 12am-8am orders shifted to "yesterday").
//
// CRITICAL: like the standalone script, correctness here depends on
// running in Philippine time. Vercel serverless functions don't let
// you reliably force process.env.TZ the same way a long-running Node
// script can — so instead we do the local-date math by hand using a
// fixed UTC+8 offset, which is correct for PH regardless of what
// timezone the server itself happens to run in.
//
// NOTE FOR THE FUTURE: this offset is hardcoded for PH. If you ever
// onboard stores outside the Philippines, this one-time fix tool (and
// the equivalent date logic in PWA/Portal/Dev Console's own App.jsx
// files) would need a per-store timezone instead of one fixed offset.
const PH_OFFSET_MINUTES = 8 * 60;
function toLocalDateKeyPH(d) {
  // Shift the UTC timestamp by exactly +8 hours, then read the date
  // parts off the result using UTC getters — this avoids any
  // dependency on the server's actual system timezone.
  const shifted = new Date(d.getTime() + PH_OFFSET_MINUTES * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Order/shift records store human-readable strings like
// "6/30/2026, 4:50:09 AM" via toLocaleString("en-PH") — these have NO
// timezone marker, so `new Date(...)` parses them using whatever
// timezone the CALLING environment happens to be in. On a Vercel
// server (commonly UTC), that would silently misinterpret a string
// that was always meant as PH local time. We parse the components by
// hand instead and construct the equivalent UTC instant ourselves,
// so this is correct no matter what timezone the server runs in.
function parsePHLocaleString(s) {
  if (!s) return null;
  // Matches "M/D/YYYY, H:MM:SS AM/PM" (en-PH toLocaleString format)
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(s.trim());
  if (!match) return null;
  let [, mo, da, yr, hr, mi, se, ap] = match;
  mo = Number(mo); da = Number(da); yr = Number(yr);
  hr = Number(hr); mi = Number(mi); se = Number(se);
  if (/pm/i.test(ap) && hr !== 12) hr += 12;
  if (/am/i.test(ap) && hr === 12) hr = 0;
  // Construct as if these components were UTC, then subtract the PH
  // offset to get the TRUE UTC instant (since the components are
  // actually PH-local, UTC instant = PH time - 8 hours).
  const asIfUTC = Date.UTC(yr, mo - 1, da, hr, mi, se);
  return new Date(asIfUTC - PH_OFFSET_MINUTES * 60 * 1000);
}
function parseLocalString(s) {
  // Try strict PH-locale parsing first (the expected format for these
  // fields); fall back to native Date parsing only for other formats
  // (e.g. openedAt, which is a proper ISO string with timezone info
  // and is safe to parse natively).
  return parsePHLocaleString(s) || (() => {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  })();
}
function computeDatekeyFixes(storeData) {
  let ordersChanged = 0, shiftsChanged = 0, logsChanged = 0;

  const fixedOrders = (storeData.orders || []).map(o => {
    const src = parseLocalString(o.date) || (o.openedAt ? new Date(o.openedAt) : null);
    if (!src) return o;
    const correctKey = toLocalDateKeyPH(src);
    if (correctKey !== o.dateKey) { ordersChanged++; return { ...o, dateKey: correctKey }; }
    return o;
  });

  const fixedShifts = (storeData.shifts || []).map(s => {
    const src = parseLocalString(s.startTime);
    if (!src) return s;
    const correctKey = toLocalDateKeyPH(src);
    if (correctKey !== s.startDateKey) { shiftsChanged++; return { ...s, startDateKey: correctKey }; }
    return s;
  });

  const fixedLogs = (storeData.logs || []).map(l => {
    if (!l.ts) return l;
    const src = new Date(l.ts);
    if (isNaN(src.getTime())) return l;
    const correctKey = toLocalDateKeyPH(src);
    if (correctKey !== l.dateKey) { logsChanged++; return { ...l, dateKey: correctKey }; }
    return l;
  });

  return { fixedOrders, fixedShifts, fixedLogs, ordersChanged, shiftsChanged, logsChanged };
}

// Actions an agent is allowed to call at all. Everything not in this
// list is owner-only, enforced below regardless of what the client
// sends — an agent crafting a raw request to e.g. delete_store will
// still be rejected here.
//
// KNOWN LIMITATION (accepted for now, internal trusted-team tool):
// stores/licenses are still readable directly via the Supabase
// publishable key from the browser (required so the public PWA/portal
// apps can look up a store by email pre-login). That means an agent
// could bypass the UI's filtering and read the raw, unscoped list by
// querying Supabase directly with devtools, even though the dashboard
// itself only shows them their assigned stores. list_my_stores/
// list_my_licenses below give the UI a properly-scoped source to
// render from, but they don't prevent the bypass — only a future
// change that moves dev console reads through this gateway (revoking
// publishable-key SELECT entirely for an authenticated dev session)
// would close that gap. Revisit if agent trust level changes.
const AGENT_ALLOWED_ACTIONS = new Set([
  "create_license",
  "list_my_stores",
  "list_my_licenses",
  "create_dev_token",
  // Extending a trial is the same trust level as create_license — an
  // agent could already hand a customer unlimited free time by just
  // generating a fresh trial code, so gating this one to owners only
  // wouldn't actually prevent anything, just make the common "customer
  // asked for a few more days" support case more annoying.
  "extend_trial",
]);

async function agentHasStoreAccess(agentEmail, storeId) {
  const rows = await supaJson(
    `store_access?agent_email=eq.${encodeURIComponent(agentEmail)}&store_id=eq.${encodeURIComponent(storeId)}&limit=1`,
    { method: "GET" }
  );
  return rows.length > 0;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: "Not authorized" });

  const { action, payload } = req.body || {};
  if (!action) return res.status(400).json({ error: "Missing action" });

  const isOwner = session.role === "owner";

  if (!isOwner && !AGENT_ALLOWED_ACTIONS.has(action)) {
    return res.status(403).json({ error: "Not allowed for your role" });
  }

  try {
    switch (action) {
      case "scan_datekey_fixes": {
        // Owner-only (default deny applies since not in AGENT_ALLOWED_ACTIONS).
        // Dry run — reads every store_data row, computes what WOULD
        // change, writes nothing. Used to populate the preview before
        // the owner confirms with apply_datekey_fixes.
        const rows = await supaJson("store_data?select=store_id,orders,shifts,logs", { method: "GET" });
        const results = [];
        let totalOrders = 0, totalShifts = 0, totalLogs = 0;
        for (const row of rows) {
          const { ordersChanged, shiftsChanged, logsChanged } = computeDatekeyFixes(row);
          if (ordersChanged + shiftsChanged + logsChanged === 0) continue;
          results.push({ store_id: row.store_id, ordersChanged, shiftsChanged, logsChanged });
          totalOrders += ordersChanged; totalShifts += shiftsChanged; totalLogs += logsChanged;
        }
        return res.status(200).json({
          ok: true,
          storesScanned: rows.length,
          storesAffected: results.length,
          totalOrders, totalShifts, totalLogs,
          results,
        });
      }

      case "apply_datekey_fixes": {
        // Owner-only. Re-computes and WRITES the corrected dateKey/
        // startDateKey values. Re-reads fresh data rather than trusting
        // anything the client sent, so this can't be tricked into
        // writing arbitrary data — it only ever writes the result of
        // computeDatekeyFixes run against the current real row.
        const rows = await supaJson("store_data?select=store_id,orders,shifts,logs", { method: "GET" });
        const results = [];
        let totalOrders = 0, totalShifts = 0, totalLogs = 0;
        for (const row of rows) {
          const { fixedOrders, fixedShifts, fixedLogs, ordersChanged, shiftsChanged, logsChanged } = computeDatekeyFixes(row);
          if (ordersChanged + shiftsChanged + logsChanged === 0) continue;
          await supaJson(`store_data?store_id=eq.${encodeURIComponent(row.store_id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              orders: fixedOrders,
              shifts: fixedShifts,
              logs: fixedLogs,
              updated_at: new Date().toISOString(),
            }),
          });
          results.push({ store_id: row.store_id, ordersChanged, shiftsChanged, logsChanged });
          totalOrders += ordersChanged; totalShifts += shiftsChanged; totalLogs += logsChanged;
        }
        return res.status(200).json({
          ok: true,
          storesFixed: results.length,
          totalOrders, totalShifts, totalLogs,
          results,
        });
      }

      case "list_my_stores": {
        // Returns full store rows for stores this person has access to.
        // Owners get everything; agents get only their store_access grants.
        if (isOwner) {
          const rows = await supaJson("stores?order=created_at.desc&limit=500", { method: "GET" });
          return res.status(200).json({ ok: true, stores: rows });
        }
        const grants = await supaJson(
          `store_access?agent_email=eq.${encodeURIComponent(session.email)}&select=store_id`,
          { method: "GET" }
        );
        const storeIds = grants.map(g => g.store_id);
        if (storeIds.length === 0) return res.status(200).json({ ok: true, stores: [] });
        const idList = storeIds.join(",");
        const rows = await supaJson(`stores?id=in.(${idList})&order=created_at.desc`, { method: "GET" });
        return res.status(200).json({ ok: true, stores: rows });
      }

      case "list_my_licenses": {
        // Owners get every license. Agents get licenses tied to their
        // assigned stores, PLUS any license they personally generated
        // (created_by), matching the original request exactly.
        if (isOwner) {
          const rows = await supaJson("licenses?order=created_at.desc&limit=500", { method: "GET" });
          return res.status(200).json({ ok: true, licenses: rows });
        }
        const grants = await supaJson(
          `store_access?agent_email=eq.${encodeURIComponent(session.email)}&select=store_id`,
          { method: "GET" }
        );
        const storeIds = grants.map(g => g.store_id);
        const orParts = [`created_by.eq.${encodeURIComponent(session.email)}`];
        if (storeIds.length > 0) orParts.push(`store_id.in.(${storeIds.join(",")})`);
        const rows = await supaJson(`licenses?or=(${orParts.join(",")})&order=created_at.desc`, { method: "GET" });
        return res.status(200).json({ ok: true, licenses: rows });
      }

      case "get_screenshot_url": {
        // Generates a fresh, correctly-built signed URL right when
        // someone actually wants to view a screenshot — works
        // identically whether the record was uploaded before or after
        // the original /storage/v1 bug, since extractScreenshotPath
        // pulls the real file path out of either shape.
        const { paymentId } = payload || {};
        if (!paymentId) return res.status(400).json({ error: "Missing paymentId" });
        const rows = await supaJson(`payment_records?id=eq.${encodeURIComponent(paymentId)}&select=screenshot_url`, { method: "GET" });
        const path = extractScreenshotPath(rows?.[0]?.screenshot_url);
        if (!path) return res.status(404).json({ error: "No screenshot on this record" });
        try {
          const url = await signScreenshotPath(path);
          return res.status(200).json({ ok: true, url });
        } catch (e) {
          return res.status(500).json({ error: e.message || "Failed to generate view link" });
        }
      }

      case "list_payments": {
        // Owner-only (default deny — not in AGENT_ALLOWED_ACTIONS).
        // Payment records aren't scoped per-agent the way stores/
        // licenses are; only owners see this list at all.
        const rows = await supaJson("payment_records?order=created_at.desc&limit=500", { method: "GET" });
        return res.status(200).json({ ok: true, payments: rows });
      }

      case "add_payment_record": {
        // Manual entry — cash, bank transfer, or anything collected
        // outside the landing page's GCash QR flow. Source is forced to
        // "manual" server-side regardless of what's sent, so a manual
        // entry can never masquerade as a "landing_page" submission.
        const { customerName, customerEmail, amount, plan, method, notes, status, storeId, screenshotBase64 } = payload || {};
        let screenshotUrl = null;
        if (screenshotBase64) {
          try {
            screenshotUrl = await uploadPaymentScreenshot(screenshotBase64);
          } catch (e) {
            return res.status(500).json({ error: e.message || "Failed to upload screenshot" });
          }
        }
        const row = {
          source: "manual",
          customer_name: customerName || null,
          customer_email: customerEmail || null,
          amount: Number(amount) || 0,
          plan: plan || null,
          method: method || "Other",
          notes: notes || null,
          status: status === "confirmed" ? "confirmed" : "pending",
          store_id: storeId || null,
          screenshot_url: screenshotUrl,
        };
        const created = await supaJson("payment_records", {
          method: "POST",
          body: JSON.stringify(row),
        });
        // A confirmed monthly payment linked to a store rolls that
        // store's next-due date forward right away, same as confirming
        // an existing pending record (see update_payment_status below).
        if (row.status === "confirmed" && row.store_id && row.plan === "standard_monthly") {
          await advanceStoreBilling(row.store_id, row.amount);
        }
        return res.status(200).json({ ok: true, payment: created?.[0] || null });
      }

      case "update_payment_status": {
        const { id, status, amount } = payload || {};
        if (!id) return res.status(400).json({ error: "Missing id" });
        if (status && !["pending", "confirmed", "rejected"].includes(status)) {
          return res.status(400).json({ error: "Invalid status" });
        }
        const patch = {};
        if (status) patch.status = status;
        if (amount !== undefined) patch.amount = Number(amount) || 0;
        await supaJson(`payment_records?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        // Confirming a monthly payment linked to a store rolls that
        // store's next-due date forward a month.
        if (status === "confirmed") {
          const rows = await supaJson(`payment_records?id=eq.${encodeURIComponent(id)}&select=store_id,plan,amount`, { method: "GET" });
          const rec = rows?.[0];
          if (rec?.store_id && rec.plan === "standard_monthly") {
            await advanceStoreBilling(rec.store_id, patch.amount !== undefined ? patch.amount : rec.amount);
          }
        }
        return res.status(200).json({ ok: true });
      }

      case "set_next_payment_date": {
        // Manual override — for adjusting a store's due date and/or
        // billing breakdown directly (grace period, plan change, add-on
        // price change, correcting a mistake) without needing to go
        // through a payment record at all. Breakdown is a list of line
        // items — e.g. [{label:"Standard Plan",amount:399},
        // {label:"Extra Device Slot",amount:149}] — next_payment_amount
        // is always kept as the sum of these, computed server-side so
        // it can never drift from what the breakdown actually adds up to.
        const { storeId, date, breakdown } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });
        const patch = {};
        if (date !== undefined) patch.next_payment_date = date || null;
        if (breakdown !== undefined) {
          const items = Array.isArray(breakdown) ? breakdown.filter(i => i && i.label) : [];
          patch.next_payment_breakdown = items;
          patch.next_payment_amount = items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
        }
        await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        return res.status(200).json({ ok: true });
      }

      case "list_payment_schedule": {
        // Owner-only. Only stores with a due date set — lifetime
        // customers and stores that have never had a monthly payment
        // recorded simply never appear here.
        const rows = await supaJson(
          "stores?next_payment_date=not.is.null&select=id,store_name,owner_email,owner_name,next_payment_date,next_payment_amount,next_payment_breakdown,billing_plan&order=next_payment_date.asc",
          { method: "GET" }
        );
        return res.status(200).json({ ok: true, schedule: rows });
      }

      case "preview_payment_reminder":
      case "send_payment_reminder": {
        // Both branches build the EXACT same email — preview just skips
        // the actual send, so what's shown in "View Email" can never
        // drift out of sync with what really goes out.
        const { storeId, email } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });
        if (action === "send_payment_reminder" && !email) return res.status(400).json({ error: "Missing email" });

        const storeRows = await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}&select=store_name,next_payment_date,next_payment_amount,next_payment_breakdown`, { method: "GET" });
        const store = storeRows?.[0];
        const { subject, html } = buildReminderEmail(store);

        if (action === "preview_payment_reminder") {
          return res.status(200).json({ ok: true, subject, html });
        }

        const RESEND_KEY = process.env.RESEND_KEY;
        if (!RESEND_KEY) return res.status(500).json({ error: "Resend not configured" });
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({ from: "POS Pro <noreply@pospro-portal.com>", to: [email], subject, html }),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          return res.status(500).json({ error: `Failed to send reminder: ${errText}` });
        }
        return res.status(200).json({ ok: true });
      }

      case "create_license": {
        const { plan, maxDevices, note, trialExpiresAt, prefix } = payload || {};
        const code = genLicenseCode((prefix || "POS").trim().toUpperCase() || "POS");
        const row = {
          code,
          plan: plan || "standard",
          max_devices: Number(maxDevices) || 1,
          status: "unused",
          notes: note?.trim() || null,
          created_at: new Date().toISOString(),
          // Tag who made it. Agents can generate freely (codes aren't
          // tied to a store until a customer activates one), but this
          // lets the UI show "your generated codes" for an agent, and
          // "all codes" for an owner.
          created_by: session.email,
        };
        if (trialExpiresAt) row.trial_expires_at = trialExpiresAt;
        const result = await supaJson("licenses", { method: "POST", body: JSON.stringify([row]) });
        return res.status(200).json({ ok: true, license: result[0] });
      }

      case "extend_trial": {
        // Pushes a trial license's expiry out by `days`, or to an exact
        // `newExpiry` if given. Extending always counts from whichever
        // is later — "now" or the license's current expiry — so hitting
        // "+7 days" on an already-expired trial gives 7 days from today,
        // not 7 days added on top of a date that already passed (which
        // would silently do nothing for a trial that expired a while ago).
        const { code, days, newExpiry } = payload || {};
        if (!code) return res.status(400).json({ error: "Missing code" });
        const rows = await supaJson(`licenses?code=eq.${encodeURIComponent(code)}&limit=1`, { method: "GET" });
        const lic = rows?.[0];
        if (!lic) return res.status(404).json({ error: "License not found" });
        if (lic.plan !== "trial") return res.status(400).json({ error: "Only trial licenses can be extended" });

        let nextExpiry;
        if (newExpiry) {
          const d = new Date(newExpiry);
          if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid date" });
          nextExpiry = d.toISOString();
        } else if (days) {
          const base = lic.trial_expires_at && new Date(lic.trial_expires_at) > new Date()
            ? new Date(lic.trial_expires_at)
            : new Date();
          base.setDate(base.getDate() + Number(days));
          nextExpiry = base.toISOString();
        } else {
          return res.status(400).json({ error: "Missing days or newExpiry" });
        }

        await supaJson(`licenses?code=eq.${encodeURIComponent(code)}`, {
          method: "PATCH",
          body: JSON.stringify({ trial_expires_at: nextExpiry }),
        });
        return res.status(200).json({ ok: true, trial_expires_at: nextExpiry });
      }

      // ─── Everything below this line is owner-only (already gated
      // above, but kept exactly as before for clarity) ───────────

      case "suspend_license": {
        const { code, suspend } = payload || {};
        if (!code) return res.status(400).json({ error: "Missing code" });
        let nextStatus;
        if (suspend) {
          nextStatus = "suspended";
        } else {
          // Reactivating always used to set status back to "unused" — fine
          // for a code that was never redeemed, but wrong for a store
          // that had already activated: it would look un-redeemed again
          // even though it has a real store_id attached, and the app has
          // no way to tell "this is a working store" apart from "this
          // code has never been used" from that field alone. Restore to
          // whichever is actually true: "active" if a store already
          // claimed this code, "unused" if it never got that far.
          const rows = await supaJson(`licenses?code=eq.${encodeURIComponent(code)}&limit=1`, { method: "GET" });
          const lic = rows?.[0];
          nextStatus = lic?.store_id ? "active" : "unused";
        }
        await supaJson(`licenses?code=eq.${encodeURIComponent(code)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        });
        return res.status(200).json({ ok: true, status: nextStatus });
      }

      case "update_license_note": {
        const { id, note } = payload || {};
        if (!id) return res.status(400).json({ error: "Missing id" });
        await supaJson(`licenses?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ notes: note?.trim() || null }),
        });
        return res.status(200).json({ ok: true });
      }

      case "remove_device": {
        const { storeId, devices } = payload || {};
        if (!storeId || !Array.isArray(devices)) return res.status(400).json({ error: "Bad payload" });
        await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify({ devices }),
        });
        return res.status(200).json({ ok: true });
      }

      case "update_max_devices": {
        // For device-slot add-ons — a client pays for another seat, this
        // bumps the limit without anyone needing to open Supabase. Devices
        // themselves still self-register from the app as normal; this
        // only changes how many they're allowed to have at once.
        const { storeId, maxDevices } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });
        const n = Number(maxDevices);
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "maxDevices must be a positive whole number" });
        await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify({ max_devices: n }),
        });
        return res.status(200).json({ ok: true, max_devices: n });
      }

      case "send_activation_email": {
        // Owner-only (not in AGENT_ALLOWED_ACTIONS) — emails a customer
        // their activation code after a manual payment (GCash, cash,
        // bank transfer, etc.) is confirmed. Confirms the code is a
        // real license before sending anything, since this endpoint
        // could otherwise be used to blast arbitrary email to arbitrary
        // addresses if someone crafted the request by hand.
        const { code, email } = payload || {};
        if (!code || !email) return res.status(400).json({ error: "Missing code or email" });
        const RESEND_KEY = process.env.RESEND_KEY;
        if (!RESEND_KEY) return res.status(500).json({ error: "Resend not configured" });

        const rows = await supaJson(`licenses?code=eq.${encodeURIComponent(code)}&limit=1`, { method: "GET" });
        if (!rows?.[0]) return res.status(404).json({ error: "License code not found" });

        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({
            from: "POS Pro <noreply@pospro-portal.com>",
            to: [email],
            subject: "Thank you for subscribing to POS Pro!",
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
              <div style="background:#4f46e5;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
                <div style="color:#fff;font-size:22px;font-weight:800">POS Pro</div>
              </div>
              <h2 style="color:#111">Thank you for subscribing!</h2>
              <p style="color:#374151;font-size:15px;line-height:1.6">We've received your payment and your POS Pro account is ready to go. Use the activation code below to set up your app:</p>
              <div style="background:#f5f3ff;border:2px dashed #7c3aed;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
                <div style="font-size:28px;font-weight:800;letter-spacing:2px;color:#4f46e5;font-family:monospace">${code}</div>
              </div>
              <p style="color:#6b7280;font-size:13px;line-height:1.6">Open the POS Pro app, choose "I have an activation code," and enter the code above to get started. If you have any questions, just reply to this email.</p>
              <p style="color:#9ca3af;font-size:12px;margin-top:30px">— The POS Pro Team</p>
            </div>`,
          }),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          return res.status(500).json({ error: `Failed to send email: ${errText}` });
        }
        return res.status(200).json({ ok: true });
      }

      case "update_store_profile": {
        const { storeId, storeName, ownerName, ownerEmail } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });
        await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            store_name: storeName,
            owner_name: ownerName,
            owner_email: ownerEmail,
          }),
        });
        return res.status(200).json({ ok: true });
      }

      case "clear_orders": {
        const { storeId } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });
        await supaJson(`store_data?store_id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            orders: [], shifts: [], active_shift: null,
            updated_at: new Date().toISOString(),
          }),
        });
        return res.status(200).json({ ok: true });
      }

      case "wipe_store": {
        const { storeId } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });
        await supaJson(`store_data?store_id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            products: [], orders: [], shifts: [], accounts: [], categories: [], roles: [],
            theme: {}, sku_settings: {}, order_settings: {}, active_shift: null, logs: [],
            suppliers: [], purchase_orders: [], customers: [], invoices: [],
            business_details: null, enable_po: false, enable_invoice: false,
            updated_at: new Date().toISOString(),
          }),
        });
        return res.status(200).json({ ok: true });
      }

      case "delete_store": {
        const { storeId } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });

        const licenses = await supaJson(`licenses?store_id=eq.${encodeURIComponent(storeId)}`, { method: "GET" });
        for (const lic of licenses) {
          await supaJson(`licenses?id=eq.${encodeURIComponent(lic.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "unused", store_id: null, activated_at: null }),
          });
        }

        await supaJson(`store_data?store_id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            products: [], orders: [], shifts: [], accounts: [], categories: [], roles: [],
            theme: {}, sku_settings: {}, order_settings: {}, active_shift: null, logs: [],
            suppliers: [], purchase_orders: [], customers: [], invoices: [],
            business_details: null, enable_po: false, enable_invoice: false,
            updated_at: new Date().toISOString(),
          }),
        });

        const storeRows = await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}&limit=1`, { method: "GET" });
        const storeName = storeRows?.[0]?.store_name || "store";
        await supaJson(`stores?id=eq.${encodeURIComponent(storeId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            devices: [],
            store_name: storeName.startsWith("[DELETED]") ? storeName : `[DELETED] ${storeName}`,
            owner_email: `deleted_${storeId}@deleted.com`,
          }),
        });

        // Also remove any store_access grants pointing at the now-
        // deleted store, so agent dashboards don't show a dead entry.
        await supa(`store_access?store_id=eq.${encodeURIComponent(storeId)}`, { method: "DELETE" });

        return res.status(200).json({ ok: true });
      }

      case "create_dev_token": {
        const { storeId, expiresInMinutes } = payload || {};
        if (!storeId) return res.status(400).json({ error: "Missing storeId" });
        // Agents can only impersonate stores they've been explicitly
        // granted via store_access — being allowed to call this action
        // at all doesn't mean every store is fair game.
        if (!isOwner) {
          const hasAccess = await agentHasStoreAccess(session.email, storeId);
          if (!hasAccess) return res.status(403).json({ error: "You don't have access to this store" });
        }
        const tok = crypto.randomBytes(24).toString("base64url");
        const expiresAt = new Date(Date.now() + (Number(expiresInMinutes) || 2) * 60 * 1000).toISOString();
        const result = await supaJson("dev_tokens", {
          method: "POST",
          body: JSON.stringify([{ token: tok, store_id: storeId, expires_at: expiresAt, used: false }]),
        });
        return res.status(200).json({ ok: true, token: result[0]?.token });
      }

      // ─── Team management (owner-only) ──────────────────────────

      case "list_team": {
        const rows = await supaJson("dev_team?select=email,role,name,created_at,added_by&order=created_at.asc", { method: "GET" });
        return res.status(200).json({ ok: true, team: rows });
      }

      case "add_team_member": {
        const { email: newEmail, name, role } = payload || {};
        const cleanEmail = (newEmail || "").trim().toLowerCase();
        if (!cleanEmail) return res.status(400).json({ error: "Missing email" });
        const cleanRole = role === "owner" ? "owner" : "agent"; // default to agent, never silently grant owner
        const result = await supaJson("dev_team", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([{
            email: cleanEmail,
            name: name?.trim() || null,
            role: cleanRole,
            added_by: session.email,
          }]),
        });
        return res.status(200).json({ ok: true, member: result[0] });
      }

      case "remove_team_member": {
        const { email: targetEmail } = payload || {};
        const cleanEmail = (targetEmail || "").trim().toLowerCase();
        if (!cleanEmail) return res.status(400).json({ error: "Missing email" });
        if (cleanEmail === session.email) {
          return res.status(400).json({ error: "Can't remove yourself" });
        }
        // store_access rows cascade-delete automatically (FK on_delete cascade)
        await supa(`dev_team?email=eq.${encodeURIComponent(cleanEmail)}`, { method: "DELETE" });
        return res.status(200).json({ ok: true });
      }

      case "list_store_access": {
        // Returns the full grant list so the admin UI can render a
        // matrix of agent x store. Small dataset, fine to return whole.
        const rows = await supaJson("store_access?select=id,agent_email,store_id,granted_at,granted_by", { method: "GET" });
        return res.status(200).json({ ok: true, access: rows });
      }

      case "grant_store_access": {
        const { agentEmail, storeId } = payload || {};
        const cleanEmail = (agentEmail || "").trim().toLowerCase();
        if (!cleanEmail || !storeId) return res.status(400).json({ error: "Missing agentEmail or storeId" });
        await supaJson("store_access", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify([{ agent_email: cleanEmail, store_id: storeId, granted_by: session.email }]),
        });
        return res.status(200).json({ ok: true });
      }

      case "revoke_store_access": {
        const { agentEmail, storeId } = payload || {};
        const cleanEmail = (agentEmail || "").trim().toLowerCase();
        if (!cleanEmail || !storeId) return res.status(400).json({ error: "Missing agentEmail or storeId" });
        await supa(
          `store_access?agent_email=eq.${encodeURIComponent(cleanEmail)}&store_id=eq.${encodeURIComponent(storeId)}`,
          { method: "DELETE" }
        );
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    console.error("dev-action error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
