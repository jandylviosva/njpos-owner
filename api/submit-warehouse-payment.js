// Vercel Serverless Function — /api/submit-warehouse-payment
// A new customer buys an NJ Warehouse registration code: they pay by GCash on /warehouse-payment, upload the
// screenshot, and the payment arrives in the developer console (Payments) as pending. After checking it, the
// developer presses "Create & send code" there. The amount is worked out here, never trusted from the page.
import { setCorsHeaders, supaTable, uploadScreenshot, sendWarehouseEmail, emailFrame, isEmail, esc, peso, priceFor, cleanDevices, OWNER_NOTIFY_EMAIL, BASE_PRICE, EXTRA_DEVICE_PRICE } from "./_warehouseSignup.js";

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { businessName, ownerName, customerEmail, devices, screenshotBase64 } = req.body || {};
  const mail = String(customerEmail || "").trim().toLowerCase();
  const biz = String(businessName || "").trim().slice(0, 120);
  const who = String(ownerName || "").trim().slice(0, 80);
  if (!biz || !who) return res.status(400).json({ error: "Enter your name and business name." });
  if (!isEmail(mail)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!screenshotBase64) return res.status(400).json({ error: "Upload your payment screenshot." });

  const n = cleanDevices(devices);
  const amount = priceFor(n);

  let screenshotPath;
  try { screenshotPath = await uploadScreenshot(screenshotBase64); }
  catch (e) { return res.status(400).json({ error: e.message || "Failed to upload the screenshot." }); }

  const notes = `NJ Warehouse - ${n} device${n === 1 ? "" : "s"}\nBusiness: ${biz}\nOwner: ${who}\n${peso(BASE_PRICE)} + ${n - 1} x ${peso(EXTRA_DEVICE_PRICE)}`;
  const created = await supaTable("payment_records", "", {
    method: "POST",
    body: JSON.stringify([{ source: "landing_page", customer_name: biz, customer_email: mail, store_name: biz, amount, plan: "warehouse_monthly", method: "GCash", notes, screenshot_url: screenshotPath, status: "pending" }]),
  });
  if (!created.ok) return res.status(500).json({ error: "Could not record your payment. Please try again." });

  // to the customer: we got it
  sendWarehouseEmail({ to: mail, subject: "We received your NJ Warehouse payment", html: emailFrame(`
    <h2 style="color:#111">Thank you, we received your payment</h2>
    <p style="color:#374151;font-size:15px;line-height:1.6">Hi ${esc(who)}, we received your GCash payment of <b>${peso(amount)}</b> for <b>${esc(biz)}</b> (${n} device${n === 1 ? "" : "s"}).</p>
    <p style="color:#374151;font-size:15px;line-height:1.6">We will check it and email your <b>registration code</b> to this address, usually within a few hours. Then open <a href="https://warehouse.nj-systems.com" style="color:#2563EB">warehouse.nj-systems.com</a>, choose Register and enter the code.</p>`) }).catch(() => {});
  // to the owner: a payment to check
  sendWarehouseEmail({ to: OWNER_NOTIFY_EMAIL, subject: `NJ Warehouse payment — ${biz} (${peso(amount)})`, html: emailFrame(`
    <h2 style="color:#111;font-size:18px">New NJ Warehouse payment</h2>
    <p style="color:#374151;font-size:14px;line-height:1.7"><b>${esc(biz)}</b> · ${esc(who)} · <a href="mailto:${esc(mail)}">${esc(mail)}</a><br/>${n} device${n === 1 ? "" : "s"} · <b>${peso(amount)}</b> by GCash</p>
    <p style="color:#6b7280;font-size:13px">Check the screenshot in Dev Console, Payments, then press Create &amp; send code.</p>`) }).catch(() => {});

  return res.status(200).json({ ok: true, amount });
}
