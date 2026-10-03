// The scheduled daily report's recipients: order_settings.reportEmail holds one address
// ("owner@gmail.com") or several ("a@x.com, b@x.com"). Same rules as the POS settings screen.
export const MAX_REPORT_EMAILS = 5;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function reportRecipients(value) {
  const out = [];
  for (const p of String(value ?? "").split(/[,;\s]+/)) {
    const e = p.trim().toLowerCase();
    if (e && e.length <= 120 && EMAIL.test(e) && !out.includes(e)) out.push(e);
  }
  return out.slice(0, MAX_REPORT_EMAILS);
}
