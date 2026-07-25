// Vercel Serverless Function — validates a voucher code entered on the
// /payment page WITHOUT consuming a redemption slot. The actual
// redemption (incrementing used_count, recording who used it) only
// happens in submit-payment.js at the moment a payment is genuinely
// submitted — otherwise someone could "check" a limited-use code
// repeatedly and burn through its cap without ever paying.
//
// This endpoint is re-run server-side inside submit-payment.js too
// (never trust a discount amount computed only on the client) — this
// file exports its core check so both places share one source of truth
// instead of two copies of the same rules quietly drifting apart.

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

// Shared check — returns { ok:true, discount } or { ok:false, error }.
// Does NOT record a redemption; callers decide when that actually happens.
export async function checkVoucher({ code, email, plan }) {
  const normalizedCode = (code || "").trim().toUpperCase();
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!normalizedCode) return { ok: false, error: "Enter a voucher code" };
  if (!normalizedEmail) return { ok: false, error: "Enter your email first" };

  const res = await supaTable("discount_codes", `?code=eq.${encodeURIComponent(normalizedCode)}&select=*`, { method: "GET" });
  if (!res.ok) return { ok: false, error: "Could not check voucher — try again" };
  const rows = await res.json();
  const discount = rows?.[0];
  if (!discount) return { ok: false, error: "Voucher code not found" };
  if (!discount.active) return { ok: false, error: "This voucher is no longer active" };
  if (discount.expires_at && new Date(discount.expires_at) < new Date()) return { ok: false, error: "This voucher has expired" };
  if (discount.applies_to !== "both" && discount.applies_to !== plan) {
    return { ok: false, error: `This voucher only applies to the ${discount.applies_to} plan` };
  }
  if (discount.restricted_email && discount.restricted_email.trim().toLowerCase() !== normalizedEmail) {
    return { ok: false, error: "This voucher is reserved for a different email" };
  }
  if (discount.max_uses != null && discount.used_count >= discount.max_uses) {
    return { ok: false, error: "This voucher has reached its usage limit" };
  }
  if (discount.one_per_email) {
    const redRes = await supaTable(
      "discount_redemptions",
      `?discount_id=eq.${discount.id}&email=eq.${encodeURIComponent(normalizedEmail)}&select=id`,
      { method: "GET" }
    );
    const redRows = redRes.ok ? await redRes.json() : [];
    if (redRows.length > 0) return { ok: false, error: "You've already used this voucher" };
  }

  return { ok: true, discount };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { code, email, plan } = req.body || {};
  try {
    const result = await checkVoucher({ code, email, plan });
    if (!result.ok) return res.status(200).json({ ok: false, error: result.error });
    const d = result.discount;
    return res.status(200).json({
      ok: true,
      code: d.code,
      type: d.type,
      value: Number(d.value),
      appliesTo: d.applies_to,
      discountScope: d.discount_scope || "both",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Something went wrong" });
  }
}
