// Vercel Serverless Function — the public /bookings/{slug} payment step
// submits here after the customer uploads their GCash screenshot. This is
// NOT the same money flow as submit-bill-payment.js (that's a store owner
// paying NJ POS's own subscription fee, to NJ POS's own GCash). This is a
// customer paying the STORE, to the STORE's own GCash — so it never touches
// payment_records or the Dev Console at all. The proof just gets attached to
// the booking itself in store_data.bookings, and the STORE OWNER (not POS
// Pro's team) gets notified to review it in their own PWA.

const ALLOWED_ORIGINS = [
  "https://owner.nj-systems.com",
  "https://pos.nj-systems.com",
  "https://dev.nj-systems.com",
  "https://nj-systems.com",
  "https://www.nj-systems.com",
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/njpos(-portal|-owner|-pwa|-dev|-landing)?(-[a-z0-9]+)?\.vercel\.app$/.test(origin);
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

async function uploadScreenshot(base64DataUrl, bookingId) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(base64DataUrl || "");
  if (!match) throw new Error("Invalid image data");
  const contentType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  const ext = (contentType.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${bookingId}.${ext}`;
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

  const uploadRes = await fetch(`${SUPA_URL}/storage/v1/object/booking-payment-screenshots/${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType, Authorization: `Bearer ${SUPA_SERVICE_KEY}`, apikey: SUPA_SERVICE_KEY },
    body: buffer,
  });
  if (!uploadRes.ok) {
    const t = await uploadRes.text().catch(() => "");
    throw new Error(`Screenshot upload failed: ${t}`);
  }
  return path; // bare storage path — kept private, signed on demand (see sign-booking-screenshot.js)
}

async function sendResendEmail(RESEND_KEY, { to, subject, html }) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: "NJ POS <noreply@mail.nj-systems.com>", reply_to: "pos_support@nj-systems.com", to: Array.isArray(to) ? to : [to], subject, html }),
  });
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { slug, bookingId, screenshotBase64 } = req.body || {};
  if (!slug) return res.status(400).json({ error: "Missing store" });
  if (!bookingId) return res.status(400).json({ error: "Missing booking" });
  if (!screenshotBase64) return res.status(400).json({ error: "Missing payment screenshot" });

  const storeRows = await (await supa(`stores?booking_slug=eq.${encodeURIComponent(String(slug).toLowerCase())}&select=id,store_name,owner_email`)).json();
  const store = storeRows[0];
  if (!store) return res.status(404).json({ error: "Store not found" });

  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dataRows = await (await supa(`store_data?store_id=eq.${encodeURIComponent(store.id)}&select=bookings,updated_at`)).json();
    const row = dataRows[0];
    if (!row) return res.status(404).json({ error: "Store not found" });

    const booking = (row.bookings || []).find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "pending") return res.status(400).json({ error: "This booking is no longer awaiting payment" });

    let screenshotPath;
    try {
      screenshotPath = await uploadScreenshot(screenshotBase64, bookingId);
    } catch (e) {
      return res.status(500).json({ error: e.message || "Upload failed" });
    }

    const updatedBooking = { ...booking, paymentScreenshotPath: screenshotPath, paymentSubmittedAt: new Date().toISOString() };
    const merged = (row.bookings || []).map(b => b.id === bookingId ? updatedBooking : b);
    const patchRes = await supa(
      `store_data?store_id=eq.${encodeURIComponent(store.id)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`,
      { method: "PATCH", body: JSON.stringify({ bookings: merged, updated_at: new Date().toISOString() }) }
    );
    const patched = patchRes.ok ? await patchRes.json() : [];
    if (patched.length > 0) {
      const RESEND_KEY = process.env.RESEND_KEY;
      if (RESEND_KEY && store.owner_email) {
        try {
          await sendResendEmail(RESEND_KEY, {
            to: store.owner_email,
            subject: `Payment submitted — ${booking.serviceName} for ${booking.customerName}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
              <p style="font-size:14px;color:#374151">A customer submitted a GCash payment for a booking on your online booking page. Open the Bookings tab in your NJ POS app to review the screenshot and confirm.</p>
              <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;padding:16px;font-size:13px;color:#374151">
                <div><b>${booking.serviceName}</b></div>
                <div>${booking.date}${booking.time?` at ${booking.time}`:""}</div>
                <div>Customer: ${booking.customerName} — ${booking.customerPhone}</div>
              </div>
            </div>`,
          });
        } catch { /* notification failure is non-fatal */ }
      }
      return res.status(200).json({ ok: true });
    }
    await new Promise(r => setTimeout(r, 120 + Math.random() * 200));
  }

  return res.status(409).json({ error: "Couldn't save your payment right now. Please try again." });
}
