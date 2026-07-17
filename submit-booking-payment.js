// Vercel Serverless Function — runs on the server, not the browser
// This is what actually calls Resend so the API key is never exposed.
//
// SECURITY NOTE (2026-07-04): OTP generation, storage, and verification
// used to happen in the browser — the client would PATCH the OTP straight
// into Supabase's `stores` table using the anon key (with
// `Prefer: return=representation`), then GET the row back to compare it
// locally. Because that PATCH/GET traffic goes straight to the browser,
// the plaintext OTP was visible in DevTools → Network on every request,
// completely defeating the point of a one-time code. OTP handling now
// lives entirely here, using the Supabase SERVICE key (never sent to the
// browser). The client only ever sees {ok:true} / {ok:false} — never the
// code itself. See action === "send-otp" / "verify-otp" below.

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
  // Allow any vercel.app subdomain for your projects, or exact matches
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/(pospro|njpos)(-portal|-owner|-pwa|-dev|-landing)?(-[a-z0-9]+)?\.vercel\.app$/.test(origin);

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Talks to the `stores` table with the SERVICE key — never the anon key —
// so OTP columns are never reachable/readable from the browser.
async function supaStores(path, init) {
  const SUPA_URL = process.env.SUPA_URL || process.env.VITE_SUPA_URL;
  const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_SERVICE_KEY) return null;
  return fetch(`${SUPA_URL}/rest/v1/stores${path}`, {
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

async function sendResendEmail(RESEND_KEY, { to, subject, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: "NJ POS <noreply@mail.nj-systems.com>", reply_to: "pos_support@nj-systems.com", to: [to], subject, html }),
  });
  return r;
}

export default async function handler(req, res) {
  // Handle CORS preflight
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, email, storeName, purpose, reportTitle, reportHtml } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  const RESEND_KEY = process.env.RESEND_KEY;

  // Handle report email separately — no OTP needed
  if (purpose === "report") {
    if (!RESEND_KEY) return res.status(500).json({ error: "Resend not configured" });
    if (!reportHtml) return res.status(400).json({ error: "Missing report content" });
    try {
      const r = await sendResendEmail(RESEND_KEY, {
        to: email,
        subject: `NJ POS Report: ${reportTitle||"Report"}${storeName ? " — " + storeName : ""}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:24px">
          <div style="background:#2563EB;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
            <div style="color:#fff;font-size:20px;font-weight:800">NJ POS</div>
            <div style="color:rgba(255,255,255,0.6);font-size:12px">${storeName||"Store Report"}</div>
          </div>
          <h2 style="font-size:16px;color:#111;margin-bottom:16px">${reportTitle||"Report"}</h2>
          ${reportHtml}
          <p style="color:#9ca3af;font-size:11px;margin-top:24px">This report was generated from NJ POS and sent to your registered email.</p>
          <div style="margin-top:12px;padding:10px 14px;background:#f5f3ff;border-radius:8px;font-size:11px;color:#5b21b6">
            💡 <b>To save as PDF:</b> Open the POS app → Reports → View Report → Save as PDF
          </div>
        </div>`,
      });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: "Failed to send report", detail: data });
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: "Server error" });
    }
  }

  // ── TRIAL EXPIRED EMAIL ──
  if (purpose === "trial_expired") {
    if (!RESEND_KEY) return res.status(500).json({ error: "Resend not configured" });
    try {
      const r = await sendResendEmail(RESEND_KEY, {
        to: email,
        subject: "Your NJ POS Trial Has Expired",
        html: `
          <div style="font-family:sans-serif;max-width:460px;margin:0 auto;padding:24px">
            <div style="background:#2563EB;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
              <div style="color:#fff;font-size:20px;font-weight:800">NJ POS</div>
              <div style="color:rgba(255,255,255,0.6);font-size:12px">${storeName||"Your Store"}</div>
            </div>
            <h2 style="font-size:16px;color:#111;margin-bottom:8px">Your free trial has ended ⏰</h2>
            <p style="color:#6b7280;font-size:13px;margin-bottom:18px;line-height:1.6">
              Your 3-day free trial for <b>${storeName||"your store"}</b> has expired.
              Your store data is fully preserved — you just need an activation code to continue.
            </p>
            <div style="background:#f5f3ff;border:2px solid #c4b5fd;border-radius:12px;padding:16px;margin-bottom:16px">
              <div style="font-weight:800;font-size:14px;color:#5b21b6;margin-bottom:8px">To continue using NJ POS:</div>
              <ol style="color:#6b7280;font-size:13px;padding-left:16px;margin:0;line-height:1.8">
                <li>Contact your NJ POS provider</li>
                <li>Purchase a permanent activation code</li>
                <li>Enter the code on the POS app to unlock your store</li>
              </ol>
            </div>
            <p style="color:#9ca3af;font-size:11px;margin-top:20px">
              All your products, orders, and data are still safely stored and will be restored once you activate with a permanent code.
            </p>
          </div>
        `,
      });
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
    } catch(e) {
      return res.status(500).json({ error: "Server error" });
    }
  }

  // ── SEND OTP (sign-in / reset / device) — fully server-side ──
  // Generates the code, writes it to Supabase with the service key, and
  // emails it. The code never appears anywhere in the response.
  if (action === "send-otp") {
    const cleanEmail = email.trim().toLowerCase();

    const getRes = await supaStores(`?owner_email=eq.${encodeURIComponent(cleanEmail)}&limit=1`, { method: "GET" });
    if (!getRes) return res.status(500).json({ error: "Server not configured" });
    const rows = await getRes.json().catch(() => []);
    const store = rows?.[0];
    // Same response whether or not the email exists, so this endpoint
    // can't be used to enumerate registered store owner emails.
    if (!store) return res.status(200).json({ ok: true });

    if (!RESEND_KEY) return res.status(500).json({ error: "Resend not configured" });

    const otp = String(crypto.randomInt(100000, 1000000));
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const upd = await supaStores(`?owner_email=eq.${encodeURIComponent(cleanEmail)}`, {
      method: "PATCH",
      body: JSON.stringify({ otp_code: otp, otp_expiry: expiry }),
    });
    if (!upd.ok) {
      console.error("stores OTP update failed:", await upd.text());
      return res.status(500).json({ error: "Server error" });
    }

    const subjects = {
      "sign-in": "Your NJ POS sign-in code",
      "reset":   "Reset your NJ POS portal password",
      "device":  "NJ POS device verification code",
    };
    const subject = subjects[purpose] || subjects["sign-in"];

    try {
      const r = await sendResendEmail(RESEND_KEY, {
        to: email,
        subject,
        html: `
          <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">
            <div style="background:#2563EB;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
              <div style="color:#fff;font-size:20px;font-weight:800">NJ POS</div>
              <div style="color:rgba(255,255,255,0.6);font-size:12px">${storeName || store.store_name || "Owner Portal"}</div>
            </div>
            <h2 style="font-size:16px;color:#111;margin-bottom:6px">${subject}</h2>
            <p style="color:#6b7280;font-size:13px;margin-bottom:18px">
              Use this code to continue. It expires in <b>10 minutes</b>.
            </p>
            <div style="background:#f5f3ff;border:2px solid #2563EB;border-radius:12px;padding:18px;text-align:center;margin-bottom:18px">
              <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#2563EB">${otp}</div>
            </div>
            <p style="color:#9ca3af;font-size:11px">
              If you didn't request this code, you can safely ignore this email.
            </p>
          </div>
        `,
      });
      const data = await r.json();
      if (!r.ok) {
        console.error("Resend error:", data);
        return res.status(500).json({ error: "Failed to send email", detail: data });
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("Send error:", e);
      return res.status(500).json({ error: "Server error" });
    }
  }

  // ── VERIFY OTP — fully server-side ──
  // Compares against the code stored in Supabase (service key only) and
  // burns it immediately on success so it can't be replayed.
  if (action === "verify-otp") {
    const { otp } = req.body || {};
    const cleanEmail = email.trim().toLowerCase();
    if (!otp) return res.status(401).json({ error: "Invalid code" });

    const getRes = await supaStores(`?owner_email=eq.${encodeURIComponent(cleanEmail)}&limit=1`, { method: "GET" });
    if (!getRes) return res.status(500).json({ error: "Server not configured" });
    const rows = await getRes.json().catch(() => []);
    const store = rows?.[0];

    if (!store || !store.otp_code || store.otp_code !== otp) {
      return res.status(401).json({ error: "Invalid code" });
    }
    if (!store.otp_expiry || new Date(store.otp_expiry) < new Date()) {
      return res.status(401).json({ error: "Code expired" });
    }

    await supaStores(`?owner_email=eq.${encodeURIComponent(cleanEmail)}`, {
      method: "PATCH",
      body: JSON.stringify({ otp_code: null, otp_expiry: null }),
    });

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action" });
}
