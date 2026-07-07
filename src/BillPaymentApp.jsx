import { useState, useEffect } from "react";

const QR_IMAGE_URL = "/gcash-qr.jpg";
const GCASH_NUMBER = "0956-013-7170";
const LANDING_PAGE_URL = "https://www.pospro-portal.com";

const fmt = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BillPaymentApp() {
  const params = new URLSearchParams(window.location.search);
  const storeId = params.get("store") || "";
  const storeName = params.get("storeName") || "your store";
  const lockedAmount = Number(params.get("amount")) || 0;
  // Breakdown travels as base64-encoded JSON in the link, exactly the
  // same line items shown in the reminder email — not re-fetched from
  // the store's current live billing data, since that could have
  // changed between when the email was sent and when this gets opened.
  // What the customer sees here is guaranteed to match what they were
  // actually told, and it's read-only for the same reason.
  let breakdown = [];
  try {
    const raw = params.get("breakdown");
    if (raw) breakdown = JSON.parse(atob(decodeURIComponent(raw)));
  } catch { breakdown = []; }

  const [email, setEmail] = useState("");
  const [screenshotPreview, setScreenshotPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [redirectIn, setRedirectIn] = useState(10);

  useEffect(() => {
    if (!done) return;
    if (redirectIn <= 0) { window.location.href = LANDING_PAGE_URL; return; }
    const t = setTimeout(() => setRedirectIn(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [done, redirectIn]);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setScreenshotPreview(reader.result);
    reader.readAsDataURL(f);
  };

  const copyGcash = () => navigator.clipboard.writeText(GCASH_NUMBER);
  const downloadQr = () => {
    const a = document.createElement("a");
    a.href = QR_IMAGE_URL;
    a.download = "pospro-gcash-qr.jpg";
    a.click();
  };

  const submit = async () => {
    setError("");
    if (!email.trim() || !/\S+@\S+\.\S+/.test(email)) { setError("Enter a valid email address"); return; }
    if (!screenshotPreview) { setError("Upload your payment screenshot"); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/submit-bill-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          storeName,
          customerEmail: email.trim(),
          amount: lockedAmount,
          breakdown,
          screenshotBase64: screenshotPreview,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setError(data.error || "Something went wrong. Please try again."); setSubmitting(false); return; }
      setDone(true);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setSubmitting(false);
  };

  // A store link missing entirely (someone opened this with no
  // parameters at all, not a real link from a reminder email) shouldn't
  // show a confusing broken form.
  if (!storeId || !lockedAmount) {
    return (
      <div style={{ minHeight: "100vh", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: 24, textAlign: "center" }}>
        <div>
          <h2 style={{ color: "#111" }}>This link looks incomplete</h2>
          <p style={{ color: "#6b7280", fontSize: 14 }}>Please use the "Pay Now" link from your payment reminder email.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", boxSizing: "border-box", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: "40px 16px" }}>
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, overflow: "hidden", margin: "0 auto 12px" }}>
            <img src="/icons/icon-192.png" alt="POS Pro" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#111" }}>POS Pro</div>
        </div>

        <div style={{ background: "#fff", borderRadius: 18, padding: "30px 26px", boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
          {!done ? (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 19 }}>Pay Your Bill</h2>
              <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>For <b>{storeName}</b></p>

              <div style={{ background: "#f5f3ff", border: "1px solid #e0e7ff", borderRadius: 12, padding: 18, marginBottom: 22 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 10 }}>Amount Due</div>
                {breakdown.length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <tbody>
                      {breakdown.map((item, i) => (
                        <tr key={i}>
                          <td style={{ padding: "4px 0", fontSize: 14, color: "#374151" }}>{item.label}</td>
                          <td style={{ padding: "4px 0", fontSize: 14, color: "#374151", textAlign: "right", whiteSpace: "nowrap" }}>{fmt(item.amount)}</td>
                        </tr>
                      ))}
                      <tr><td colSpan={2} style={{ borderTop: "1px solid #ddd6fe", paddingTop: 8 }} /></tr>
                      <tr>
                        <td style={{ fontWeight: 800, fontSize: 16, color: "#111" }}>Total</td>
                        <td style={{ fontWeight: 800, fontSize: 16, color: "#4f46e5", textAlign: "right", whiteSpace: "nowrap" }}>{fmt(lockedAmount)}</td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <div style={{ fontWeight: 800, fontSize: 24, color: "#4f46e5", textAlign: "center" }}>{fmt(lockedAmount)}</div>
                )}
              </div>

              <div style={{ textAlign: "center", marginBottom: 22 }}>
                <img src={QR_IMAGE_URL} alt="GCash QR" style={{ width: 200, height: 200, borderRadius: 12, border: "1px solid #e5e7eb" }} />
                <div style={{ marginTop: 10, fontSize: 14, fontWeight: 700, color: "#374151" }}>
                  GCash: {GCASH_NUMBER}
                  <button onClick={copyGcash} title="Copy number" style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "#4f46e5", verticalAlign: "middle" }}>
                    <i className="ti ti-copy" />
                  </button>
                </div>
                <button onClick={downloadQr} style={{ marginTop: 8, background: "none", border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, color: "#374151", cursor: "pointer" }}>
                  <i className="ti ti-download" style={{ marginRight: 4 }} />Download QR
                </button>
              </div>

              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>Your Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 14, marginBottom: 16, boxSizing: "border-box" }} />

              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>Payment Screenshot</label>
              {!screenshotPreview ? (
                <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: "2px dashed #e5e7eb", borderRadius: 10, padding: "22px 0", cursor: "pointer", color: "#6b7280", fontSize: 13, fontWeight: 700 }}>
                  <i className="ti ti-upload" />Tap to upload screenshot
                  <input type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
                </label>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <img src={screenshotPreview} alt="" style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", border: "1px solid #e5e7eb" }} />
                  <button onClick={() => setScreenshotPreview(null)} style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 12 }}>Remove</button>
                </div>
              )}

              {error && <div style={{ marginTop: 14, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#b91c1c", fontSize: 13 }}>{error}</div>}

              <button onClick={submit} disabled={submitting} style={{ width: "100%", marginTop: 20, padding: "13px 0", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", opacity: submitting ? 0.7 : 1 }}>
                {submitting ? "Submitting…" : "Complete Payment"}
              </button>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f0fdf4", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
                <i className="ti ti-check" style={{ fontSize: 32, color: "#16a34a" }} />
              </div>
              <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Thank you!</h2>
              <p style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
                We've received your payment for <b>{storeName}</b>. Once confirmed, your account stays active — no further action needed.
              </p>
              <button onClick={() => window.location.href = LANDING_PAGE_URL} style={{ marginTop: 20, padding: "12px 28px", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
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
