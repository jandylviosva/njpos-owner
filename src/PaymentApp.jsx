import { useState, useEffect } from "react";

// ── PRICING ──
// Base plan price is per-month for "monthly", one-time for "lifetime".
// Extra device slots: ₱149 either way — recurring per month on the
// monthly plan, a single one-time charge on lifetime (same number,
// different billing cadence). Invoice/Purchase Orders/Kitchen Ticket/
// Open Bills are always a flat ₱99 one-time add-on, regardless of
// which base plan was chosen.
const PLAN_PRICE = { monthly: 399, lifetime: 8999 };
const DEVICE_PRICE = 149;
const FEATURE_PRICE = 99;
const FEATURES = [
  { key: "invoice",   label: "Invoicing Module",        desc: "Create and track customer invoices with payment status" },
  { key: "po",        label: "Purchase Orders Module",   desc: "Manage supplier POs, deliveries & auto stock receiving" },
  { key: "kitchen",   label: "Kitchen Ticket Printing",  desc: "Print a kitchen order ticket below each customer receipt" },
  { key: "openBills", label: "Open Bills",               desc: "Save an order as a tab and come back to pay it later" },
];

const QR_IMAGE_URL = "/gcash-qr.jpg";
const GCASH_NUMBER = "0956-013-7170";

function computeBreakdown(plan, addons) {
  const items = [];
  items.push({
    label: plan === "monthly" ? "Standard Plan (Monthly)" : "Lifetime Plan (One-time)",
    amount: PLAN_PRICE[plan],
  });
  if (addons.devices > 0) {
    items.push({
      label: plan === "monthly"
        ? `Extra Device Slot × ${addons.devices} (₱${DEVICE_PRICE}/mo each)`
        : `Extra Device Slot × ${addons.devices} (one-time)`,
      amount: DEVICE_PRICE * addons.devices,
    });
  }
  FEATURES.forEach(f => {
    if (addons[f.key]) items.push({ label: `${f.label} (one-time)`, amount: FEATURE_PRICE });
  });
  const total = items.reduce((s, i) => s + i.amount, 0);
  return { items, total };
}

const fmt = (n) => `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StepDots({ step }) {
  const steps = ["Plan", "Add-ons", "Review", "Payment"];
  const idx = { plan: 0, addons: 1, review: 2, details: 3, done: 3 }[step];
  return (
    <>
      <style>{`
        @media (max-width: 480px) {
          .step-label { display: none; }
          .step-connector { width: 14px !important; }
          .step-dots-row { gap: 4px !important; }
        }
      `}</style>
      <div className="step-dots-row" style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginBottom: 28, flexWrap: "nowrap" }}>
        {steps.map((label, i) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <div style={{
              width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, fontWeight: 800, color: i <= idx ? "#fff" : "#9ca3af", flexShrink: 0,
              background: i <= idx ? "#2563EB" : "#e5e7eb",
            }}>{i < idx ? "✓" : i + 1}</div>
            <span className="step-label" style={{ fontSize: 12, fontWeight: 700, color: i <= idx ? "#111" : "#9ca3af", whiteSpace: "nowrap" }}>{label}</span>
            {i < steps.length - 1 && <div className="step-connector" style={{ width: 24, height: 2, background: i < idx ? "#2563EB" : "#e5e7eb", marginLeft: 4, flexShrink: 0 }} />}
          </div>
        ))}
      </div>
    </>
  );
}

export default function PaymentApp() {
  const params = new URLSearchParams(window.location.search);
  const initialPlan = params.get("plan") === "lifetime" ? "lifetime" : "monthly";

  const [step, setStep] = useState("plan");
  const LANDING_PAGE_URL = "https://www.nj-systems.com";
  const [redirectIn, setRedirectIn] = useState(10);
  useEffect(() => {
    if (step !== "done") return;
    if (redirectIn <= 0) { window.location.href = LANDING_PAGE_URL; return; }
    const t = setTimeout(() => setRedirectIn(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [step, redirectIn]);
  const [plan, setPlan] = useState(initialPlan);
  const [addons, setAddons] = useState({ devices: 0, invoice: false, po: false, kitchen: false, openBills: false });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [storeName, setStoreName] = useState("");
  const [screenshotPreview, setScreenshotPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const { items, total } = computeBreakdown(plan, addons);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setScreenshotPreview(reader.result);
    reader.readAsDataURL(f);
  };

  const copyGcash = () => {
    navigator.clipboard.writeText(GCASH_NUMBER);
  };

  const downloadQr = () => {
    const a = document.createElement("a");
    a.href = QR_IMAGE_URL;
    a.download = "njpos-gcash-qr.jpg";
    a.click();
  };

  const submit = async () => {
    setError("");
    if (!name.trim()) { setError("Enter your name"); return; }
    if (!email.trim() || !/\S+@\S+\.\S+/.test(email)) { setError("Enter a valid email address"); return; }
    if (!storeName.trim()) { setError("Enter your store name"); return; }
    if (!screenshotPreview) { setError("Upload your payment screenshot"); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/submit-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: name.trim(),
          customerEmail: email.trim(),
          storeName: storeName.trim(),
          plan,
          addons,
          breakdown: items,
          amount: total,
          screenshotBase64: screenshotPreview,
        }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error || "Something went wrong. Please try again."); setSubmitting(false); return; }
      setStep("done");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setSubmitting(false);
  };

  const cardStyle = (selected) => ({
    flex: 1, minWidth: 220, border: `2px solid ${selected ? "#2563EB" : "#e5e7eb"}`, borderRadius: 14,
    padding: 22, cursor: "pointer", background: selected ? "#f5f3ff" : "#fff", textAlign: "left",
  });

  return (
    <div style={{ minHeight: "100vh", boxSizing: "border-box", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: "40px 16px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, overflow: "hidden", margin: "0 auto 12px" }}>
            <img src="/icons/icon-192.png" alt="NJ POS" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#111" }}>NJ POS</div>
        </div>

        {step !== "done" && <StepDots step={step} />}

        <div style={{ background: "#fff", borderRadius: 18, padding: "30px 26px", boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>

          {/* ── STEP 1: PLAN ── */}
          {step === "plan" && (
            <>
              <h2 style={{ margin: "0 0 6px", fontSize: 19 }}>Choose your plan</h2>
              <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>You can add extra devices or modules on the next step.</p>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
                <button style={cardStyle(plan === "monthly")} onClick={() => setPlan("monthly")}>
                  <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>Standard</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: "#2563EB" }}>₱399<span style={{ fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>/mo</span></div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>Billed monthly, cancel anytime</div>
                </button>
                <button style={cardStyle(plan === "lifetime")} onClick={() => setPlan("lifetime")}>
                  <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>Lifetime</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: "#2563EB" }}>₱8,999</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>One-time payment, yours forever</div>
                </button>
              </div>
              <button onClick={() => setStep("addons")} style={{ width: "100%", padding: "13px 0", background: "#2563EB", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                Continue
              </button>
            </>
          )}

          {/* ── STEP 2: ADD-ONS ── */}
          {step === "addons" && (
            <>
              <h2 style={{ margin: "0 0 6px", fontSize: 19 }}>Add-ons (optional)</h2>
              <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>Skip this if you just want the base plan — you can always add these later.</p>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: "1px solid #f0f0f0" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Extra Device Slots</div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>{plan === "monthly" ? `₱${DEVICE_PRICE}/mo each` : `₱${DEVICE_PRICE} one-time each`}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => setAddons(a => ({ ...a, devices: Math.max(0, a.devices - 1) }))} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", fontSize: 16 }}>−</button>
                  <span style={{ fontWeight: 800, fontSize: 15, minWidth: 16, textAlign: "center" }}>{addons.devices}</span>
                  <button onClick={() => setAddons(a => ({ ...a, devices: a.devices + 1 }))} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", fontSize: 16 }}>+</button>
                </div>
              </div>

              {FEATURES.map(f => (
                <label key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0", borderBottom: "1px solid #f0f0f0", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <input type="checkbox" checked={!!addons[f.key]} onChange={e => setAddons(a => ({ ...a, [f.key]: e.target.checked }))} style={{ width: 18, height: 18 }} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{f.label}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>{f.desc}</div>
                    </div>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: "#2563EB", whiteSpace: "nowrap" }}>{fmt(FEATURE_PRICE)}</div>
                </label>
              ))}

              <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
                <button onClick={() => setStep("plan")} style={{ flex: 1, padding: "13px 0", background: "#fff", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Back</button>
                <button onClick={() => setStep("review")} style={{ flex: 2, padding: "13px 0", background: "#2563EB", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer" }}>Continue</button>
              </div>
            </>
          )}

          {/* ── STEP 3: REVIEW / BREAKDOWN ── */}
          {step === "review" && (
            <>
              <h2 style={{ margin: "0 0 6px", fontSize: 19 }}>Review your order</h2>
              <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>Here's exactly what you're paying for.</p>
              {items.map((it, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f0f0f0", fontSize: 14 }}>
                  <span style={{ color: "#374151" }}>{it.label}</span>
                  <span style={{ fontWeight: 700 }}>{fmt(it.amount)}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "16px 0 0", fontSize: 17 }}>
                <span style={{ fontWeight: 800 }}>Total</span>
                <span style={{ fontWeight: 800, color: "#2563EB" }}>{fmt(total)}</span>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
                <button onClick={() => setStep("addons")} style={{ flex: 1, padding: "13px 0", background: "#fff", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Back</button>
                <button onClick={() => setStep("details")} style={{ flex: 2, padding: "13px 0", background: "#2563EB", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer" }}>Proceed to Payment</button>
              </div>
            </>
          )}

          {/* ── STEP 4: PAYMENT DETAILS ── */}
          {step === "details" && (
            <>
              <h2 style={{ margin: "0 0 6px", fontSize: 19 }}>Complete your payment</h2>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f5f3ff", borderRadius: 10, padding: "12px 16px", marginBottom: 20 }}>
                <span style={{ fontSize: 13, color: "#2563EB", fontWeight: 700 }}>Total to pay</span>
                <span style={{ fontSize: 20, fontWeight: 800, color: "#2563EB" }}>{fmt(total)}</span>
              </div>

              <div style={{ textAlign: "center", marginBottom: 18 }}>
                <img src={QR_IMAGE_URL} alt="GCash QR" style={{ width: 220, height: 220, borderRadius: 12, border: "1px solid #e5e7eb" }} />
                <div style={{ marginTop: 10, fontSize: 15, fontWeight: 700, color: "#111" }}>
                  GCash: {GCASH_NUMBER}
                  <button onClick={copyGcash} title="Copy number" style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "#2563EB", verticalAlign: "middle" }}>
                    <i className="ti ti-copy" />
                  </button>
                </div>
                <button onClick={downloadQr} style={{ marginTop: 8, padding: "6px 14px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12, fontWeight: 700, color: "#374151", cursor: "pointer" }}>
                  <i className="ti ti-download" style={{ marginRight: 5 }} />Download QR
                </button>
              </div>

              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 18, lineHeight: 1.6 }}>
                1. Pay {fmt(total)} via the QR code or GCash number above.<br />
                2. Fill in your details below and upload your payment screenshot.<br />
                3. We'll email you your activation code once we've confirmed your payment.
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={inputStyle} />
                <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address (required)" type="email" style={inputStyle} />
                <input value={storeName} onChange={e => setStoreName(e.target.value)} placeholder="Store name" style={inputStyle} />
                <div>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px dashed #d1d5db", borderRadius: 10, cursor: "pointer" }}>
                    <i className="ti ti-upload" style={{ color: "#2563EB" }} />
                    <span style={{ fontSize: 13, color: screenshotPreview ? "#111" : "#9ca3af" }}>{screenshotPreview ? "Screenshot attached ✓" : "Upload payment screenshot (required)"}</span>
                    <input type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
                  </label>
                  {screenshotPreview && <img src={screenshotPreview} alt="" style={{ marginTop: 8, width: 70, height: 70, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }} />}
                </div>
              </div>

              {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 8, padding: "10px 12px", fontSize: 12, marginBottom: 14 }}>{error}</div>}

              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setStep("review")} style={{ flex: 1, padding: "13px 0", background: "#fff", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Back</button>
                <button onClick={submit} disabled={submitting} style={{ flex: 2, padding: "13px 0", background: "#2563EB", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", opacity: submitting ? 0.7 : 1 }}>
                  {submitting ? "Submitting…" : "Complete Payment"}
                </button>
              </div>
            </>
          )}

          {/* ── STEP 5: DONE ── */}
          {step === "done" && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f0fdf4", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
                <i className="ti ti-check" style={{ fontSize: 32, color: "#16a34a" }} />
              </div>
              <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Thank you!</h2>
              <p style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
                We've received your submission. Once we confirm your payment, you'll get an email with your activation code — usually within a few hours.
              </p>
              <button onClick={() => window.location.href = LANDING_PAGE_URL} style={{ marginTop: 20, padding: "12px 28px", background: "#2563EB", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                Return to Homepage
              </button>
              <p style={{ color: "#9ca3af", fontSize: 12, marginTop: 14 }}>Redirecting automatically in {redirectIn}s…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const inputStyle = { padding: "11px 14px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 14, outline: "none" };
