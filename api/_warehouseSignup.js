// Shared by the NJ Warehouse sign-up endpoints (free trial and buy a code). The leading underscore keeps Vercel
// from exposing this file as a route.
import crypto from "node:crypto";

export const ALLOWED_ORIGINS = [
  "https://owner.nj-systems.com", "https://pos.nj-systems.com", "https://dev.nj-systems.com",
  "https://nj-systems.com", "https://www.nj-systems.com", "https://warehouse.nj-systems.com",
];
export function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/njpos(-portal|-owner|-pwa|-dev|-landing)?(-[a-z0-9]+)?\.vercel\.app$/.test(origin);
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export const OWNER_NOTIFY_EMAIL = ["pos_support@nj-systems.com", "jandylvios@gmail.com"];
export const BASE_PRICE = 199, EXTRA_DEVICE_PRICE = 99, MAX_DEVICES = 20, TRIAL_DAYS = 3;
export const priceFor = (devices) => BASE_PRICE + (Math.max(1, devices) - 1) * EXTRA_DEVICE_PRICE;
export const cleanDevices = (v) => Math.min(MAX_DEVICES, Math.max(1, Math.floor(Number(v)) || 1));
export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const peso = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const dbEnv = () => ({ url: process.env.SUPA_URL || process.env.VITE_SUPA_URL, key: process.env.SUPA_SERVICE_KEY });

export async function supaTable(table, path, init) {
  const { url, key } = dbEnv();
  return fetch(`${url}/rest/v1/${table}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=representation", ...(init?.headers || {}) },
  });
}

export function genCode(prefix = "WH") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

export async function uploadScreenshot(base64DataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(base64DataUrl || "");
  if (!match) throw new Error("Invalid image data");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 6 * 1024 * 1024) throw new Error("The screenshot is too large. Use a smaller image.");
  const ext = (match[1].split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${crypto.randomUUID()}.${ext}`;
  const { url, key } = dbEnv();
  const r = await fetch(`${url}/storage/v1/object/payment-screenshots/${path}`, { method: "POST", headers: { "Content-Type": match[1], Authorization: `Bearer ${key}`, apikey: key }, body: buffer });
  if (!r.ok) throw new Error(`Screenshot upload failed: ${await r.text().catch(() => "")}`);
  return path;
}

export async function sendWarehouseEmail({ to, subject, html }) {
  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: "NJ Warehouse <noreply@mail.nj-systems.com>", reply_to: "pos_support@nj-systems.com", to: Array.isArray(to) ? to : [to], subject, html }),
  });
  return r.ok;
}

// The common frame of the emails: warehouse header, content, NJ Systems footer
export const emailFrame = (body) => `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <div style="background:#0F172A;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
    <img src="https://warehouse.nj-systems.com/email-logo-warehouse.png" alt="NJ Warehouse" width="272" height="55" style="display:block;margin:0 auto;"/>
  </div>
  ${body}
  <p style="color:#9ca3af;font-size:12px;margin-top:30px">— NJ Systems</p>
</div>`;

export function trialEmailHtml({ code, ownerName }) {
  return emailFrame(`
    <h2 style="color:#111">Your NJ Warehouse free trial</h2>
    <p style="color:#374151;font-size:15px;line-height:1.6">Hi${ownerName ? " " + esc(ownerName) : ""}, use this registration code to create your warehouse account. You get <b>${TRIAL_DAYS} days</b> of full access, starting when you register.</p>
    <div style="background:#eff6ff;border:2px dashed #2563eb;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
      <div style="font-size:28px;font-weight:800;letter-spacing:2px;color:#2563EB;font-family:monospace">${esc(code)}</div>
    </div>
    <ol style="color:#374151;font-size:14px;line-height:1.8;padding-left:20px">
      <li>Open <a href="https://warehouse.nj-systems.com" style="color:#2563EB">warehouse.nj-systems.com</a></li>
      <li>Choose <b>Register</b> and enter your details and this code</li>
      <li>The trial includes <b>1 device</b>. Your ${TRIAL_DAYS} days start the moment you register. This code is only for creating your account, once.</li>
    </ol>
    <p style="color:#6b7280;font-size:13px;line-height:1.6">To keep your warehouse after the trial, get a plan from <a href="https://www.nj-systems.com/#warehouse" style="color:#2563EB">nj-systems.com</a> (${peso(BASE_PRICE)}/month with 1 device, ${peso(EXTRA_DEVICE_PRICE)} for each additional device). If you have questions, just reply to this email.</p>`);
}
