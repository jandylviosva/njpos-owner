// Vercel Cron Function — /api/daily-report
//
// Runs every 30 minutes (see "crons" in vercel.json; needs the Vercel Pro plan, the free plan only allows one run a day).
// Each store picks its own time of day (default 12:00 AM) and days of the week (order_settings.reportTime /
// reportDays); every run sends the reports that are due since the last run (see _reportSchedule.js), so a late run
// still sends and nothing goes out twice. A report sent before noon covers the day that just ended; one sent from noon
// on covers today so far.
// Uses the Supabase SERVICE key — never the anon key.

import { reportRecipients } from "./_reportEmails.js";
import { paymentTotalsByMethod } from "./_paymentBreakdown.js";
import { buildDailyReportPdf, dailyReportPdfName } from "./_dailyReportPdf.js";
import { discountSummary, discountLines } from "./_discounts.js";
import { topSellers } from "./_bestsellers.js";
import { dueNow, fmtClock } from "./_reportSchedule.js";

const SUPA_URL         = process.env.SUPA_URL         || process.env.VITE_SUPA_URL;
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const RESEND_KEY       = process.env.RESEND_KEY;

// The email is a summary: long lists stop after a few rows and point to the attached PDF, which has everything.
const EMAIL_LIST_MAX = 10;
const PDF_SEE    = "You can see the full list in the attached PDF file";
const NO_PDF_SEE = "The full list is in the Reports tab of the POS app";
const moreRow = (extra, cols, bg) => extra > 0
  ? `<tr><td colspan="${cols}" style="padding:8px 12px;font-size:11px;color:#6b7280;text-align:center;background:${bg || "#f9fafb"}">+ ${extra} more · ${PDF_SEE}</td></tr>`
  : "";

function fmtPeso(n) {
  return "₱" + (Number(n) || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function labelForMethod(methodId, payMethods) {
  if (!methodId) return "";
  const built = { cash: "Cash", gcash: "GCash", maya: "Maya", card: "Card" };
  if (built[methodId]) return built[methodId];
  const custom = (payMethods || []).find(m => m.id === methodId);
  if (custom?.label) return custom.label;
  return methodId.charAt(0).toUpperCase() + methodId.slice(1);
}

async function supaGet(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      "Content-Type": "application/json",
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
    },
  });
  if (!r.ok) {
    console.error(`[daily-report] supaGet failed (${r.status}): ${path}`);
    return null;
  }
  return r.json();
}

// PATCH a single store_data row — only the order_settings column.
// Uses {minimal:true} per standing rules (no RETURNING clause).
async function supaUpdateOrderSettings(storeId, orderSettings) {
  const r = await fetch(
    `${SUPA_URL}/rest/v1/store_data?store_id=eq.${encodeURIComponent(storeId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPA_SERVICE_KEY,
        Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ order_settings: orderSettings }),
    }
  );
  return r.ok;
}

async function sendEmail(to, subject, html, attachments) {
  const post = (payload) => fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_KEY}`,
    },
    body: JSON.stringify({
      from: "NJ POS <noreply@mail.nj-systems.com>",
      reply_to: "pos_support@nj-systems.com",
      to: Array.isArray(to) ? to : [to],
      subject,
      ...payload,
    }),
  });
  const noPdf = (h) => h.replace(PDF_NOTE, "").split(PDF_SEE).join(NO_PDF_SEE);
  let r = await post(attachments?.length ? { html, attachments } : { html: noPdf(html) });
  if (!r.ok && attachments?.length) {
    // the PDF is a bonus: if Resend refuses it, still deliver the summary email
    console.error("[daily-report] send with PDF failed, retrying without it:", await r.clone().text().catch(() => ""));
    r = await post({ html: noPdf(html) });
  }
  return r.ok;
}

const PDF_NOTE = `<div style="background:#f5f3ff;border-radius:8px;padding:10px 14px;margin:0 0 20px;font-size:12px;color:#5b21b6">📎 <b>The full details are in the attached PDF</b>: every order, every product sold and every expense.</div>`;

export function buildReportHtml(storeName, todayLabel, orders, products, storeExpenses, reportKey, payMethods) {
  const paid = orders.filter(o => o.status === "paid");
  const totalSales = paid.reduce((s, o) => s + (o.total || 0), 0);
  const orderCount = paid.length;
  const disc = discountSummary(paid);

  // Shift expenses — cash expenses recorded during shifts for this day
  const shiftExpenses = paid.reduce((s, o) => {
    return s + ((o.expenses||[]).reduce((es, e) => es + (parseFloat(e.amount)||0), 0));
  }, 0);

  // Store-level expenses (bills, rent, utilities) for this day
  const storeLevelExpenses = (storeExpenses||[])
    .filter(e => e.date === reportKey)
    .reduce((s, e) => s + (parseFloat(e.amount)||0), 0);

  const totalExpenses = shiftExpenses + storeLevelExpenses;

  // The biggest expenses first; the rest are in the PDF
  const expenseList = [
    ...paid.flatMap(o => (o.expenses||[]).map(e => ({ name: e.name||e.description||"Expense", amount: parseFloat(e.amount)||0, tag: "" }))),
    ...(storeExpenses||[]).filter(e => e.date === reportKey).map(e => ({ name: e.description||"Expense", amount: parseFloat(e.amount)||0, tag: e.category||"" })),
  ].filter(e => e.amount > 0).sort((a, b) => b.amount - a.amount);
  const expenseRows = expenseList.slice(0, EMAIL_LIST_MAX).map(e =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #f9fafb;color:#6b7280;font-size:12px">${e.name}${e.tag ? ` <span style="color:#9ca3af">(${e.tag})</span>` : ""}</td><td style="padding:6px 12px;border-bottom:1px solid #f9fafb;text-align:right;font-weight:700;color:#991b1b;font-size:12px">${fmtPeso(e.amount)}</td></tr>`
  ).join("") + moreRow(expenseList.length - EMAIL_LIST_MAX, 2, "#fef2f2");

  // Payment method breakdown
  // a split order counts as its cash part + its online part (never as "Split")
  const byMethod = {};
  Object.entries(paymentTotalsByMethod(paid)).forEach(([m, v]) => { byMethod[m] = v.amt; });

  // Cash on Hand = cash collected minus expenses (expenses paid from cash drawer)
  const cashCollected = byMethod["cash"] || 0;
  const cashOnHand = cashCollected - totalExpenses;
  // Non-cash total
  const nonCashTotal = Object.entries(byMethod).filter(([k]) => k !== "cash").reduce((s,[,v]) => s + v, 0);
  // Net Sales = Cash on Hand + all non-cash payments
  const netSales = cashOnHand + nonCashTotal;

  // Payment method rows — cash shows CoH, others show collected amount
  const methodRows = Object.entries(byMethod)
    .sort((a, b) => b[1] - a[1])
    .map(([m, amt]) => {
      const isCash = m === "cash";
      const displayAmt = isCash ? cashOnHand : amt;
      const sub = isCash && totalExpenses > 0 ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px">collected ${fmtPeso(amt)} − expenses ${fmtPeso(totalExpenses)}</div>` : "";
      const label = isCash ? "Cash (on hand)" : labelForMethod(m, payMethods);
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280">${label}${sub}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:700;text-align:right;color:${isCash && cashOnHand < 0 ? "#dc2626" : "inherit"}">${fmtPeso(displayAmt)}</td>
      </tr>`;
    }).join("");

  // Stock alerts — out of stock or at/below lowStockAt threshold
  const stockAlerts = (products||[])
    .filter(p => p.active !== false && p.stockMode !== "none")
    .filter(p => {
      const stock = Number(p.stock || 0);
      const threshold = p.lowStockAt != null ? Number(p.lowStockAt) : 5;
      return stock <= threshold;
    })
    .sort((a,b) => Number(a.stock||0) - Number(b.stock||0));

  const stockAlertRowsShown = stockAlerts.slice(0, EMAIL_LIST_MAX).map(p => {
    const stock = Number(p.stock||0);
    const isOut = stock <= 0;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#374151">${p.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;color:#6b7280;font-size:12px">${p.category||'—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;color:${isOut?'#dc2626':'#d97706'}">${isOut?'Out of stock':`${stock} ${p.stockUnit||'pcs'} left`}</td>
    </tr>`;
  }).join('');

  const stockAlertRows = stockAlertRowsShown + moreRow(stockAlerts.length - EMAIL_LIST_MAX, 3, "#fef2f2");

  // Bestsellers: top sold products of the report day (only products that sold)
  const bestsellerList = topSellers(paid, 5);
  const bestsellerRows = bestsellerList.map((b, i) => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#374151"><b style="color:${i===0?"#d97706":"#9ca3af"}">${i+1}.</b> ${b.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;color:#059669">${Number.isInteger(b.qty) ? b.qty : b.qty.toFixed(2)} sold</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:right;color:#6b7280">₱${b.revenue.toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    </tr>`).join("");

  // Monitored products (starred in Inventory because they sell out quickly) with current stock
  const starredProducts = (products||[])
    .filter(p => p.isBestseller && p.active !== false)
    .sort((a,b) => (a.stock||0) - (b.stock||0));

  // Build a qty-sold-today map from today's orders
  const soldTodayMap = {};
  paid.forEach(o => (o.items||[]).forEach(it => {
    soldTodayMap[it.name] = (soldTodayMap[it.name]||0) + (it.qty||1);
  }));

  const starredRowsShown = starredProducts.slice(0, EMAIL_LIST_MAX).map(p => {
    const stock = Number(p.stock||0);
    const isOut = stock <= 0;
    const soldToday = soldTodayMap[p.name] || 0;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#374151">⭐ ${p.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;color:#6b7280;font-size:12px">${p.category||'—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;color:${isOut?'#dc2626':stock<=5?'#d97706':'#059669'}">${isOut?'Out of stock':`${stock} ${p.stockUnit||'pcs'}`}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;color:${soldToday>0?'#2563EB':'#9ca3af'}">${soldToday > 0 ? soldToday+' sold' : '—'}</td>
    </tr>`;
  }).join('');
  const starredRows = starredRowsShown + moreRow(starredProducts.length - EMAIL_LIST_MAX, 4, "#fffbeb");

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#0F172A;border-radius:12px;padding:18px;text-align:center;margin-bottom:24px">
        <img src="https://owner.nj-systems.com/email-logo.png" alt="NJ POS" width="183" height="55" style="display:block;margin:0 auto"/>
        <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:6px">${storeName}</div>
      </div>

      <h2 style="font-size:16px;color:#111;margin:0 0 4px">Daily Sales Report</h2>
      <p style="color:#9ca3af;font-size:12px;margin:0 0 20px">${todayLabel}</p>
      ${PDF_NOTE}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
        <div style="background:#f0fdf4;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Total Sales</div>
          <div style="font-size:22px;font-weight:800;color:#059669">${fmtPeso(totalSales)}</div>
        </div>
        <div style="background:#eff6ff;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Orders</div>
          <div style="font-size:22px;font-weight:800;color:#2563EB">${orderCount}</div>
        </div>
        <div style="background:#fef2f2;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Expenses</div>
          <div style="font-size:22px;font-weight:800;color:#dc2626">${totalExpenses > 0 ? fmtPeso(totalExpenses) : "—"}</div>
        </div>
        <div style="background:${cashOnHand >= 0 ? "#f0fdf4" : "#fef2f2"};border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Cash on Hand</div>
          <div style="font-size:22px;font-weight:800;color:${cashOnHand >= 0 ? "#059669" : "#dc2626"}">${fmtPeso(cashOnHand)}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:4px">cash − expenses</div>
        </div>
        <div style="background:${netSales >= 0 ? "#f0fdf4" : "#fef2f2"};border-radius:10px;padding:14px;text-align:center;grid-column:1/-1">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Net Sales</div>
          <div style="font-size:22px;font-weight:800;color:${netSales >= 0 ? "#059669" : "#dc2626"}">${fmtPeso(netSales)}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:4px">Cash on Hand + other payments</div>
        </div>
      </div>

      ${disc.total > 0 ? `
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fef2f2;border-radius:8px;overflow:hidden;border:1px solid #fecaca">
        <tr><td style="padding:10px 12px;color:#991b1b;font-weight:800;font-size:13px">Discounts given <span style="font-weight:400;font-size:11px;color:#6b7280">· ${disc.orders} of ${disc.orderCount} orders · sales before discounts ${fmtPeso(disc.gross)}</span></td><td style="padding:10px 12px;text-align:right;color:#991b1b;font-weight:800;font-size:13px">-${fmtPeso(disc.total)}</td></tr>
      </table>` : ""}

      ${methodRows ? `
      <h3 style="font-size:13px;color:#374151;margin:0 0 8px">Payment Methods</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #f3f4f6">
        ${methodRows}
      </table>` : ""}

      ${(totalExpenses > 0) ? `
      <h3 style="font-size:13px;color:#374151;margin:0 0 8px">Expenses</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #fecaca">
        ${expenseRows}
        <tr style="background:#fef2f2"><td style="padding:8px 12px;font-weight:800;font-size:13px">Total Expenses</td><td style="padding:8px 12px;text-align:right;font-weight:800;color:#dc2626;font-size:13px">${fmtPeso(totalExpenses)}</td></tr>
      </table>` : `
      <div style="background:#f0fdf4;border-radius:8px;padding:12px;margin-bottom:20px;text-align:center;color:#059669;font-size:13px;font-weight:700">
        ✅ No expenses recorded today
      </div>`}

      ${stockAlertRows ? `
      <h3 style="font-size:13px;color:#dc2626;margin:0 0 8px">⚠️ Stock Alerts (${stockAlerts.length})</h3>
      <p style="font-size:11px;color:#9ca3af;margin:0 0 8px">Products at or below low stock threshold, lowest stock first</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #fecaca">
        <thead>
          <tr style="background:#fef2f2">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:700">Product</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:700">Category</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:700">Stock</th>
          </tr>
        </thead>
        <tbody>${stockAlertRows}</tbody>
      </table>` : `
      <div style="background:#f0fdf4;border-radius:8px;padding:12px;margin-bottom:20px;text-align:center;color:#059669;font-size:13px;font-weight:700">
        ✅ All products are well-stocked
      </div>`}

      ${bestsellerRows ? `
      <h3 style="font-size:13px;color:#374151;margin:0 0 8px">🏆 Bestsellers</h3>
      <p style="font-size:11px;color:#9ca3af;margin:0 0 8px">The products that sold the most in this report</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #f3f4f6">
        <thead>
          <tr style="background:#f0fdf4">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:700">Product</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:700">Sold</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:700">Sales</th>
          </tr>
        </thead>
        <tbody>${bestsellerRows}</tbody>
      </table>` : ""}

      ${starredRows ? `
      <h3 style="font-size:13px;color:#374151;margin:0 0 8px">⭐ Monitored Products (${starredProducts.length})</h3>
      <p style="font-size:11px;color:#9ca3af;margin:0 0 8px">Products you monitor because they sell out quickly, lowest stock first</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #f3f4f6">
        <thead>
          <tr style="background:#fffbeb">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:700">Product</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:700">Category</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:700">Stock</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:700">Sold Today</th>
          </tr>
        </thead>
        <tbody>${starredRows}</tbody>
      </table>` : ""}

      <p style="color:#9ca3af;font-size:11px;margin-top:24px;border-top:1px solid #f3f4f6;padding-top:16px">
        Sent automatically by NJ Systems · ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
        <br>To change your report schedule: POS app → Settings → Order Settings → Scheduled Daily Report
      </p>
    </div>`;
}

// Remember that this occurrence was handled. order_settings is read again right before writing, so a setting the store
// saved a moment ago is not overwritten by the copy this run started with.
async function markSent(storeId, due) {
  try {
    const fresh = await supaGet(`store_data?store_id=eq.${encodeURIComponent(storeId)}&select=order_settings`);
    const current = Array.isArray(fresh) && fresh[0] ? (fresh[0].order_settings || {}) : null;
    if (!current) return;
    await supaUpdateOrderSettings(storeId, { ...current, lastReportSentKey: due.key, lastReportSentDate: due.day });
  } catch (e) {
    console.error(`[daily-report] could not record the send for store ${storeId}:`, e?.message || e);
  }
}

export default async function handler(req, res) {
  // Only Vercel's cron may run this (it used to run for any GET or POST, so anyone who found the URL
  // could trigger the reports). With CRON_SECRET set in Vercel the call must carry it (Vercel adds the
  // header itself); without it, the request must at least look like Vercel's cron runner.
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers?.authorization || "");
  const isCron = secret
    ? auth === `Bearer ${secret}`
    : String(req.headers?.["user-agent"] || "").startsWith("vercel-cron") || req.headers?.["x-vercel-cron"] === "1";
  if (!isCron) return res.status(403).json({ error: "Forbidden" });

  if (!SUPA_URL || !SUPA_SERVICE_KEY) {
    return res.status(500).json({ error: "Supabase not configured" });
  }
  if (!RESEND_KEY) {
    return res.status(500).json({ error: "Resend not configured" });
  }

  const nowMs = Date.now();
  console.log(`[daily-report] Run at ${new Date(nowMs).toISOString()}`);

  // Only the small order_settings column of every store here (who is due is decided from it); the big columns
  // (orders, products) are read below for the stores that are actually due.
  const rows = await supaGet("store_data?select=store_id,order_settings");
  if (!rows) {
    return res.status(500).json({ error: "Failed to fetch store_data" });
  }

  // Stores whose license the developer has suspended (e.g. for non-payment) get no report. If the lookup fails the
  // reports still go out, so a database hiccup never silences every store.
  const suspendedStoreIds = new Set();
  try {
    const lics = await supaGet("licenses?status=eq.suspended&select=id");
    const ids = (lics || []).map(l => l.id).filter(Boolean);
    if (ids.length) {
      const sts = await supaGet(`stores?license_id=in.(${ids.map(encodeURIComponent).join(",")})&select=id`);
      (sts || []).forEach(st => suspendedStoreIds.add(st.id));
    }
  } catch (e) {
    console.error("[daily-report] suspended-store lookup failed:", e?.message || e);
  }

  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const row of rows) {
    const os = row.order_settings || {};

    // Suspended stores don't get reports
    if (suspendedStoreIds.has(row.store_id)) { results.skipped++; continue; }

    // Skip stores that haven't opted in
    if (!os.reportEnabled)              { results.skipped++; continue; }
    const recipients = reportRecipients(os.reportEmail);
    if (!recipients.length)             { results.skipped++; continue; }

    // Is this store's report due now (its time of day, its days of the week, not already sent)?
    const due = dueNow(os, nowMs);
    if (!due.due)                       { results.skipped++; continue; }

    const reportKey  = due.reportKey;
    const todayLabel = new Date(reportKey + "T00:00:00Z").toLocaleDateString("en-PH", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })
      + (due.todaySoFar ? ` (until ${fmtClock(due.schedMin)})` : "");

    const data = await supaGet(`store_data?store_id=eq.${encodeURIComponent(row.store_id)}&select=orders,products,theme`);
    const full = Array.isArray(data) ? data[0] : null;
    if (!full) { results.errors++; console.error(`[daily-report] could not read store ${row.store_id}`); continue; }

    const storeName = full.theme?.storeName || "My Store";
    const allOrders = full.orders || [];

    // Filter to the orders of the day the report covers
    const todayOrders = allOrders.filter(o => o.dateKey === reportKey);

    // "Don't send on days with no sales": remember it as handled so the next run doesn't look again
    if (os.reportSkipEmpty && !todayOrders.some(o => o.status === "paid")) {
      await markSent(row.store_id, due);
      results.skipped++;
      continue;
    }

    const allProducts = full.products || [];
    const allStoreExpenses = os.storeExpenses || [];
    const payMethods = os.payMethods || [];
    const html = buildReportHtml(storeName, todayLabel, todayOrders, allProducts, allStoreExpenses, reportKey, payMethods);
    const subject = `Daily Sales Report — ${todayLabel} · ${storeName}`;

    // Detailed PDF: if it can't be built the summary email still goes out without it.
    let attachments;
    try {
      const content = await buildDailyReportPdf({
        storeName, dateLabel: todayLabel, reportKey,
        orders: todayOrders, products: allProducts, storeExpenses: allStoreExpenses, payMethods,
      });
      attachments = [{ filename: dailyReportPdfName(reportKey, storeName), content }];
    } catch (e) {
      console.error(`[daily-report] PDF failed for store ${row.store_id}:`, e?.message || e);
    }

    try {
      const ok = await sendEmail(recipients, subject, html, attachments);
      if (ok) {
        await markSent(row.store_id, due);
        results.sent++;
        console.log(`[daily-report] Sent to ${recipients.join(", ")} for store ${row.store_id}`);
      } else {
        results.errors++;
        console.error(`[daily-report] Resend failed for store ${row.store_id}`);
      }
    } catch (e) {
      results.errors++;
      console.error(`[daily-report] Error for store ${row.store_id}:`, e);
    }
  }

  console.log(`[daily-report] Done. sent=${results.sent} skipped=${results.skipped} errors=${results.errors}`);
  return res.status(200).json({ ok: true, ...results });
}
