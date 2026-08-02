// Vercel Cron Function — /api/daily-report
//
// Runs at 16:00 UTC daily (= midnight Philippine Time, UTC+8).
// For each active store with reportEnabled, sends a daily sales summary
// covering "today so far" in PHT (orders from midnight PHT up to send time).
// Uses the Supabase SERVICE key — never the anon key.

const SUPA_URL         = process.env.SUPA_URL         || process.env.VITE_SUPA_URL;
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const RESEND_KEY       = process.env.RESEND_KEY;

// PHT = UTC + 8 hours
const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;

function phtNow() {
  return new Date(Date.now() + PHT_OFFSET_MS);
}

// "YYYY-MM-DD" in PHT
function phtDateKey(d) {
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dy}`;
}

function fmtPeso(n) {
  return "₱" + (Number(n) || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

async function sendEmail(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_KEY}`,
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

function buildReportHtml(storeName, todayLabel, orders, products) {
  const paid = orders.filter(o => o.status === "paid");
  const totalSales = paid.reduce((s, o) => s + (o.total || 0), 0);
  const orderCount = paid.length;
  const avgOrder   = orderCount > 0 ? totalSales / orderCount : 0;

  // Payment method breakdown
  const byMethod = {};
  paid.forEach(o => {
    const m = o.payMethod || "cash";
    byMethod[m] = (byMethod[m] || 0) + (o.total || 0);
  });
  const methodRows = Object.entries(byMethod)
    .sort((a, b) => b[1] - a[1])
    .map(([m, amt]) =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;text-transform:capitalize">${m}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:700;text-align:right">${fmtPeso(amt)}</td>
      </tr>`
    ).join("");

  // Top 5 products by qty
  const productQty = {};
  paid.forEach(o => (o.items || []).forEach(it => {
    productQty[it.name] = (productQty[it.name] || 0) + (it.qty || 1);
  }));
  const topProducts = Object.entries(productQty)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const productRows = topProducts.map(([name, qty]) =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#374151">${name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:700;text-align:right">${qty}</td>
    </tr>`
  ).join("");

  // Stock alerts — out of stock or at/below lowStockAt threshold
  const stockAlerts = (products||[])
    .filter(p => p.active !== false && p.stockMode !== "none")
    .filter(p => {
      const stock = Number(p.stock || 0);
      const threshold = p.lowStockAt != null ? Number(p.lowStockAt) : 5;
      return stock <= threshold;
    })
    .sort((a,b) => Number(a.stock||0) - Number(b.stock||0));

  const stockAlertRows = stockAlerts.map(p => {
    const stock = Number(p.stock||0);
    const isOut = stock <= 0;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#374151">${p.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;color:#6b7280;font-size:12px">${p.category||'—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;color:${isOut?'#dc2626':'#d97706'}">${isOut?'Out of stock':`${stock} ${p.stockUnit||'pcs'} left`}</td>
    </tr>`;
  }).join('');

  // Starred / bestseller products with current stock
  const starredProducts = (products||[])
    .filter(p => p.isBestseller && p.active !== false)
    .sort((a,b) => (b.stock||0) - (a.stock||0));

  // Build a qty-sold-today map from today's orders
  const soldTodayMap = {};
  paid.forEach(o => (o.items||[]).forEach(it => {
    soldTodayMap[it.name] = (soldTodayMap[it.name]||0) + (it.qty||1);
  }));

  const starredRows = starredProducts.map(p => {
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

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#0F172A;border-radius:12px;padding:18px;text-align:center;margin-bottom:24px">
        <img src="https://owner.nj-systems.com/email-logo.png" alt="NJ POS" width="183" height="55" style="display:block;margin:0 auto"/>
        <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:6px">${storeName}</div>
      </div>

      <h2 style="font-size:16px;color:#111;margin:0 0 4px">Daily Sales Report</h2>
      <p style="color:#9ca3af;font-size:12px;margin:0 0 20px">${todayLabel}</p>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px">
        <div style="background:#f0fdf4;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Total Sales</div>
          <div style="font-size:22px;font-weight:800;color:#059669">${fmtPeso(totalSales)}</div>
        </div>
        <div style="background:#eff6ff;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Orders</div>
          <div style="font-size:22px;font-weight:800;color:#2563EB">${orderCount}</div>
        </div>
        <div style="background:#faf5ff;border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:10px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Avg Order</div>
          <div style="font-size:22px;font-weight:800;color:#7c3aed">${orderCount > 0 ? fmtPeso(avgOrder) : "—"}</div>
        </div>
      </div>

      ${methodRows ? `
      <h3 style="font-size:13px;color:#374151;margin:0 0 8px">Payment Methods</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #f3f4f6">
        ${methodRows}
      </table>` : ""}

      ${productRows ? `
      <h3 style="font-size:13px;color:#374151;margin:0 0 8px">Top Products</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #f3f4f6">
        <thead>
          <tr style="background:#f9fafb">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:700">Product</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:700">Qty Sold</th>
          </tr>
        </thead>
        <tbody>${productRows}</tbody>
      </table>` : ""}

      ${stockAlertRows ? `
      <h3 style="font-size:13px;color:#dc2626;margin:0 0 8px">⚠️ Stock Alerts</h3>
      <p style="font-size:11px;color:#9ca3af;margin:0 0 8px">Products at or below low stock threshold</p>
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

      ${starredRows ? `
      <h3 style="font-size:13px;color:#374151;margin:0 0 8px">⭐ Starred Products</h3>
      <p style="font-size:11px;color:#9ca3af;margin:0 0 8px">Your marked bestseller products and their current stock</p>
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
        Sent automatically by NJ POS · ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
        <br>To change your report schedule: POS app → Settings → Order Settings → Scheduled Daily Report
      </p>
    </div>`;
}

export default async function handler(req, res) {
  // Vercel cron requests are GET with a special header.
  // Also allow POST for manual testing from the owner portal or curl.
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // No auth check — Vercel cron runner uses GET, manual trigger uses POST

  if (!SUPA_URL || !SUPA_SERVICE_KEY) {
    return res.status(500).json({ error: "Supabase not configured" });
  }
  if (!RESEND_KEY) {
    return res.status(500).json({ error: "Resend not configured" });
  }

  const pht        = phtNow();
  const todayKey   = phtDateKey(pht);
  // The cron fires at midnight PHT — "today" has just started and has no orders yet.
  // The report should cover yesterday (the day that just ended).
  const yesterday  = new Date(pht.getTime() - 24*60*60*1000);
  const reportKey  = phtDateKey(yesterday);
  const todayLabel = yesterday.toLocaleDateString("en-PH", {
    timeZone: "UTC",
    month: "long", day: "numeric", year: "numeric",
  });

  console.log(`[daily-report] Cron fired. Reporting on: ${reportKey}`);

  // Fetch all store_data rows that have order_settings + orders.
  // We select only what we need to keep the payload small.
  const rows = await supaGet(
    "store_data?select=store_id,order_settings,orders,products,theme"
  );
  if (!rows) {
    return res.status(500).json({ error: "Failed to fetch store_data" });
  }

  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const row of rows) {
    const os = row.order_settings || {};

    // Skip stores that haven't opted in
    if (!os.reportEnabled)              { results.skipped++; continue; }
    if (!os.reportEmail?.includes("@")) { results.skipped++; continue; }

    // Already sent today's report?
    if (os.lastReportSentDate === todayKey) { results.skipped++; continue; }

    const storeName = row.theme?.storeName || "My Store";
    const allOrders = row.orders || [];

    // Filter to yesterday's orders (the day the report covers)
    const todayOrders = allOrders.filter(o => o.dateKey === reportKey);

    const allProducts = row.products || [];
    const html = buildReportHtml(storeName, todayLabel, todayOrders, allProducts);
    const subject = `Daily Sales Report — ${todayLabel} · ${storeName}`;

    try {
      const ok = await sendEmail(os.reportEmail, subject, html);
      if (ok) {
        // Write lastReportSentDate back so we don't double-send this hour
        const updatedOs = { ...os, lastReportSentDate: todayKey };
        await supaUpdateOrderSettings(row.store_id, updatedOs);
        results.sent++;
        console.log(`[daily-report] Sent to ${os.reportEmail} for store ${row.store_id}`);
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
