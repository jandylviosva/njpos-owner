import { useState } from "react";

const QR_IMAGE_URL = "/gcash-qr.jpg";
const GCASH_NUMBER = "0956-013-7170";
const LANDING_PAGE_URL = "https://www.nj-systems.com/#warehouse";
const BASE = 199, EXTRA = 99, MAX = 20;
const fmt = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const INPUT = { width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 14, marginBottom: 14, boxSizing: "border-box" };
const LABEL = { display: "block", fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 };

export default function WarehousePaymentApp() {
  const [business, setBusiness] = useState("");
  const [owner, setOwner] = useState("");
  const [email, setEmail] = useState("");
  const [devices, setDevices] = useState(1);
  const [shot, setShot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const total = BASE + (devices - 1) * EXTRA;
  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setShot(reader.result);
    reader.readAsDataURL(f);
  };
  const submit = async () => {
    setError("");
    if (!owner.trim() || !business.trim()) { setError("Enter your name and your business name"); return; }
    if (!/\S+@\S+\.\S+/.test(email)) { setError("Enter a valid email address"); return; }
    if (!shot) { setError("Upload your payment screenshot"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/submit-warehouse-payment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName: business.trim(), ownerName: owner.trim(), customerEmail: email.trim(), devices, screenshotBase64: shot }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setError(data.error || "Something went wrong. Please try again."); setBusy(false); return; }
      setDone(true);
    } catch { setError("Couldn't reach the server. Check your connection and try again."); }
    setBusy(false);
  };

  return (
    <div style={{ minHeight: "100vh", boxSizing: "border-box", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: "40px 16px" }}>
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, overflow: "hidden", margin: "0 auto 12px" }}><img src="/icons/icon-192.png" alt="NJ Warehouse" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
          <div style={{ fontFamily: "'Michroma',sans-serif", fontSize: 18, letterSpacing: 1 }}><span style={{ color: "#2563EB" }}>NJ</span><span style={{ color: "#0F172A" }}>WAREHOUSE</span></div>
        </div>
        <div style={{ background: "#fff", borderRadius: 18, padding: "30px 26px", boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
          {!done ? (<>
            <h2 style={{ margin: "0 0 4px", fontSize: 19 }}>Get your registration code</h2>
            <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>Pay with GCash, upload the screenshot, and we email your code after checking it.</p>

            <label style={LABEL}>Your name</label>
            <input value={owner} onChange={e => setOwner(e.target.value)} placeholder="e.g. Maria Santos" style={INPUT} />
            <label style={LABEL}>Business name</label>
            <input value={business} onChange={e => setBusiness(e.target.value)} placeholder="e.g. Santos Trading" style={INPUT} />
            <label style={LABEL}>Email (your code is sent here)</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" style={INPUT} />

            <label style={LABEL}>How many devices?</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <button onClick={() => setDevices(d => Math.max(1, d - 1))} disabled={devices <= 1} style={{ width: 40, height: 40, borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", fontSize: 20, cursor: "pointer" }}>−</button>
              <div style={{ minWidth: 48, textAlign: "center", fontSize: 20, fontWeight: 800 }}>{devices}</div>
              <button onClick={() => setDevices(d => Math.min(MAX, d + 1))} disabled={devices >= MAX} style={{ width: 40, height: 40, borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", fontSize: 20, cursor: "pointer" }}>+</button>
              <div style={{ fontSize: 12, color: "#6b7280" }}>1 device included, {fmt(EXTRA)} for each extra</div>
            </div>

            <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 18, margin: "14px 0 22px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 10 }}>Amount to pay (first month)</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, color: "#374151" }}><tbody>
                <tr><td style={{ padding: "3px 0" }}>NJ Warehouse (1 device)</td><td style={{ textAlign: "right" }}>{fmt(BASE)}</td></tr>
                {devices > 1 && <tr><td style={{ padding: "3px 0" }}>Additional devices ({devices - 1} × {fmt(EXTRA)})</td><td style={{ textAlign: "right" }}>{fmt((devices - 1) * EXTRA)}</td></tr>}
                <tr><td colSpan={2} style={{ borderTop: "2px solid #bfdbfe", paddingTop: 8 }} /></tr>
                <tr><td style={{ fontWeight: 800, fontSize: 16, color: "#111" }}>Total</td><td style={{ fontWeight: 800, fontSize: 16, color: "#2563EB", textAlign: "right" }}>{fmt(total)}</td></tr>
              </tbody></table>
            </div>

            <div style={{ textAlign: "center", marginBottom: 22 }}>
              <img src={QR_IMAGE_URL} alt="GCash QR" style={{ width: 200, height: 200, borderRadius: 12, border: "1px solid #e5e7eb" }} />
              <div style={{ marginTop: 10, fontSize: 14, fontWeight: 700, color: "#374151" }}>
                GCash: {GCASH_NUMBER}
                <button onClick={() => navigator.clipboard.writeText(GCASH_NUMBER)} title="Copy number" style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "#2563EB" }}><i className="ti ti-copy" /></button>
              </div>
            </div>

            <label style={LABEL}>Payment screenshot</label>
            {!shot ? (
              <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: "2px dashed #e5e7eb", borderRadius: 10, padding: "22px 0", cursor: "pointer", color: "#6b7280", fontSize: 13 }}>
                <i className="ti ti-upload" />Tap to upload screenshot
                <input type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
              </label>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <img src={shot} alt="" style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", border: "1px solid #e5e7eb" }} />
                <button onClick={() => setShot(null)} style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 12 }}>Remove</button>
              </div>
            )}
            {error && <div style={{ marginTop: 14, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#b91c1c", fontSize: 13 }}>{error}</div>}
            <button onClick={submit} disabled={busy} style={{ width: "100%", marginTop: 20, padding: "13px 0", background: "#2563EB", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", opacity: busy ? 0.7 : 1 }}>{busy ? "Submitting…" : `Submit payment · ${fmt(total)}`}</button>
          </>) : (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f0fdf4", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}><i className="ti ti-check" style={{ fontSize: 32, color: "#16a34a" }} /></div>
              <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Thank you!</h2>
              <p style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>We received your payment. We'll check it and email your registration code to <b>{email}</b>, usually within a few hours.</p>
              <button onClick={() => { window.location.href = LANDING_PAGE_URL; }} style={{ marginTop: 20, padding: "12px 28px", background: "#2563EB", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer" }}>Back to NJ Warehouse</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
