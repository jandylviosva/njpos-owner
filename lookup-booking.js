// Vercel Serverless Function — creates a booking from the public page.
//
// The PWA's own conflict check (attemptSaveBooking, in the staff app) checks
// a staff device's local state, then merges into whatever the cloud row
// currently holds — but never re-checks the conflict against that freshly
// -fetched cloud data before writing, so two people can each pass their own
// stale check and both land a real double-booking. That gap is being left
// alone in the PWA for now (flagged separately), but there's no reason to
// carry it into new code: this endpoint re-fetches immediately before
// writing and uses updated_at as a compare-and-swap guard, so a genuine
// last-second collision is retried against fresh data rather than silently
// let through.
//
// Payment-required services: the booking is created as status "pending" and
// HOLDS the slot immediately (so nobody else can grab it while the customer
// is on the GCash screen), but auto-expires after paymentHoldMinutes (default
// 30, resolved from booking_page_settings, capped at 60) UNLESS a payment
// screenshot has already been submitted for it — see isHeld() below.
//
// Every booking gets a short refCode (e.g. "JS4-K92") at creation, distinct
// from its internal id — this is what a customer types into the standalone
// /bookings/{slug}/pay recovery page if they lose the tab mid-payment, and
// what the immediate confirmation email below references. An email is sent
// right away if the customer gave one — this is the actual fix for "reload
// during payment loses everything": even with no email, the refCode is
// shown on-screen; with one, they also have it in their inbox.

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

async function supa(path, init) {
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  return fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      Prefer: "return=representation",
      ...(init?.headers || {}),
    },
  });
}

// Same helpers as the PWA's Bookings module (BookingsView, App.jsx) —
// duplicated here on purpose since this runs as an isolated serverless
// function, not a shared package. Keep in sync if the PWA's logic changes.
const addMinutes = (time, mins) => {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  const hh = Math.floor((total % 1440) / 60), mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
const minutesBetween = (start, end) => {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff <= 0) diff += 1440;
  return diff;
};

// A booking still holds its slot unless: it's cancelled, OR it's an
// unpaid "pending" booking whose hold window has expired. Once a payment
// screenshot is attached, it holds indefinitely regardless of expiresAt —
// it's now awaiting a human, not an abandoned checkout.
const isHeld = (b) => {
  if (b.status === "cancelled") return false;
  if (b.status === "pending" && !b.paymentScreenshotPath && b.expiresAt && new Date(b.expiresAt).getTime() < Date.now()) return false;
  return true;
};

const hasConflict = (bookings, resourceId, date, time, durationMinutes, excludeId) => {
  if (!resourceId || !time) return false;
  const newEnd = addMinutes(time, durationMinutes || 30);
  return bookings.some(b => {
    if (b.id === excludeId) return false;
    if (!isHeld(b)) return false;
    if (b.resourceId !== resourceId || b.date !== date || !b.time) return false;
    const bEnd = addMinutes(b.time, b.durationMinutes || 30);
    return time < bEnd && b.time < newEnd;
  });
};

// A service billed hourly only makes sense paired with the flexible
// (customer-picks-start-and-end) duration mode — fixed-duration and
// no-duration services always use the flat svc.price.
const computeAmount = (svc, durationMinutes) => {
  if (svc.durationMode === "flexible" && svc.pricingMode === "hourly") {
    return Math.round(((svc.price || 0) * (durationMinutes || 0)) / 60);
  }
  return svc.price || 0;
};

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read back over the phone
function genRefCode(existingCodes) {
  for (let attempt = 0; attempt < 10; attempt++) {
    let raw = "";
    for (let i = 0; i < 6; i++) raw += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
    const code = raw.slice(0, 3) + "-" + raw.slice(3);
    if (!existingCodes.has(code)) return code;
  }
  return Date.now().toString(36).toUpperCase(); // astronomically unlikely to ever be reached
}

async function sendResendEmail(RESEND_KEY, { to, subject, html }) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: "NJ POS <noreply@mail.nj-systems.com>", reply_to: "pos_support@nj-systems.com", to: Array.isArray(to) ? to : [to], subject, html }),
  });
}

const fmtPeso = (n) => `\u20B1${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtHours = (mins) => { const h = Math.round((mins/60)*10)/10; return h % 1 === 0 ? String(h) : h.toFixed(1); };
const pricingBreakdown = (hourlyRate, durationMinutes) => {
  if (!hourlyRate || !durationMinutes) return null;
  return `${fmtPeso(hourlyRate)}/hr \u00D7 ${fmtHours(durationMinutes)} hr${fmtHours(durationMinutes)==="1"?"":"s"}`;
};
const fmtDateLabel = (dateStr) => { try { return new Date(dateStr + "T00:00:00").toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" }); } catch { return dateStr; } };
const fmtTimeLabel = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); const period = h >= 12 ? "PM" : "AM"; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}:${String(m).padStart(2, "0")} ${period}`; };

async function sendCreationEmail({ requiresPayment, booking, storeName, storeAddress, businessPhone, bookingNoun, payUrl }) {
  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY || !booking.customerEmail) return;
  const noun = bookingNoun || "Booking";
  const rows = [
    ["Service", booking.serviceName],
    ["Date", fmtDateLabel(booking.date)],
    ...(booking.time ? [["Time", fmtTimeLabel(booking.time)]] : []),
    ...(booking.resourceName ? [["With", booking.resourceName]] : []),
    [`${noun} Reference`, booking.refCode],
    ...(requiresPayment ? [["Amount Due", fmtPeso(booking.amount) + (pricingBreakdown(booking.hourlyRate, booking.durationMinutes) ? ` (${pricingBreakdown(booking.hourlyRate, booking.durationMinutes)})` : "")]] : []),
  ];
  const subject = requiresPayment
    ? `Pay your ${noun.toLowerCase()} now — ${booking.serviceName} on ${fmtDateLabel(booking.date)}`
    : `Your ${noun.toLowerCase()} is confirmed — ${booking.serviceName} on ${fmtDateLabel(booking.date)}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f9fafb">
    <div style="background:#2563EB;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
      <div style="color:#fff;font-size:20px;font-weight:800">${storeName || `Your ${noun.toLowerCase()}`}</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
      <div style="color:${requiresPayment?"#b45309":"#2563EB"};font-weight:700;font-size:13px;margin-bottom:10px">${requiresPayment?"⏳ Payment Needed":"✓ "+noun+" Confirmed"}</div>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 18px">Hi ${booking.customerFirstName},<br/>${requiresPayment
        ? `Pay now to confirm your ${noun.toLowerCase()} — it's being held for you, but not yet confirmed.`
        : (booking.fulfillmentNote || `We'll see you then!`)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${rows.map(([label,val])=>`<tr><td style="padding:6px 0;color:#6b7280">${label}</td><td style="padding:6px 0;color:#111;text-align:right;font-weight:700">${val}</td></tr>`).join("")}
      </table>
      ${requiresPayment ? `<a href="${payUrl}" style="display:block;text-align:center;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 0;border-radius:8px;margin-top:18px">Pay Now</a>` : ""}
      ${businessPhone ? `<p style="color:#6b7280;font-size:13px;margin:20px 0 0">Need to reschedule or have a question?<br/>Call us: ${businessPhone}</p>` : ""}
    </div>
    <p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:16px">${storeName||""}${storeAddress?` · ${storeAddress}`:""}</p>
  </div>`;
  try { await sendResendEmail(RESEND_KEY, { to: booking.customerEmail, subject, html }); } catch { /* non-fatal */ }
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { slug, serviceId, resourceId, date, time, endTime, customerFirstName, customerLastName, customerPhone, customerEmail, notes } = req.body || {};

  if (!slug) return res.status(400).json({ error: "Missing store" });
  if (!serviceId) return res.status(400).json({ error: "Missing service" });
  if (!date) return res.status(400).json({ error: "Date required" });
  if (!customerFirstName || !String(customerFirstName).trim()) return res.status(400).json({ error: "First name required" });
  if (!customerLastName || !String(customerLastName).trim()) return res.status(400).json({ error: "Last name required" });
  if (!customerPhone || !String(customerPhone).trim()) return res.status(400).json({ error: "Phone number required" });
  if (customerEmail && !/\S+@\S+\.\S+/.test(customerEmail)) return res.status(400).json({ error: "That email doesn't look right" });

  const storeRows = await (await supa(`stores?booking_slug=eq.${encodeURIComponent(String(slug).toLowerCase())}&select=id,store_name`)).json();
  const store = storeRows[0];
  if (!store) return res.status(404).json({ error: "Store not found" });

  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dataRows = await (await supa(
      `store_data?store_id=eq.${encodeURIComponent(store.id)}&select=enable_bookings,booking_services,booking_resources,bookings,booking_page_settings,business_details,updated_at`
    )).json();
    const row = dataRows[0];
    if (!row || !row.enable_bookings) return res.status(404).json({ error: "Bookings are not enabled for this store" });

    const svc = (row.booking_services || []).find(s => s.id === serviceId && s.active !== false);
    if (!svc) return res.status(400).json({ error: "This service is no longer available" });

    if (svc.resourceRequired && !resourceId) return res.status(400).json({ error: "Please select a resource" });
    if (resourceId) {
      const res_ = (row.booking_resources || []).find(r => r.id === resourceId && r.active !== false);
      if (!res_) return res.status(400).json({ error: "This resource is no longer available" });
    }
    if (svc.exclusivity && !time) return res.status(400).json({ error: "A time is required for this service" });
    if (svc.durationMode === "flexible" && time && !endTime) return res.status(400).json({ error: "End time required" });

    const durationMinutes = svc.durationMode === "flexible" && time && endTime
      ? minutesBetween(time, endTime)
      : svc.durationMinutes;
    if (svc.durationMode === "flexible" && time && durationMinutes <= 0) {
      return res.status(400).json({ error: "End time must be after start time" });
    }

    if (svc.exclusivity && resourceId && time) {
      if (hasConflict(row.bookings || [], resourceId, date, time, durationMinutes, null)) {
        // A real conflict — not a race, an actual taken slot. Don't retry,
        // tell the customer so they can pick another time.
        return res.status(409).json({ error: "That slot was just taken. Please pick another time." });
      }
    }

    const requiresPayment = !!svc.requiresPayment;
    const holdMinutes = Math.min(60, Math.max(5, Number(row.booking_page_settings?.paymentHoldMinutes) || 30));
    const existingCodes = new Set((row.bookings || []).map(b => b.refCode).filter(Boolean));

    const toSave = {
      id: "bk" + crypto.randomBytes(6).toString("hex"),
      refCode: genRefCode(existingCodes),
      serviceId, serviceName: svc.name,
      resourceId: resourceId || null,
      resourceName: resourceId ? ((row.booking_resources || []).find(r => r.id === resourceId)?.name || "") : null,
      customerId: null,
      customerName: `${String(customerFirstName).trim()} ${String(customerLastName).trim()}`,
      customerFirstName: String(customerFirstName).trim(),
      customerLastName: String(customerLastName).trim(),
      customerPhone: String(customerPhone).trim(),
      customerEmail: customerEmail ? String(customerEmail).trim() : "",
      date, time: time || "", endTime: endTime || undefined,
      durationMinutes,
      amount: computeAmount(svc, durationMinutes),
      hourlyRate: (svc.durationMode === "flexible" && svc.pricingMode === "hourly") ? svc.price : null,
      fulfillmentNote: svc.fulfillmentNote || "",
      status: requiresPayment ? "pending" : "confirmed",
      expiresAt: requiresPayment ? new Date(Date.now() + holdMinutes * 60000).toISOString() : null,
      notes: notes ? String(notes).trim() : "",
      createdAt: new Date().toISOString(),
      createdBy: "online booking",
      source: "public_booking_page",
    };

    const merged = [toSave, ...(row.bookings || [])];
    const patchRes = await supa(
      `store_data?store_id=eq.${encodeURIComponent(store.id)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`,
      { method: "PATCH", body: JSON.stringify({ bookings: merged, updated_at: new Date().toISOString() }) }
    );
    const patched = patchRes.ok ? await patchRes.json() : [];
    if (patched.length > 0) {
      const origin = req.headers.origin && ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : "https://owner.nj-systems.com";
      sendCreationEmail({
        requiresPayment, booking: toSave, storeName: store.store_name,
        storeAddress: row.business_details?.address || "", businessPhone: row.business_details?.phone || "",
        bookingNoun: row.booking_page_settings?.bookingNoun || "Booking",
        payUrl: `${origin}/bookings/${slug}/pay?ref=${encodeURIComponent(toSave.refCode)}`,
      }).catch(() => {});
      return res.status(200).json({ ok: true, bookingId: toSave.id, refCode: toSave.refCode, requiresPayment, amount: toSave.amount, fulfillmentNote: toSave.fulfillmentNote });
    }
    // updated_at moved under us (someone else wrote in between) — loop and
    // re-check against whatever is there now.
    await new Promise(r => setTimeout(r, 120 + Math.random() * 200));
  }

  return res.status(409).json({ error: "Couldn't confirm this booking due to a conflict. Please try again." });
}
