// Vercel Serverless Function — runs on the server, not the browser
// This is what actually calls Resend so the API key is never exposed

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, otp, storeName, purpose } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: "Missing email or otp" });
  }

  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) {
    return res.status(500).json({ error: "Resend not configured" });
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
        from:    "POS Pro <onboarding@resend.dev>",
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
