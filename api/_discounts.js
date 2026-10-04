// Discounts given on the day's sales, split by where they came from (a copy of the POS's calculation in
// njpos-pwa/src/lib/discounts.js, so the daily email shows the same figures as the app's reports).
// The leading underscore keeps Vercel from exposing this file as a route.
//   total = (subtotal - discountAmt [+ VAT when VAT is added on top]) - voucherDiscount - birthdayDiscount
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const itemsTotal = (o) => (o?.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);

export function saleBreakdown(o) {
  const manual = num(o?.discountAmt);
  const type = String(o?.discountType || "");
  const senior = type === "senior" ? manual : 0;
  const pwd = type === "pwd" ? manual : 0;
  const voucher = num(o?.voucherDiscount);
  const birthday = num(o?.birthdayDiscount);
  const discounts = manual + voucher + birthday;
  const total = Number(o?.total) || 0;
  let gross = num(o?.subtotal) || itemsTotal(o);
  let vatAdded = 0;
  if (gross > 0) vatAdded = Math.max(0, r2(total - (gross - discounts)));
  else gross = total + discounts;
  return { gross, senior, pwd, other: manual - senior - pwd, manual, voucher, birthday, discounts, vatAdded, total, has: discounts > 0 };
}

export function discountSummary(orders) {
  const t = { counts: { senior: 0, pwd: 0, other: 0, voucher: 0, birthday: 0 }, gross: 0, senior: 0, pwd: 0, other: 0, voucher: 0, birthday: 0, total: 0, vatAdded: 0, sales: 0, orders: 0, orderCount: 0, byCashier: {} };
  for (const o of orders || []) {
    if (!o || o.status !== "paid") continue;
    const b = saleBreakdown(o);
    t.orderCount += 1; t.sales += b.total; t.gross += b.gross; t.vatAdded += b.vatAdded;
    t.senior += b.senior; t.pwd += b.pwd; t.other += b.other; t.voucher += b.voucher; t.birthday += b.birthday;
    if (b.has) {
      t.orders += 1;
      for (const k of Object.keys(t.counts)) if (b[k] > 0) t.counts[k] += 1;
      const c = o.cashier || "Unknown";
      (t.byCashier[c] = t.byCashier[c] || { orders: 0, amount: 0 }); t.byCashier[c].orders += 1; t.byCashier[c].amount += b.discounts;
    }
  }
  t.total = t.senior + t.pwd + t.other + t.voucher + t.birthday;
  return t;
}

// the lines of the discount table: [label, amount (positive), order count, colour]
export function discountLines(t) {
  const c = t.counts || {};
  return [
    ["Senior citizen discount", t.senior, c.senior, "#0891b2"],
    ["PWD discount", t.pwd, c.pwd, "#0891b2"],
    ["Manual discount", t.other, c.other, "#16a34a"],
    ["Voucher / promo code", t.voucher, c.voucher, "#7c3aed"],
    ["Birthday discount", t.birthday, c.birthday, "#b45309"],
  ].filter((r) => r[1] > 0);
}
