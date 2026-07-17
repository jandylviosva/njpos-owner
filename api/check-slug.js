// Vercel Serverless Function — live uniqueness check for a store's public
// booking-page slug. Called from the PWA's Bookings settings while an owner
// types a slug. Also doubles as the format validator so the PWA and any
// future caller can't drift out of sync on what counts as a valid slug.

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

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Same normalization the PWA field should apply as the person types, kept
// here too so a client that skips normalization still gets a correct answer.
function normalizeSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const RESERVED = new Set(["api", "bookings", "payment", "bill-payment", "admin", "www", "app"]);

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const slug = normalizeSlug(req.query.slug);
  const excludeStoreId = req.query.storeId ? String(req.query.storeId) : null;

  if (slug.length < 3 || slug.length > 50 || !SLUG_RE.test(slug)) {
    return res.status(200).json({ ok: true, available: false, slug, reason: "invalid_format" });
  }
  if (RESERVED.has(slug)) {
    return res.status(200).json({ ok: true, available: false, slug, reason: "reserved" });
  }

  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  const r = await fetch(
    `${SUPA_URL}/rest/v1/stores?booking_slug=eq.${encodeURIComponent(slug)}&select=id`,
    { headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}` } }
  );
  if (!r.ok) return res.status(500).json({ error: "Lookup failed" });
  const rows = await r.json();
  const takenByOther = rows.some(row => row.id !== excludeStoreId);

  return res.status(200).json({ ok: true, available: !takenByOther, slug });
}
