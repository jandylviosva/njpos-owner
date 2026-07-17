// Vercel Serverless Function — handles a submission from the public
// /bill-payment page: uploads the screenshot to Supabase Storage,
// creates a pending payment_records row LINKED to the existing store
// (store_id set), and emails the owner a notification. This is the
// "existing customer paying their known monthly bill" counterpart to
// submit-payment.js, which is for brand-new customers with no store yet.

import crypto from "node:crypto";

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

const OWNER_NOTIFY_EMAIL = ["pos_support@nj-systems.com", "jandylvios@gmail.com"];

const fmtPeso = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { storeId, storeName, customerEmail, amount, breakdown, screenshotBase64 } = req.body || {};

  if (!storeId) return res.status(400).json({ error: "Missing store" });
  if (!customerEmail || !/\S+@\S+\.\S+/.test(customerEmail)) {
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
      source: "bill_payment",
      store_id: storeId,
      customer_email: customerEmail,
      store_name: storeName || null,
      amount: Number(amount) || 0,
      plan: "standard_monthly",
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

  const RESEND_KEY = process.env.RESEND_KEY;
  if (RESEND_KEY) {
    try {
      await sendResendEmail(RESEND_KEY, {
        to: OWNER_NOTIFY_EMAIL,
        subject: `Bill payment received — ${storeName || "a store"} (${fmtPeso(amount)})`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f9fafb">
          <div style="background:#2563EB;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
            <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.02em">NJ POS</div>
          </div>
          <div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
            <h2 style="color:#111;margin:0 0 12px;font-size:19px">Bill payment received</h2>
            <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 20px">
              <b>${storeName || "A store"}</b> submitted their monthly bill payment. Paid by: <a href="mailto:${customerEmail}" style="color:#2563EB;text-decoration:none">${customerEmail}</a>.
            </p>
            <div style="background:#f5f3ff;border:1px solid #e0e7ff;border-radius:10px;padding:18px">
              <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px">Breakdown</div>
              <table style="width:100%;border-collapse:collapse">
                ${(breakdown || []).map(i => `<tr><td style="padding:5px 0;font-size:14px;color:#374151">${i.label}</td><td style="padding:5px 0;font-size:14px;color:#374151;text-align:right;white-space:nowrap">${fmtPeso(i.amount)}</td></tr>`).join("")}
                <tr><td colspan="2" style="border-top:1px solid #ddd6fe;padding-top:10px;line-height:1px">&nbsp;</td></tr>
                <tr><td style="font-weight:800;font-size:16px;color:#111">Total</td><td style="font-weight:800;font-size:16px;color:#2563EB;text-align:right;white-space:nowrap">${fmtPeso(amount)}</td></tr>
              </table>
            </div>
            <p style="color:#6b7280;font-size:13px;margin:20px 0 0">Review and confirm this in the Dev Console → Payments — confirming it will automatically advance this store's next due date.</p>
          </div>
          <p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:20px">This is an automatic notification from your NJ POS bill payment page.</p>
        </div>`,
      });
    } catch { /* notification failure is non-fatal */ }
  }

  return res.status(200).json({ ok: true });
}
