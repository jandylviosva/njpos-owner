// A split order is PARTLY cash and PARTLY a specific online method. Reports must count each part under its own
// payment method (cash 150 + GCash 600), never as one lump called "Split". Same rule as the POS app (posHelpers.js).
export function orderPaymentBreakdown(order) {
  if (order && order.payMethod === "split") {
    return { cash: order.splitCash || 0, online: { [order.splitOnlineMethod || "online"]: order.splitOnlineAmount || 0 } };
  }
  const method = (order && order.payMethod) || "cash";
  const total = (order && order.total) || 0;
  return method === "cash" ? { cash: total, online: {} } : { cash: 0, online: { [method]: total } };
}

// → { cash: {count, amt}, gcash: {count, amt}, ... } counting every order once per method it used
export function paymentTotalsByMethod(orders) {
  const out = {};
  const add = (m, amt) => { out[m] = out[m] || { count: 0, amt: 0 }; out[m].count += 1; out[m].amt += amt; };
  for (const o of orders) {
    const b = orderPaymentBreakdown(o);
    if (b.cash) add("cash", b.cash);
    for (const [m, amt] of Object.entries(b.online)) if (amt) add(m, amt);
    if (!b.cash && !Object.values(b.online).some(Boolean)) add((o && o.payMethod) === "split" ? "cash" : ((o && o.payMethod) || "cash"), 0);
  }
  return out;
}
