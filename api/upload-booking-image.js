// Vercel Serverless Function — uploads an image for a Booking Page content
// block (called from the PWA's page editor, not the public page itself).
// Unlike uploadScreenshot() in submit-bill-payment.js (which writes to the
// private payment-screenshots bucket), this writes to a PUBLIC bucket and
// returns a public URL, since the image needs to render on an unauthenticated
// public page.

const ALLOWED_ORIGINS = [
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
    /^https:\/\/pospro(-portal|-pwa)?(-[a-z0-9]+)?\.vercel\.app$/.test(origin);
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const MAX_BYTES = 4 * 1024 * 1024; // 4MB — a page-content image, not a full-res photo

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { storeId, imageBase64 } = req.body || {};
  if (!storeId) return res.status(400).json({ error: "Missing store" });

  const match = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/.exec(imageBase64 || "");
  if (!match) return res.status(400).json({ error: "Please upload a PNG, JPG, WEBP, or GIF" });
  const contentType = match[1];
  const buffer = Buffer.from(match[3], "base64");
  if (buffer.length > MAX_BYTES) return res.status(400).json({ error: "Image is too large (max 4MB)" });

  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  const ext = (contentType.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${storeId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const uploadRes = await fetch(`${SUPA_URL}/storage/v1/object/booking-page-images/${path}`, {
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
    return res.status(500).json({ error: `Upload failed: ${t}` });
  }

  return res.status(200).json({ ok: true, url: `${SUPA_URL}/storage/v1/object/public/booking-page-images/${path}` });
}
