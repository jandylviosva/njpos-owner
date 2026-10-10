// Builds the detailed PDF that goes with the daily report email. The email is a summary (top 5
// products, totals); this has the whole day: every order, every product sold, every expense.
// The leading underscore keeps Vercel from exposing this file as a route.
import { PdfReport } from "./_pdfKit.js";
import { discountSummary, discountLines } from "./_discounts.js";
import { topSellers } from "./_bestsellers.js";

const peso = (n) =>
  "₱" + (Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LOGO_URL = "https://owner.nj-systems.com/email-logo.png";
let logoCache = null;
async function fetchLogo() {
  if (logoCache) return logoCache;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(LOGO_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    logoCache = new Uint8Array(await r.arrayBuffer());
    return logoCache;
  } catch { return null; }
}

// "10/2/2026, 10:30:00 AM" -> "10:30 AM"
const timeOf = (o) => {
  const part = String(o.date || "").split(",")[1];
  return part ? part.trim().replace(/:\d{2}(\s|$)/, "$1") : "";
};

const labelForMethod = (id, payMethods) => {
  if (!id) return "Cash";
  const built = { cash: "Cash", gcash: "GCash", maya: "Maya", card: "Card", split: "Split" };
  if (built[id]) return built[id];
  const custom = (payMethods || []).find((m) => m.id === id);
  return custom?.label || id.charAt(0).toUpperCase() + id.slice(1);
};

// orders: that day's orders (paid and void). Returns the PDF as base64.
export async function buildDailyReportPdf({ storeName, dateLabel, reportKey, orders, products, storeExpenses, payMethods }) {
  const paid = orders.filter((o) => o.status === "paid");
  const voided = orders.filter((o) => o.status === "void");
  const totalSales = paid.reduce((s, o) => s + (o.total || 0), 0);

  const shiftExpenseRows = [];
  paid.forEach((o) => (o.expenses || []).forEach((e) => {
    const amt = parseFloat(e.amount) || 0;
    if (amt) shiftExpenseRows.push([e.name || e.description || "Expense", "Shift expense", o.cashier || "", amt]);
  }));
  const storeExpenseRows = (storeExpenses || [])
    .filter((e) => e.date === reportKey)
    .map((e) => [e.description || "Expense", `Store expense${e.category ? " - " + e.category : ""}`, "", parseFloat(e.amount) || 0]);
  const shiftExpenses = shiftExpenseRows.reduce((s, r) => s + r[3], 0);
  const storeLevelExpenses = storeExpenseRows.reduce((s, r) => s + r[3], 0);
  const totalExpenses = shiftExpenses + storeLevelExpenses;

  const byMethod = {};
  paid.forEach((o) => {
    const m = o.payMethod || "cash";
    byMethod[m] = byMethod[m] || { count: 0, amt: 0 };
    byMethod[m].count += 1;
    byMethod[m].amt += o.total || 0;
  });
  const cashCollected = byMethod.cash?.amt || 0;
  const cashOnHand = cashCollected - totalExpenses;
  const nonCash = Object.entries(byMethod).filter(([k]) => k !== "cash").reduce((s, [, v]) => s + v.amt, 0);
  const netSales = cashOnHand + nonCash;

  const good = "#059669", bad = "#dc2626";
  const rep = await PdfReport.create({
    title: "Daily Sales Report",
    subtitle: `${dateLabel}  -  ${storeName}`,
    landscape: false,
    logoBytes: await fetchLogo(),
    footer: `${storeName}  |  Daily Sales Report ${dateLabel}  |  Sent automatically by NJ POS`,
  });

  rep.kpis([
    { label: "Total Sales", value: peso(totalSales), col: good, bg: "#f0fdf4" },
    { label: "Orders", value: String(paid.length), col: "#2563EB", bg: "#eff6ff" },
    { label: "Expenses", value: totalExpenses > 0 ? peso(totalExpenses) : "-", col: bad, bg: "#fef2f2" },
    { label: "Cash on Hand (cash - expenses)", value: peso(cashOnHand), col: cashOnHand >= 0 ? good : bad, bg: cashOnHand >= 0 ? "#f0fdf4" : "#fef2f2" },
    { label: "Net Sales (cash on hand + other payments)", value: peso(netSales), col: netSales >= 0 ? good : bad, bg: netSales >= 0 ? "#f0fdf4" : "#fef2f2" },
    { label: "Voided orders", value: String(voided.length), col: voided.length ? bad : "#6b7280", bg: "#f9fafb" },
  ], 3);

  // discounts given: sales before discounts, each kind, the total and what is left
  const disc = discountSummary(paid);
  if (disc.total > 0) {
    rep.heading("Discounts given");
    const red = "#991b1b";
    const rows = [
      [{ text: "Sales before discounts", bold: true }, { text: "", }, { text: peso(disc.gross), bold: true, align: "right" }],
      ...discountLines(disc).map(([l, v, n, col]) => [{ text: l, col }, { text: `${n} order${n === 1 ? "" : "s"}`, align: "right", col: "#6b7280" }, { text: "-" + peso(v), align: "right", col }]),
      [{ text: "Total discounts", bold: true, col: red }, { text: `${disc.orders} of ${disc.orderCount} orders`, align: "right", col: "#6b7280" }, { text: "-" + peso(disc.total), bold: true, align: "right", col: red }],
      ...(disc.vatAdded > 0.005 ? [[{ text: "Add: VAT" }, { text: "" }, { text: peso(disc.vatAdded), align: "right" }]] : []),
      [{ text: "Total Sales", bold: true }, { text: "" }, { text: peso(disc.sales), bold: true, align: "right" }],
    ];
    rep.table({ columns: [{ header: "", w: 6 }, { header: "Orders", w: 3, align: "right" }, { header: "Amount", w: 3, align: "right" }], rows });
    const who = Object.entries(disc.byCashier).sort((a, b) => b[1].amount - a[1].amount);
    if (who.length > 1) {
      rep.heading("Discounts by cashier");
      rep.table({ columns: [{ header: "Cashier", w: 6 }, { header: "Orders", w: 1, align: "right" }, { header: "Discounts", w: 2, align: "right" }], rows: who.map(([c, d]) => [c, String(d.orders), peso(d.amount)]) });
    }
  }

  // payment methods
  if (Object.keys(byMethod).length) {
    rep.heading("Payment methods");
    rep.table({
      columns: [{ header: "Method", w: 5 }, { header: "Orders", w: 1, align: "right" }, { header: "Collected", w: 2, align: "right" }, { header: "Counted in the report as", w: 3, align: "right" }],
      rows: Object.entries(byMethod).sort((a, b) => b[1].amt - a[1].amt).map(([m, v]) => [
        labelForMethod(m, payMethods), { text: String(v.count) }, peso(v.amt),
        m === "cash" ? `${peso(cashOnHand)} on hand${totalExpenses > 0 ? ` (less ${peso(totalExpenses)} expenses)` : ""}` : peso(v.amt),
      ]),
    });
  }

  // by cashier
  const byCashier = {};
  paid.forEach((o) => {
    const c = o.cashier || "Unknown";
    byCashier[c] = byCashier[c] || { count: 0, amt: 0 };
    byCashier[c].count += 1;
    byCashier[c].amt += o.total || 0;
  });
  if (Object.keys(byCashier).length > 0) {
    rep.heading("Sales by cashier");
    rep.table({
      columns: [{ header: "Cashier", w: 6 }, { header: "Orders", w: 1, align: "right" }, { header: "Sales", w: 2, align: "right" }],
      rows: Object.entries(byCashier).sort((a, b) => b[1].amt - a[1].amt).map(([c, v]) => [c, String(v.count), peso(v.amt)]),
    });
  }

  // expenses
  rep.heading("Expenses");
  if (totalExpenses > 0) {
    rep.table({
      columns: [{ header: "Description", w: 6 }, { header: "Type", w: 3 }, { header: "By", w: 2 }, { header: "Amount", w: 2, align: "right" }],
      rows: [...shiftExpenseRows, ...storeExpenseRows].map((r) => [r[0], r[1], r[2], { text: peso(r[3]), col: "#991b1b" }]),
      total: [{ text: "Total expenses", bold: true, span: 3 }, { text: peso(totalExpenses), bold: true, align: "right", col: bad }],
    });
  } else {
    rep.text("No expenses recorded for this day.", { col: "#059669" });
  }

  // every product sold
  const sold = {};
  paid.forEach((o) => (o.items || []).forEach((i) => {
    const key = `${i.name || "Item"}${i.variantLabel ? ` (${i.variantLabel})` : ""}`;
    sold[key] = sold[key] || { qty: 0, rev: 0 };
    sold[key].qty += Number(i.qty) || 1;
    sold[key].rev += (Number(i.price) || 0) * (Number(i.qty) || 1);
  }));
  const soldRows = Object.entries(sold).sort((a, b) => b[1].qty - a[1].qty);
  if (soldRows.length) {
    rep.heading(`Products sold (${soldRows.length})`);
    rep.table({
      columns: [{ header: "Product", w: 8 }, { header: "Qty sold", w: 1.5, align: "right" }, { header: "Sales (at item price)", w: 2.5, align: "right" }],
      rows: soldRows.map(([n, v]) => [n, String(+v.qty.toFixed(3)), peso(v.rev)]),
    });
  }

  // every order
  const sorted = [...paid].reverse();   // oldest first (orders are stored newest first)
  rep.heading(`All orders (${paid.length})`);
  if (sorted.length) {
    rep.table({
      columns: [
        { header: "Time", w: 1.3 }, { header: "Order", w: 2.8 }, { header: "Cashier", w: 2 }, { header: "Type", w: 2.3 },
        { header: "Payment", w: 1.8 },
        { header: "Discount", w: 1.5, align: "right" }, { header: "Total", w: 1.8, align: "right" },
      ],
      fontSize: 8,
      rows: sorted.map((o) => [
        timeOf(o), (o.id || "") + (o.notes ? `\n[Note: ${o.notes}]` : ""), o.cashier || "",
        [o.orderType, o.orderSource].filter(Boolean).join(" / ") || "-",
        labelForMethod(o.payMethod, payMethods) + (o.refNum ? ` #${o.refNum}` : ""),
        o.discountAmt ? peso(o.discountAmt) : "",
        { text: peso(o.total), bold: true, align: "right" },
      ]),
      total: [{ text: "Total", bold: true, span: 6 }, { text: peso(totalSales), bold: true, align: "right" }],
    });
  } else {
    rep.text("No paid orders for this day.");
  }

  // voided
  if (voided.length) {
    rep.heading(`Voided orders (${voided.length})`, 2, "#dc2626");
    rep.table({
      columns: [{ header: "Time", w: 1.2 }, { header: "Order", w: 2.2 }, { header: "Cashier", w: 1.8 }, { header: "Reason", w: 6 }, { header: "Total", w: 1.6, align: "right" }],
      rows: [...voided].reverse().map((o) => [timeOf(o), o.id || "", o.cashier || "", o.voidReason || "-", peso(o.total)]),
    });
  }

  // stock
  const tracked = (products || []).filter((p) => p.active !== false && p.stockMode !== "none");
  const alerts = tracked
    .filter((p) => Number(p.stock || 0) <= (p.lowStockAt != null ? Number(p.lowStockAt) : 5))
    .sort((a, b) => Number(a.stock || 0) - Number(b.stock || 0));
  rep.heading(`Stock alerts (${alerts.length})`, 2, alerts.length ? "#dc2626" : undefined);
  if (alerts.length) {
    rep.text("Products at or below their low stock level.");
    rep.table({
      columns: [{ header: "Product", w: 7 }, { header: "Category", w: 3 }, { header: "Stock", w: 2.5, align: "right" }],
      rows: alerts.map((p) => {
        const st = Number(p.stock || 0);
        return [p.name || "", p.category || "-", { text: st < 0 ? `Oversold (${st})` : st === 0 ? "Out of stock" : `${st} ${p.stockUnit || "pcs"}`, col: st <= 0 ? bad : "#d97706", bold: true, align: "right" }];
      }),
    });
  } else {
    rep.text("All products are above their low stock level.", { col: "#059669" });
  }

  // bestsellers: what sold the most this day (only products with a sale)
  const best = topSellers((orders || []).filter((o) => o.status === "paid"), 8);
  if (best.length) {
    rep.heading(`Bestsellers (${best.length})`, 2, good);
    rep.text("The products that sold the most this day.");
    rep.table({
      columns: [{ header: "#", w: 1 }, { header: "Product", w: 8 }, { header: "Sold", w: 2, align: "right" }, { header: "Sales", w: 2.5, align: "right" }],
      rows: best.map((b, i) => [String(i + 1), b.name, { text: String(Number.isInteger(b.qty) ? b.qty : b.qty.toFixed(2)), bold: true, align: "right" }, { text: peso(b.revenue), align: "right" }]),
    });
  }

  const starred = (products || []).filter((p) => p.isBestseller && p.active !== false);
  if (starred.length) {
    rep.heading(`Monitored products (${starred.length})`);
    rep.text("Products starred in Inventory because they sell out quickly, with their current stock.");
    rep.table({
      columns: [{ header: "Product", w: 7 }, { header: "Category", w: 3 }, { header: "Stock", w: 2.5, align: "right" }, { header: "Sold this day", w: 2, align: "right" }],
      rows: starred.sort((a, b) => (b.stock || 0) - (a.stock || 0)).map((p) => {
        const st = Number(p.stock || 0);
        return [p.name || "", p.category || "-", { text: st <= 0 ? "Out of stock" : `${st} ${p.stockUnit || "pcs"}`, col: st <= 0 ? bad : st <= 5 ? "#d97706" : good, bold: true, align: "right" }, { text: String(sold[p.name]?.qty || "-"), align: "right" }];
      }),
    });
  }

  return rep.save();
}

export const dailyReportPdfName = (reportKey, storeName) =>
  `NJPOS-Daily-Report-${reportKey}-${String(storeName || "Store").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "Store"}.pdf`;
