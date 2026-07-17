// Vercel Serverless Function — backs the standalone /bookings/{slug}/pay
// recovery page. Requires BOTH the refCode and the phone number used at
// booking time — a refCode alone is short enough that a determined guesser
// could eventually hit a real one, and this returns booking details (name,
// service, amount), so a second factor the customer actually knows is
// worth the extra field.

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

async function supaGet(table, query) {
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d[0] || null;
}

const normalizePhone = (p) => String(p || "").replace(/\D/g, "");

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { slug, refCode, phone } = req.body || {};
  if (!slug) return res.status(400).json({ error: "Missing store" });
  if (!refCode || !phone) return res.status(400).json({ error: "Enter your reference code and phone number" });

  const store = await supaGet("stores", `booking_slug=eq.${encodeURIComponent(String(slug).toLowerCase())}&select=id,store_name`);
  if (!store) return res.status(404).json({ error: "Store not found" });

  const data = await supaGet("store_data", `store_id=eq.${encodeURIComponent(store.id)}&select=bookings,booking_page_settings,enable_bookings`);
  if (!data || !data.enable_bookings) return res.status(404).json({ error: "Store not found" });

  const normalizedInput = normalizePhone(phone);
  const wantCode = String(refCode).trim().toUpperCase();
  const booking = (data.bookings || []).find(b => b.refCode === wantCode && normalizePhone(b.customerPhone) === normalizedInput);
  if (!booking) return res.status(404).json({ error: "No booking found with that reference and phone number" });

  return res.status(200).json({
    ok: true,
    bookingId: booking.id,
    refCode: booking.refCode,
    status: booking.status,
    serviceName: booking.serviceName,
    resourceName: booking.resourceName,
    date: booking.date,
    time: booking.time,
    amount: booking.amount,
    hourlyRate: booking.hourlyRate || null,
    durationMinutes: booking.durationMinutes || null,
    paymentSubmitted: !!booking.paymentScreenshotPath,
    bookingNoun: (data.booking_page_settings && data.booking_page_settings.bookingNoun) || "Booking",
    storeName: store.store_name,
    gcash: {
      name: (data.booking_page_settings && data.booking_page_settings.gcashName) || "",
      number: (data.booking_page_settings && data.booking_page_settings.gcashNumber) || "",
      qrUrl: (data.booking_page_settings && data.booking_page_settings.gcashQrUrl) || "",
    },
  });
}
