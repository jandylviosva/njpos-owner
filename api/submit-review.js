// Vercel Serverless Function — receives a customer testimonial
// submission from the landing page's /leave-a-review form. Every
// submission lands as "pending" — nothing here ever touches the public
// landing page directly; review/approval happens in the Dev Console,
// and adding an approved one to the actual testimonials carousel is
// still a deliberate manual step after that (not automatic), so a spam
// or low-quality submission can never end up live on its own.

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

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // generous headroom even after client-side compression

async function uploadReviewImage(imageBase64, idx) {
  const match = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/.exec(imageBase64 || "");
  if (!match) throw new Error(`Image ${idx + 1}: unsupported format (use PNG, JPG, WEBP, or GIF)`);
  const contentType = match[1];
  const buffer = Buffer.from(match[3], "base64");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image ${idx + 1} is too large`);

  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  const ext = (contentType.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${idx}.${ext}`;

  const uploadRes = await fetch(`${SUPA_URL}/storage/v1/object/review-images/${path}`, {
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
    throw new Error(`Image ${idx + 1} upload failed: ${t}`);
  }
  return `${SUPA_URL}/storage/v1/object/public/review-images/${path}`;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, businessType, city, rating, reviewText, email, images, hp } = req.body || {};

  // Honeypot — a hidden field real users never see or fill in, but a
  // simple bot filling every field in a form often does. Silently
  // "succeed" without actually inserting anything, so a bot has no
  // signal that it was caught and no reason to adapt.
  if (hp) return res.status(200).json({ ok: true });

  if (!name || !name.trim()) return res.status(400).json({ ok: false, error: "Name is required" });
  if (!reviewText || !reviewText.trim()) return res.status(400).json({ ok: false, error: "Review text is required" });
  if (reviewText.trim().length > 2000) return res.status(400).json({ ok: false, error: "Review is too long" });
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ ok: false, error: "Rating must be between 1 and 5" });
  }
  if (email && !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ ok: false, error: "Invalid email address" });
  const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
  if (imageList.length > MAX_IMAGES) return res.status(400).json({ ok: false, error: `Please upload at most ${MAX_IMAGES} images` });

  let imageUrls = [];
  if (imageList.length) {
    try {
      // Sequential, not Promise.all — keeps this comfortably within a
      // serverless function's own execution time limit rather than
      // firing 5 uploads at once, and a failure partway through gives a
      // clear "which image" error instead of an ambiguous batch failure.
      for (let i = 0; i < imageList.length; i++) {
        imageUrls.push(await uploadReviewImage(imageList[i], i));
      }
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || "Failed to upload images" });
    }
  }

  try {
    const insertRes = await supaTable("testimonials", "", {
      method: "POST",
      body: JSON.stringify([{
        name: name.trim(),
        business_type: (businessType || "").trim() || null,
        city: (city || "").trim() || null,
        rating: numRating,
        review_text: reviewText.trim(),
        email: email ? email.trim().toLowerCase() : null,
        images: imageUrls,
        status: "pending",
      }]),
    });
    if (!insertRes.ok) {
      const t = await insertRes.text().catch(() => "");
      return res.status(500).json({ ok: false, error: `Failed to save review: ${t}` });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Something went wrong" });
  }
}
