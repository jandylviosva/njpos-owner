// Vercel Serverless Function — sends the customer confirmation email once
// staff confirm a booking's payment in the PWA. Only fires when the booking
// has a customerEmail on file (it's an optional field on the public booking
// form) — if there isn't one, the PWA doesn't call this at all and staff
// just confirm by phone as usual.

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

async function sendResendEmail(RESEND_KEY, { to, subject, html }) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: "POS Pro <noreply@pospro-portal.com>", to: Array.isArray(to) ? to : [to], subject, html }),
  });
}

const fmtPeso = (n) => `\u20B1${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtHours = (mins) => { const h = Math.round((mins/60)*10)/10; return h % 1 === 0 ? String(h) : h.toFixed(1); };
const pricingBreakdown = (hourlyRate, durationMinutes) => {
  if (!hourlyRate || !durationMinutes) return null;
  return `${fmtPeso(hourlyRate)}/hr \u00D7 ${fmtHours(durationMinutes)} hr${fmtHours(durationMinutes)==="1"?"":"s"}`;
};
const fmtDateLabel = (dateStr) => { try { return new Date(dateStr+"T00:00:00").toLocaleDateString("en-PH",{weekday:"long",month:"long",day:"numeric",year:"numeric"}); } catch { return dateStr; } };
const fmtTimeLabel = (t) => { if(!t) return ""; const [h,m]=t.split(":").map(Number); const period=h>=12?"PM":"AM"; const h12=h%12===0?12:h%12; return `${h12}:${String(m).padStart(2,"0")} ${period}`; };

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { customerEmail, customerFirstName, storeName, storePhone, storeAddress, serviceName, resourceName, date, time, refCode, amount, hourlyRate, durationMinutes, bookingNoun, kind } = req.body || {};
  if (!customerEmail || !/\S+@\S+\.\S+/.test(customerEmail)) return res.status(400).json({ error: "Missing or invalid email" });
  if (!serviceName || !date) return res.status(400).json({ error: "Missing booking details" });

  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: "Email isn't configured" });

  const noun = bookingNoun || "Booking";
  const reschedule = kind === "reschedule";
  const subject = reschedule
    ? `Your ${noun.toLowerCase()} has been moved — ${serviceName} on ${fmtDateLabel(date)}`
    : `Your ${noun.toLowerCase()} is confirmed — ${serviceName} on ${fmtDateLabel(date)}`;

  const rows = [
    ["Service", serviceName],
    ["Date", fmtDateLabel(date)],
    ...(time ? [["Time", fmtTimeLabel(time)]] : []),
    ...(resourceName ? [["With", resourceName]] : []),
    [`${noun} Reference`, refCode || ""],
    ...(amount ? [["Amount Paid", fmtPeso(amount) + (pricingBreakdown(hourlyRate, durationMinutes) ? ` (${pricingBreakdown(hourlyRate, durationMinutes)})` : "")]] : []),
  ];

  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f9fafb">
    <div style="background:#0d9488;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
      <div style="color:#fff;font-size:20px;font-weight:800">${storeName||`Your ${noun.toLowerCase()}`}</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
      <div style="color:#0d9488;font-weight:700;font-size:13px;margin-bottom:10px">${reschedule?`↻ ${noun} Moved`:"✓ Payment Confirmed"}</div>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 18px">Hi ${customerFirstName||"there"},<br/>${reschedule?`Your ${noun.toLowerCase()} has been moved to a new time.`:`Your payment has been verified and your ${noun.toLowerCase()} is now confirmed.`}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${rows.map(([label,val])=>`<tr><td style="padding:6px 0;color:#6b7280">${label}</td><td style="padding:6px 0;color:#111;text-align:right;font-weight:700">${val}</td></tr>`).join("")}
      </table>
      ${storePhone ? `<p style="color:#6b7280;font-size:13px;margin:20px 0 0">Need to reschedule or have a question?<br/>Call us: ${storePhone}</p>` : ""}
    </div>
    <p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:16px">${storeName||""}${storeAddress?` · ${storeAddress}`:""}</p>
  </div>`;

  try {
    const r = await sendResendEmail(RESEND_KEY, { to: customerEmail, subject, html });
    if (!r.ok) { const t = await r.text().catch(()=>""); return res.status(500).json({ error: `Send failed: ${t}` }); }
  } catch (e) {
    return res.status(500).json({ error: e.message || "Send failed" });
  }
  return res.status(200).json({ ok: true });
}
