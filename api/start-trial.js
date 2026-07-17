// Vercel Serverless Function — /api/start-trial
// Creates a trial store + license in Supabase, sends trial code to user,
// notifies developer. Called from the PWA "Try for Free" flow.

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

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function genTrialCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `TRIAL-${s.slice(0,4)}-${s.slice(4,8)}`;
}

async function supaRequest(path, method, body, supaUrl, supaKey) {
  const r = await fetch(`${supaUrl}/rest/v1/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "apikey": supaKey,
      "Authorization": `Bearer ${supaKey}`,
      "Prefer": "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  return { ok: r.ok, data };
}

async function sendEmail(to, subject, html, resendKey) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: "NJ POS <noreply@mail.nj-systems.com>",
      reply_to: "pos_support@nj-systems.com",
      to: [to],
      subject,
      html,
    }),
  });
  return r.ok;
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, storeName, ownerName } = req.body || {};

  if (!email || !storeName || !ownerName) {
    return res.status(400).json({ error: "Missing required fields: email, storeName, ownerName" });
  }

  const RESEND_KEY  = process.env.RESEND_KEY;
  // VITE_ vars are only available during frontend build, not in serverless functions.
  // Use SUPA_URL and SUPA_ANON as plain server-side env vars in Vercel.
  const SUPA_URL    = process.env.SUPA_URL    || process.env.VITE_SUPA_URL;
  const SUPA_KEY    = process.env.SUPA_ANON   || process.env.VITE_SUPA_ANON;
  const DEV_EMAIL   = process.env.DEV_ADMIN_EMAIL || process.env.DEV_EMAIL;

  if (!RESEND_KEY)  return res.status(500).json({ error: "Email service not configured" });
  if (!SUPA_URL || !SUPA_KEY) return res.status(500).json({ error: "Database not configured" });

  const cleanEmail = email.trim().toLowerCase();

  try {
    // ── 1. Check if email already has a store (one trial per email) ──
    const checkRes = await fetch(
      `${SUPA_URL}/rest/v1/stores?owner_email=eq.${encodeURIComponent(cleanEmail)}&limit=1`,
      { headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` } }
    );
    const existing = await checkRes.json();
    if (existing?.length > 0) {
      return res.status(409).json({
        error: "A store is already registered with this email. Use the activation screen to restore your store, or contact us to upgrade."
      });
    }

    // ── 2. Generate trial code + expiry (3 days from now) ──
    const trialCode    = genTrialCode();
    const trialExpires = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const storeId      = uid() + uid(); // temporary ID — real store created on POS activation

    // ── 3. Insert license into Supabase ──
    const licResult = await supaRequest(
      "licenses",
      "POST",
      {
        code:             trialCode,
        plan:             "trial",
        max_devices:      1,
        status:           "unused",
        trial_expires_at: trialExpires,
        notes:            `Trial — ${ownerName} — ${storeName} — ${cleanEmail}`,
        created_at:       new Date().toISOString(),
      },
      SUPA_URL,
      SUPA_KEY
    );

    if (!licResult.ok) {
      console.error("License insert failed:", licResult.data);
      return res.status(500).json({ error: "Failed to create trial license. Please try again." });
    }

    // ── 4. Send trial code email to user ──
    const expiryDate = new Date(trialExpires).toLocaleDateString("en-PH", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    await sendEmail(
      cleanEmail,
      "Your NJ POS Trial Activation Code",
      `
      <div style="font-family:sans-serif;max-width:460px;margin:0 auto;padding:24px">
        <div style="background:#0F172A;border-radius:12px;padding:18px;text-align:center;margin-bottom:20px">
          <img src="https://owner.nj-systems.com/email-logo.png" alt="NJ POS" width="183" height="55" style="display:block;margin:0 auto;"/>
          <div style="color:rgba(255,255,255,0.6);font-size:12px">3-Day Free Trial</div>
        </div>
        <h2 style="font-size:16px;color:#111;margin-bottom:6px">Hi ${ownerName}! 👋</h2>
        <p style="color:#6b7280;font-size:13px;margin-bottom:18px">
          Your free trial for <b>${storeName}</b> is ready. Use the code below to activate NJ POS.
        </p>
        <div style="background:#f5f3ff;border:2px solid #2563EB;border-radius:12px;padding:18px;text-align:center;margin-bottom:18px">
          <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;margin-bottom:8px">YOUR TRIAL CODE</div>
          <div style="font-size:24px;font-weight:800;letter-spacing:4px;color:#2563EB;font-family:monospace">${trialCode}</div>
        </div>
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;margin-bottom:18px;font-size:12px;color:#92400e">
          ⏳ <b>Trial expires:</b> ${expiryDate} (3 days from now)
        </div>
        <a href="https://pos.nj-systems.com" style="display:block;text-align:center;background:#2563EB;color:#fff;text-decoration:none;font-size:15px;font-weight:800;padding:14px;border-radius:10px;margin-bottom:18px;box-shadow:0 4px 12px rgba(37,99,235,0.35)">
          🚀 Open NJ POS App →
        </a>
        <p style="color:#6b7280;font-size:13px;margin-bottom:8px"><b>How to activate:</b></p>
        <ol style="color:#6b7280;font-size:13px;padding-left:18px;line-height:1.8">
          <li>Click <b>"Open NJ POS App"</b> above or go to <a href="https://pos.nj-systems.com" style="color:#2563EB;font-weight:600">pos.nj-systems.com</a></li>
          <li>Enter your email: <b>${cleanEmail}</b></li>
          <li>Enter your trial code when prompted</li>
          <li>Set up your store details and start selling</li>
        </ol>
        <div style="margin-top:20px;padding:12px 14px;background:#f0fdf4;border-radius:8px;font-size:12px;color:#166534">
          ✅ Full access for 3 days — no payment required to start.<br/>
          To continue after the trial, contact us to get a permanent activation code.
        </div>
        <div style="margin-top:12px;padding:12px 14px;background:#fef3c7;border-radius:8px;font-size:12px;color:#92400e;line-height:1.6">
          💡 <b>Your trial includes everything</b> — Open Bills, Purchase Orders, Invoices, and Kitchen Order Ticket are all unlocked so you can try the complete system. These four are available as paid add-ons after your trial ends; everything else on the Standard plan stays included.
        </div>
        <p style="color:#9ca3af;font-size:11px;margin-top:20px">
          If you didn't request this trial, you can safely ignore this email.
        </p>
      </div>
      `,
      RESEND_KEY
    );

    // ── 5. Notify developer ──
    if (DEV_EMAIL) {
      await sendEmail(
        DEV_EMAIL,
        `🆕 New Trial Started — ${storeName}`,
        `
        <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px">
          <div style="background:#0f172a;border-radius:12px;padding:16px;margin-bottom:16px">
            <div style="color:#818cf8;font-size:18px;font-weight:800">NJ POS Dev Console</div>
            <div style="color:#6b7280;font-size:11px">New Trial Notification</div>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:700;width:120px">Store Name</td><td style="padding:8px 0;color:#111;font-weight:700">${storeName}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:700">Owner</td><td style="padding:8px 0;color:#111">${ownerName}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:700">Email</td><td style="padding:8px 0;color:#2563EB">${cleanEmail}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:700">Trial Code</td><td style="padding:8px 0;color:#111;font-family:monospace;font-weight:800">${trialCode}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:700">Expires</td><td style="padding:8px 0;color:#d97706">${expiryDate}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;font-weight:700">Started</td><td style="padding:8px 0;color:#111">${new Date().toLocaleString("en-PH")}</td></tr>
          </table>
          <div style="margin-top:16px;padding:10px 14px;background:#f5f3ff;border-radius:8px;font-size:12px;color:#5b21b6">
            💡 To convert this trial to a paid store, generate a new activation code in the Dev Console and send it to ${cleanEmail}.
          </div>
        </div>
        `,
        RESEND_KEY
      );
    }

    return res.status(200).json({ ok: true, trialExpires });

  } catch (e) {
    console.error("start-trial error:", e);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
