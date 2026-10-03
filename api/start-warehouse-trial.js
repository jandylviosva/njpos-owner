// Vercel Serverless Function — /api/start-warehouse-trial
// Called from the landing page ("Get NJ Warehouse" > Free trial). Creates a trial registration code
// (warehouse_licenses with trial_days; the 3 days start when the code is used to register) and emails it.
// One trial per email address. Needs supabase-warehouse-trials.sql (nj-warehouse repo).
import { setCorsHeaders, supaTable, genCode, isEmail, sendWarehouseEmail, trialEmailHtml, esc, OWNER_NOTIFY_EMAIL, emailFrame, TRIAL_DAYS, dbEnv } from "./_warehouseSignup.js";

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, businessName, ownerName } = req.body || {};
  const mail = String(email || "").trim().toLowerCase();
  const biz = String(businessName || "").trim().slice(0, 120);
  const who = String(ownerName || "").trim().slice(0, 80);
  if (!isEmail(mail) || !biz || !who) return res.status(400).json({ error: "Enter your name, business name and a valid email." });
  const { url, key } = dbEnv();
  if (!url || !key) return res.status(500).json({ error: "Database not configured" });
  if (!process.env.RESEND_KEY) return res.status(500).json({ error: "Email service not configured" });

  try {
    // one trial per email, and no trial for an email that already has a warehouse
    const used = await supaTable("warehouse_licenses", `?trial_email=eq.${encodeURIComponent(mail)}&select=id&limit=1`, { method: "GET" });
    if (!used.ok) return res.status(500).json({ error: "Free trials aren't available right now. Please contact us." });
    if ((await used.json()).length) return res.status(409).json({ error: "This email already used a free trial. Contact us or get a plan to continue." });
    const has = await supaTable("warehouse_accounts", `?email=eq.${encodeURIComponent(mail)}&select=id&limit=1`, { method: "GET" });
    if (has.ok && (await has.json()).length) return res.status(409).json({ error: "A warehouse is already registered with this email. Sign in at warehouse.nj-systems.com." });

    let lic = null;
    for (let attempt = 0; attempt < 5 && !lic; attempt++) {
      const r = await supaTable("warehouse_licenses", "", {
        method: "POST",
        body: JSON.stringify([{ code: genCode("TRIAL"), max_devices: 1, status: "unused", trial_days: TRIAL_DAYS, trial_email: mail, notes: `Free trial - ${who} - ${biz} - ${mail}`, created_by: "landing_trial" }]),
      });
      if (r.ok) lic = (await r.json())[0];
      else if (r.status !== 409) return res.status(500).json({ error: "Could not create your trial code. Please try again." });
    }
    if (!lic) return res.status(500).json({ error: "Could not create your trial code. Please try again." });

    const sent = await sendWarehouseEmail({ to: mail, subject: "Your NJ Warehouse free trial code", html: trialEmailHtml({ code: lic.code, ownerName: who }) });
    if (!sent) {
      await supaTable("warehouse_licenses", `?id=eq.${encodeURIComponent(lic.id)}`, { method: "DELETE" });   // nobody got the code: don't leave it behind
      return res.status(500).json({ error: "We couldn't send the email. Please check the address and try again." });
    }
    // heads-up to the owner (not important if it fails)
    sendWarehouseEmail({ to: OWNER_NOTIFY_EMAIL, subject: `New NJ Warehouse trial — ${biz}`, html: emailFrame(`<h2 style="color:#111;font-size:18px">New NJ Warehouse free trial</h2><p style="color:#374151;font-size:14px;line-height:1.7"><b>${esc(biz)}</b><br/>${esc(who)} · ${esc(mail)}<br/>Code: <b style="font-family:monospace">${esc(lic.code)}</b> (${TRIAL_DAYS} days from registration)</p>`) }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[start-warehouse-trial]", e);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
