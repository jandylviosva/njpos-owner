import { useState, useEffect, useMemo } from "react";

const fmtPeso = (n) => `\u20B1\u200A${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:0,maximumFractionDigits:2})}`;
const fmtHours = (mins) => { const h = Math.round((mins/60)*10)/10; return h % 1 === 0 ? String(h) : h.toFixed(1); };
const pricingBreakdown = (hourlyRate, durationMinutes) => {
  if (!hourlyRate || !durationMinutes) return null;
  return `${fmtPeso(hourlyRate)}/hr \u00D7 ${fmtHours(durationMinutes)} hr${fmtHours(durationMinutes)==="1"?"":"s"}`;
};
const fmtDateLabel = (dateStr) => dateStr ? new Date(dateStr+"T00:00:00").toLocaleDateString("en-PH",{weekday:"short",month:"short",day:"numeric"}) : "";
const fmtTimeLabel = (t) => { if(!t) return ""; const [h,m]=t.split(":").map(Number); const period=h>=12?"PM":"AM"; const h12=h%12===0?12:h%12; return `${h12}:${String(m).padStart(2,"0")} ${period}`; };

const API_BASE = "";

export default function BookingPayApp() {
  const slug = useMemo(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const i = parts.indexOf("bookings");
    return i >= 0 ? (parts[i+1] || "") : "";
  }, []);
  const prefillRef = useMemo(() => new URLSearchParams(window.location.search).get("ref") || "", []);

  const [refCode, setRefCode] = useState(prefillRef);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [looking, setLooking] = useState(false);
  const [booking, setBooking] = useState(null);

  const [screenshotFile, setScreenshotFile] = useState(null);
  const [screenshotPreview, setScreenshotPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const lookup = async () => {
    setError("");
    if (!refCode.trim() || !phone.trim()) { setError("Enter both your reference code and phone number"); return; }
    setLooking(true);
    try {
      const res = await fetch(`${API_BASE}/api/lookup-booking`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, refCode: refCode.trim(), phone: phone.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setError(data.error || "Couldn't find that booking"); setLooking(false); return; }
      setBooking(data);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setLooking(false);
  };

  const pickScreenshot = (file) => {
    if (!file) return;
    setScreenshotFile(file);
    const reader = new FileReader();
    reader.onload = () => setScreenshotPreview(reader.result);
    reader.readAsDataURL(file);
  };

  const submitPayment = async () => {
    setError("");
    if (!screenshotPreview) { setError("Upload your GCash payment screenshot"); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/submit-booking-payment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, bookingId: booking.bookingId, screenshotBase64: screenshotPreview }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setError(data.error || "Something went wrong. Please try again."); setSubmitting(false); return; }
      setJustSubmitted(true);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setSubmitting(false);
  };

  const noun = booking?.bookingNoun || "Booking";

  return (
    <div style={{minHeight:"100vh",boxSizing:"border-box",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",padding:"40px 16px",background:"#f1f8f6"}}>
      <div style={{maxWidth:440,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:20,fontWeight:800,color:"#111"}}>{booking?.storeName || "Pay My " + noun}</div>
          <div style={{fontSize:13,color:"#0d9488",fontWeight:700,marginTop:2}}>Find and pay your {noun.toLowerCase()}</div>
        </div>

        <div style={{background:"#fff",borderRadius:18,padding:"26px 24px",boxShadow:"0 4px 24px rgba(0,0,0,0.06)"}}>
          {!booking && (
            <>
              <h2 style={{margin:"0 0 4px",fontSize:18}}>Find your {noun.toLowerCase()}</h2>
              <p style={{color:"#6b7280",fontSize:13,margin:"0 0 18px"}}>Enter the reference code from your confirmation and the phone number you booked with.</p>
              <label style={LBL}>{noun} Reference</label>
              <input value={refCode} onChange={e=>setRefCode(e.target.value.toUpperCase())} style={{...INP,textTransform:"uppercase"}} placeholder="ABC-123"/>
              <label style={LBL}>Phone Number</label>
              <input value={phone} onChange={e=>setPhone(e.target.value)} style={INP} placeholder="09XX XXX XXXX"/>
              {error && <div style={{marginTop:14,padding:"10px 14px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,color:"#b91c1c",fontSize:13}}>{error}</div>}
              <button onClick={lookup} disabled={looking} style={{width:"100%",marginTop:20,padding:"13px 0",background:"#0d9488",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",opacity:looking?0.7:1}}>
                {looking ? "Looking…" : "Find My " + noun}
              </button>
            </>
          )}

          {booking && (
            <>
              <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>
                {booking.serviceName}{booking.resourceName?` · ${booking.resourceName}`:""} · {fmtDateLabel(booking.date)}{booking.time?` · ${fmtTimeLabel(booking.time)}`:""}
              </div>

              {booking.status === "confirmed" && (
                <div style={{textAlign:"center",padding:"10px 0"}}>
                  <div style={{width:56,height:56,borderRadius:"50%",background:"#f0fdfa",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
                    <i className="ti ti-check" style={{fontSize:28,color:"#0d9488"}}/>
                  </div>
                  <h2 style={{margin:"0 0 6px",fontSize:18}}>You're all set!</h2>
                  <p style={{color:"#6b7280",fontSize:13}}>This {noun.toLowerCase()} is confirmed. No payment needed.</p>
                </div>
              )}

              {booking.status === "pending" && (booking.paymentSubmitted || justSubmitted) && (
                <div style={{textAlign:"center",padding:"10px 0"}}>
                  <div style={{width:56,height:56,borderRadius:"50%",background:"#fffbeb",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
                    <i className="ti ti-clock" style={{fontSize:28,color:"#b45309"}}/>
                  </div>
                  <h2 style={{margin:"0 0 6px",fontSize:18}}>Awaiting confirmation</h2>
                  <p style={{color:"#6b7280",fontSize:13}}>Your payment was submitted. The store will confirm your {noun.toLowerCase()} shortly.</p>
                </div>
              )}

              {booking.status === "pending" && !booking.paymentSubmitted && !justSubmitted && (
                <>
                  <div style={{background:"#f0fdfa",border:"1px solid #99f6e4",borderRadius:12,padding:16,textAlign:"center",marginBottom:18}}>
                    <div style={{fontSize:12,color:"#0d9488",fontWeight:700,marginBottom:4}}>Amount to send</div>
                    <div style={{fontSize:26,fontWeight:800,color:"#111"}}>{fmtPeso(booking.amount)}</div>
                    {pricingBreakdown(booking.hourlyRate, booking.durationMinutes) && (
                      <div style={{fontSize:12,color:"#0d9488",marginTop:4}}>{pricingBreakdown(booking.hourlyRate, booking.durationMinutes)}</div>
                    )}
                  </div>
                  {booking.gcash?.qrUrl && <img src={booking.gcash.qrUrl} alt="GCash QR code" style={{width:"100%",maxWidth:220,display:"block",margin:"0 auto 14px",borderRadius:10}}/>}
                  {(booking.gcash?.name || booking.gcash?.number) && (
                    <div style={{textAlign:"center",fontSize:13,marginBottom:20}}>
                      {booking.gcash?.name && <div style={{fontWeight:700,color:"#111"}}>{booking.gcash.name}</div>}
                      {booking.gcash?.number && <div style={{color:"#6b7280"}}>{booking.gcash.number}</div>}
                    </div>
                  )}
                  <label style={LBL}>Upload payment screenshot</label>
                  {screenshotPreview && <img src={screenshotPreview} alt="" style={{width:"100%",borderRadius:10,marginTop:8,marginBottom:8}}/>}
                  <input type="file" accept="image/*" onChange={e=>pickScreenshot(e.target.files?.[0])} style={{fontSize:12,marginTop:4}}/>
                  {error && <div style={{marginTop:14,padding:"10px 14px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,color:"#b91c1c",fontSize:13}}>{error}</div>}
                  <button onClick={submitPayment} disabled={submitting || !screenshotPreview}
                    style={{width:"100%",marginTop:20,padding:"13px 0",background:screenshotPreview?"#0d9488":"#d1fae5",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:screenshotPreview?"pointer":"not-allowed",opacity:submitting?0.7:1}}>
                    {submitting ? "Submitting…" : "Submit Payment"}
                  </button>
                </>
              )}

              <button onClick={()=>{setBooking(null);setScreenshotPreview(null);setJustSubmitted(false);}} style={{width:"100%",marginTop:14,padding:"9px 0",background:"none",border:"none",color:"#9ca3af",fontSize:12,cursor:"pointer"}}>Look up a different {noun.toLowerCase()}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const LBL = {display:"block",fontSize:12,fontWeight:700,color:"#374151",marginBottom:6,marginTop:14};
const INP = {width:"100%",padding:"11px 14px",borderRadius:10,border:"1px solid #e5e7eb",fontSize:14,boxSizing:"border-box"};
