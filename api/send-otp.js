// Vercel Serverless Function — Node.js (CommonJS)
// Calls Resend API server-side so the key is never exposed to the browser

module.exports = async function handler(req, res) {
  // CORS headers for local testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, otp, storeName, purpose } = req.body || {};

  if (!email || !otp) {
    return res.status(400).json({ error: "Missing email or otp" });
  }

  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) {
    console.error("RESEND_KEY not set in environment variables");
    return res.status(500).json({ error: "Email service not configured" });
  }

  const subjects = {
    "sign-in": "Your POS Pro sign-in code",
    "reset":   "Reset your POS Pro portal password",
    "device":  "POS Pro device verification code",
  };
  const subject = subjects[purpose] || subjects["sign-in"];

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from:    "POS Pro <onboarding@resend.dev>",
        to:      [email],
        subject: subject,
        html: `
          <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">
            <div style="background:#4f46e5;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
              <div style="color:#fff;font-size:20px;font-weight:800">🛒 POS Pro</div>
              <div style="color:rgba(255,255,255,0.6);font-size:12px">${storeName || "Owner Portal"}</div>
            </div>
            <h2 style="font-size:16px;color:#111;margin-bottom:6px">${subject}</h2>
            <p style="color:#6b7280;font-size:13px;margin-bottom:18px">
              Use this code to continue. It expires in <b>10 minutes</b>.
            </p>
            <div style="background:#f5f3ff;border:2px solid #4f46e5;border-radius:12px;padding:20px;text-align:center;margin-bottom:18px">
              <div style="font-size:36px;font-weight:800;letter-spacing:10px;color:#4f46e5;font-family:monospace">${otp}</div>
            </div>
            <p style="color:#9ca3af;font-size:11px">
              If you didn't request this code, you can safely ignore this email.
            </p>
          </div>
        `,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Resend API error:", JSON.stringify(data));
      return res.status(500).json({ error: "Failed to send email", detail: data?.message || data });
    }

    console.log("Email sent successfully to:", email);
    return res.status(200).json({ ok: true, id: data.id });

  } catch (err) {
    console.error("Serverless function error:", err.message);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
};
