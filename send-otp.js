// Vercel Serverless Function — handles a submission from the public
// /payment page: uploads the payment screenshot to Supabase Storage,
// creates a pending payment_records row, and emails the owner a
// notification. Uses the Supabase SERVICE key throughout, same as
// send-otp.js and start-trial.js in this same repo — the browser never
// touches Supabase directly for any of this.

import crypto from "node:crypto";

const ALLOWED_ORIGINS = [
  "https://owner.nj-systems.com",
  "https://pos.nj-systems.com",
  "https://dev.nj-systems.com",
  "https://nj-systems.com",
  "https://www.nj-systems.com",
  "https://pospro-portal.vercel.app",
  "https://www.pospro-portal.com",
  "https://pospro-portal.com",
  "https://client.pospro-portal.com",
  "https://pwa.pospro-portal.com",
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/(pospro|njpos)(-portal|-owner|-pwa|-dev|-landing)?(-[a-z0-9]+)?\.vercel\.app$/.test(origin);
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function supaTable(table, path, init) {
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      Prefer: "return=representation",
      ...(init?.headers || {}),
    },
  });
  return r;
}

// Same private-bucket, path-only-stored pattern used by the Dev
// Console's manual payment entries — no signed URL is generated or
// stored here at all; one gets created fresh, on demand, only when
// someone actually views the screenshot later (see the Dev Console's
// get_screenshot_url action). Storing just the bare path means nothing
// here can ever go stale or be built with a wrong prefix.
async function uploadScreenshot(base64DataUrl) {
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
  return path;
}

async function sendResendEmail(RESEND_KEY, { to, subject, html }) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: "NJ POS <noreply@mail.nj-systems.com>", reply_to: "pos_support@nj-systems.com", to: Array.isArray(to) ? to : [to], subject, html }),
  });
}

// New payment submissions notify both addresses.
const OWNER_NOTIFY_EMAIL = ["pos_support@nj-systems.com", "jandylvios@gmail.com"];

const fmtPeso = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { customerName, customerEmail, storeName, plan, breakdown, amount, screenshotBase64 } = req.body || {};

  if (!customerName || !customerEmail || !storeName) {
    return res.status(400).json({ error: "Missing name, email, or store name" });
  }
  if (!/\S+@\S+\.\S+/.test(customerEmail)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if (!screenshotBase64) {
    return res.status(400).json({ error: "Missing payment screenshot" });
  }

  let screenshotPath;
  try {
    screenshotPath = await uploadScreenshot(screenshotBase64);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed to upload screenshot" });
  }

  const notesLines = (breakdown || []).map(i => `${i.label}: ${fmtPeso(i.amount)}`).join("\n");

  const createRes = await supaTable("payment_records", "", {
    method: "POST",
    body: JSON.stringify([{
      source: "landing_page",
      customer_name: customerName,
      customer_email: customerEmail,
      store_name: storeName,
      amount: Number(amount) || 0,
      plan: plan === "lifetime" ? "lifetime" : "standard_monthly",
      method: "GCash",
      notes: notesLines || null,
      screenshot_url: screenshotPath,
      status: "pending",
    }]),
  });

  if (!createRes.ok) {
    const t = await createRes.text().catch(() => "");
    return res.status(500).json({ error: `Failed to record payment: ${t}` });
  }

  // Best-effort notification — a failure here shouldn't fail the whole
  // submission, since the payment record itself is already safely saved
  // and reviewable from the Dev Console either way.
  const RESEND_KEY = process.env.RESEND_KEY;
  if (RESEND_KEY) {
    try {
      await sendResendEmail(RESEND_KEY, {
        to: OWNER_NOTIFY_EMAIL,
        subject: `New payment submission — ${storeName} (${fmtPeso(amount)})`,
        // Table-based layout for the breakdown, not flexbox — most email
        // clients (Outlook especially, but plenty of others too) either
        // ignore or badly mis-render CSS flexbox in HTML email, which is
        // exactly why the amounts showed up with no spacing/alignment at
        // all instead of neatly right-aligned. Tables are the old-school
        // but genuinely reliable way to lay out HTML email.
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f9fafb">
          <div style="background:#2563EB;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
            <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.02em">NJ POS</div>
          </div>
          <div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
            <h2 style="color:#111;margin:0 0 12px;font-size:19px">New payment submission</h2>
            <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 20px">
              <b>${customerName}</b> (<a href="mailto:${customerEmail}" style="color:#2563EB;text-decoration:none">${customerEmail}</a>) submitted a payment for <b>${storeName}</b>.
            </p>
            <div style="background:#f5f3ff;border:1px solid #e0e7ff;border-radius:10px;padding:18px">
              <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px">Breakdown</div>
              <table style="width:100%;border-collapse:collapse">
                ${(breakdown || []).map(i => `<tr><td style="padding:5px 0;font-size:14px;color:#374151">${i.label}</td><td style="padding:5px 0;font-size:14px;color:#374151;text-align:right;white-space:nowrap">${fmtPeso(i.amount)}</td></tr>`).join("")}
                <tr><td colspan="2" style="border-top:1px solid #ddd6fe;padding-top:10px;line-height:1px">&nbsp;</td></tr>
                <tr><td style="font-weight:800;font-size:16px;color:#111">Total</td><td style="font-weight:800;font-size:16px;color:#2563EB;text-align:right;white-space:nowrap">${fmtPeso(amount)}</td></tr>
              </table>
            </div>
            <p style="color:#6b7280;font-size:13px;margin:20px 0 0">Review and confirm this in the Dev Console → Payments.</p>
          </div>
          <p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:20px">This is an automatic notification from your NJ POS payment page.</p>
        </div>`,
      });
    } catch { /* notification failure is non-fatal */ }
  }

  return res.status(200).json({ ok: true });
}
