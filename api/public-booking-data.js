// Vercel Serverless Function — the ONLY read path the public /bookings/{slug}
// page uses. Deliberately narrow: resolves a slug to a store, then returns
// just the booking config (resources/services) and a stripped-down view of
// existing bookings (no customer name/phone/notes — just enough to compute
// which slots are taken). This must never grow into a general store_data
// passthrough; if a future feature needs another field, add it explicitly
// here rather than widening the select.

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function supaGet(table, query) {
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
    },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d[0] || null;
}

const DEFAULT_HOURS = { mon:{start:"09:00",end:"17:00"}, tue:{start:"09:00",end:"17:00"}, wed:{start:"09:00",end:"17:00"}, thu:{start:"09:00",end:"17:00"}, fri:{start:"09:00",end:"17:00"}, sat:null, sun:null };

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const slug = String(req.query.slug || "").trim().toLowerCase();
  if (!slug) return res.status(400).json({ error: "Missing slug" });

  const store = await supaGet("stores", `booking_slug=eq.${encodeURIComponent(slug)}&select=id,store_name`);
  if (!store) return res.status(404).json({ error: "not_found" });

  const data = await supaGet(
    "store_data",
    `store_id=eq.${encodeURIComponent(store.id)}&select=enable_bookings,booking_resources,booking_services,bookings,order_settings,booking_page_content,booking_page_settings,theme,business_details`
  );
  if (!data || !data.enable_bookings) return res.status(404).json({ error: "not_found" });

  const today = new Date();
  today.setDate(today.getDate() - 1); // include "today" regardless of timezone drift
  const cutoffKey = today.toISOString().slice(0, 10);

  // Strip every field except what's needed to compute slot availability.
  // Never forward customerName/customerPhone/notes for other people's bookings.
  // An expired, never-paid "pending" hold no longer blocks a slot — same
  // isHeld() rule as create-booking.js, duplicated for the same reason
  // (isolated serverless function, no shared package).
  const isHeld = (b) => {
    if (b.status === "cancelled") return false;
    if (b.status === "pending" && !b.paymentScreenshotPath && b.expiresAt && new Date(b.expiresAt).getTime() < Date.now()) return false;
    return true;
  };
  const safeBookings = (data.bookings || [])
    .filter(b => isHeld(b) && b.date >= cutoffKey)
    .map(b => ({ id: b.id, resourceId: b.resourceId || null, date: b.date, time: b.time || null, durationMinutes: b.durationMinutes || null }));

  return res.status(200).json({
    ok: true,
    storeId: store.id,
    storeName: store.store_name,
    resources: (data.booking_resources || []).filter(r => r.active !== false),
    services: (data.booking_services || []).filter(s => s.active !== false),
    bookings: safeBookings,
    defaultHours: (data.order_settings && data.order_settings.bookingDefaultHours) || DEFAULT_HOURS,
    pageContent: Array.isArray(data.booking_page_content) ? data.booking_page_content : [],
    tagline: (data.booking_page_settings && data.booking_page_settings.tagline) || "Book an appointment",
    logoUrl: (data.business_details?.useStoreLogo !== false) ? ((data.theme && data.theme.logoUrl) || (data.business_details && data.business_details.logoUrl) || "") : "",
    storePhone: (data.business_details && data.business_details.phone) || "",
    gcash: {
      name: (data.booking_page_settings && data.booking_page_settings.gcashName) || "",
      number: (data.booking_page_settings && data.booking_page_settings.gcashNumber) || "",
      qrUrl: (data.booking_page_settings && data.booking_page_settings.gcashQrUrl) || "",
    },
    bookingNoun: (data.booking_page_settings && data.booking_page_settings.bookingNoun) || "Booking",
  });
}
