// Vercel Serverless Function — runs on the server, not the browser
// This is what actually calls Resend so the API key is never exposed

const ALLOWED_ORIGINS = [
  "https://pospro-portal.vercel.app",
  "https://pospro-portal-izm3duem8-jandyls-projects.vercel.app",
  "https://www.pospro-portal.com",
  "https://pospro-portal.com",
  "https://pospro-pwa.vercel.app",
  "https://pwa.pospro-portal.com",
  "https://client.pospro-portal.com",
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  // Allow any vercel.app subdomain for your projects, or exact matches
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/pospro(-portal|-pwa)?(-[a-z0-9]+)?\.vercel\.app$/.test(origin);

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
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

  const { email, otp, storeName, purpose, reportTitle, reportHtml } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) {
    return res.status(500).json({ error: "Resend not configured" });
  }

  // Handle report email separately — no OTP needed
  if (purpose === "report") {
    if (!reportHtml) return res.status(400).json({ error: "Missing report content" });
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: "POS Pro <noreply@pospro-portal.com>",
          to: [email],
          subject: `POS Pro Report: ${reportTitle||"Report"}${storeName ? " — " + storeName : ""}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:24px">
            <div style="background:#4f46e5;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
              <div style="color:#fff;font-size:20px;font-weight:800">POS Pro</div>
              <div style="color:rgba(255,255,255,0.6);font-size:12px">${storeName||"Store Report"}</div>
            </div>
            <h2 style="font-size:16px;color:#111;margin-bottom:16px">${reportTitle||"Report"}</h2>
            ${reportHtml}
            <p style="color:#9ca3af;font-size:11px;margin-top:24px">This report was generated from POS Pro and sent to your registered email.</p>
            <div style="margin-top:12px;padding:10px 14px;background:#f5f3ff;border-radius:8px;font-size:11px;color:#5b21b6">
              💡 <b>To save as PDF:</b> Open the POS app → Reports → View Report → Save as PDF
            </div>
          </div>`,
        }),
      });
      // Use text() first then try to parse as JSON — avoids r.json() throwing
      // on non-JSON Resend responses (plain text errors, timeouts, 502s etc)
      // which was causing a silent 500 with no diagnostic info.
      const rawText = await r.text();
      let data = {};
      try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }
      if (!r.ok) {
        console.error("Resend report email error:", r.status, JSON.stringify(data));
        return res.status(500).json({ error: "Failed to send report", resendStatus: r.status, detail: data });
      }
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error("Report email fetch error:", e.message);
      return res.status(500).json({ error: "Server error", detail: e.message });
    }
  }

  // ── TRIAL EXPIRED EMAIL ──
  if (purpose === "trial_expired") {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: "POS Pro <noreply@pospro-portal.com>",
          to: [email],
          subject: "Your POS Pro Trial Has Expired",
          html: `
            <div style="font-family:sans-serif;max-width:460px;margin:0 auto;padding:24px">
              <div style="background:#4f46e5;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
                <div style="color:#fff;font-size:20px;font-weight:800">POS Pro</div>
                <div style="color:rgba(255,255,255,0.6);font-size:12px">${storeName||"Your Store"}</div>
              </div>
              <h2 style="font-size:16px;color:#111;margin-bottom:8px">Your free trial has ended ⏰</h2>
              <p style="color:#6b7280;font-size:13px;margin-bottom:18px;line-height:1.6">
                Your 3-day free trial for <b>${storeName||"your store"}</b> has expired.
                Your store data is fully preserved — you just need an activation code to continue.
              </p>
              <div style="background:#f5f3ff;border:2px solid #c4b5fd;border-radius:12px;padding:16px;margin-bottom:16px">
                <div style="font-weight:800;font-size:14px;color:#5b21b6;margin-bottom:8px">To continue using POS Pro:</div>
                <ol style="color:#6b7280;font-size:13px;padding-left:16px;margin:0;line-height:1.8">
                  <li>Contact your POS Pro provider</li>
                  <li>Purchase a permanent activation code</li>
                  <li>Enter the code on the POS app to unlock your store</li>
                </ol>
              </div>
              <p style="color:#9ca3af;font-size:11px;margin-top:20px">
                All your products, orders, and data are still safely stored and will be restored once you activate with a permanent code.
              </p>
            </div>
          `,
        }),
      });
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
    } catch(e) {
      return res.status(500).json({ error: "Server error" });
    }
  }

  if (!otp) {
    return res.status(400).json({ error: "Missing otp" });
  }

  const subjects = {
    "sign-in": "Your POS Pro sign-in code",
    "reset":   "Reset your POS Pro portal password",
    "device":  "POS Pro device verification code",
  };

  const subject = subjects[purpose] || subjects["sign-in"];

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from:    "POS Pro <noreply@pospro-portal.com>",
        to:      [email],
        subject: subject,
        html: `
          <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">
            <div style="background:#4f46e5;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
              <div style="color:#fff;font-size:20px;font-weight:800">POS Pro</div>
              <div style="color:rgba(255,255,255,0.6);font-size:12px">${storeName || "Owner Portal"}</div>
            </div>
            <h2 style="font-size:16px;color:#111;margin-bottom:6px">${subject}</h2>
            <p style="color:#6b7280;font-size:13px;margin-bottom:18px">
              Use this code to continue. It expires in <b>10 minutes</b>.
            </p>
            <div style="background:#f5f3ff;border:2px solid #4f46e5;border-radius:12px;padding:18px;text-align:center;margin-bottom:18px">
              <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#4f46e5">${otp}</div>
            </div>
            <p style="color:#9ca3af;font-size:11px">
              If you didn't request this code, you can safely ignore this email.
            </p>
          </div>
        `,
      }),
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
