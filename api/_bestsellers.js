// Bestsellers for the daily report: the products that sold the most in the orders given (the report day's paid
// orders), worked out from the sales, so only products with a sale ever appear. (Monitored products are the separate
// list the owner starred in Inventory because they sell out quickly.)
export function topSellers(paidOrders, limit = 5) {
  const by = new Map();
  for (const o of paidOrders || []) {
    for (const it of o.items || []) {
      const qty = Number(it.qty) || 0;
      if (qty <= 0) continue;
      const key = it.productId || it.id || it.name;
      if (!key) continue;
      const cur = by.get(key) || { name: it.name || "Item", qty: 0, revenue: 0 };
      cur.qty += qty;
      cur.revenue += (Number(it.price) || 0) * qty;
      by.set(key, cur);
    }
  }
  return [...by.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue || a.name.localeCompare(b.name)).slice(0, limit);
}
