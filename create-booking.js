// Vercel Serverless Function — called from the PWA when staff open a
// pending booking's payment screenshot. The screenshot lives in a PRIVATE
// bucket (unlike booking-page-images), so it's never given out as a bare
// URL — only ever a signed, short-lived one, generated on demand. Same
// pattern your Dev Console already uses for the payment-screenshots bucket
// (signScreenshotPath / get_screenshot_url in dev-action.js).

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

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { storeId, path } = req.body || {};
  if (!storeId) return res.status(400).json({ error: "Missing store" });
  if (!path) return res.status(400).json({ error: "Missing path" });
  // Booking payment screenshots are stored as "{bookingId}.{ext}" — this
  // doesn't cryptographically prove the caller owns storeId (there's no
  // staff auth token available to check against here, matching the trust
  // model the rest of this add-on already runs on), but it does stop a
  // path from outside the expected shape from being signed.
  if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/.test(path)) return res.status(400).json({ error: "Invalid path" });

  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

  const signRes = await fetch(`${SUPA_URL}/storage/v1/object/sign/booking-payment-screenshots/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPA_SERVICE_KEY}`, apikey: SUPA_SERVICE_KEY },
    body: JSON.stringify({ expiresIn: 600 }), // 10 minutes — long enough to view, short enough not to leak a durable link
  });
  if (!signRes.ok) {
    const t = await signRes.text().catch(() => "");
    return res.status(500).json({ error: `Failed to sign URL: ${t}` });
  }
  const signData = await signRes.json();
  return res.status(200).json({ ok: true, url: `${SUPA_URL}/storage/v1${signData.signedURL}` });
}
