import { useState, useEffect, useMemo } from "react";

// ── Same pure helpers as the PWA's Bookings module (App.jsx → BookingsView) ──
// Duplicated on purpose: this is an isolated public bundle with no build-time
// link to the PWA, so the two copies just need to stay logically identical.
const DAYS_OF_WEEK = ["sun","mon","tue","wed","thu","fri","sat"];
const dayKeyFor = (dateStr) => DAYS_OF_WEEK[new Date(dateStr+"T00:00:00").getDay()];
const getWorkingHours = (resource, storeDefaultHours, dayKey) => {
  const hours = resource?.workingHours || storeDefaultHours || {};
  return hours[dayKey] || null;
};
const addMinutes = (time, mins) => {
  const [h,m] = time.split(":").map(Number);
  const total = h*60+m+mins;
  const hh = Math.floor((total%1440)/60), mm = total%60;
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
};
const minutesBetween = (start, end) => {
  const [sh,sm] = start.split(":").map(Number);
  const [eh,em] = end.split(":").map(Number);
  let diff = (eh*60+em) - (sh*60+sm);
  if(diff <= 0) diff += 1440;
  return diff;
};
const generateSlots = (workingHours, slotIncrementMinutes, durationMinutes) => {
  if(!workingHours) return [];
  const slots = [];
  let t = workingHours.start;
  const effectiveDuration = durationMinutes || slotIncrementMinutes;
  while(addMinutes(t, effectiveDuration) <= workingHours.end){
    slots.push(t);
    t = addMinutes(t, slotIncrementMinutes);
  }
  return slots;
};
const hasBookingConflict = (bookings, resourceId, date, time, durationMinutes) => {
  if(!resourceId || !time) return false;
  const newEnd = addMinutes(time, durationMinutes||30);
  return bookings.some(b=>{
    if(b.resourceId!==resourceId || b.date!==date || !b.time) return false;
    const bEnd = addMinutes(b.time, b.durationMinutes||30);
    return time < bEnd && b.time < newEnd;
  });
};
const toLocalDateKey = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const fmtPeso = (n) => `\u20B1\u200A${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:0,maximumFractionDigits:2})}`;
const fmtDateLabel = (dateStr) => new Date(dateStr+"T00:00:00").toLocaleDateString("en-PH",{weekday:"short",month:"short",day:"numeric"});
const fmtTimeLabel = (t) => {
  const [h,m] = t.split(":").map(Number);
  const period = h>=12?"PM":"AM"; const h12 = h%12===0?12:h%12;
  return `${h12}:${String(m).padStart(2,"0")} ${period}`;
};

const API_BASE = ""; // same-origin (client.pospro-portal.com/api/*)

export default function BookingApp() {
  // Path is /bookings/{slug} — the vercel.json rewrite serves this bundle
  // for that path while leaving the URL bar (and window.location.pathname)
  // intact, so the slug is read from the path, not a query param.
  const slug = useMemo(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const i = parts.indexOf("bookings");
    return i >= 0 ? (parts[i+1] || "") : "";
  }, []);

  const [phase, setPhase] = useState("loading"); // loading | notfound | ready
  const [store, setStore] = useState(null);
  const [step, setStep] = useState("service"); // service | resource | schedule | details | done
  const [error, setError] = useState("");

  const [serviceId, setServiceId] = useState(null);
  const [resourceId, setResourceId] = useState(null);
  const [date, setDate] = useState(null);
  const [time, setTime] = useState(null);
  const [endTime, setEndTime] = useState(null);
  const [rangeStart, setRangeStart] = useState(null); // first tap of a 2-tap range select

  const [customerFirstName, setCustomerFirstName] = useState("");
  const [customerLastName, setCustomerLastName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [bookingId, setBookingId] = useState(null);
  const [amountDue, setAmountDue] = useState(0);
  const [screenshotFile, setScreenshotFile] = useState(null);
  const [screenshotPreview, setScreenshotPreview] = useState(null);

  useEffect(() => {
    if (!slug) { setPhase("notfound"); return; }
    fetch(`${API_BASE}/api/public-booking-data?slug=${encodeURIComponent(slug)}`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setPhase("notfound"); return; }
        setStore(d);
        setPhase("ready");
      })
      .catch(() => setPhase("notfound"));
  }, [slug]);

  const service = store?.services.find(s => s.id === serviceId) || null;
  const resource = store?.resources.find(r => r.id === resourceId) || null;

  const dateOptions = useMemo(() => {
    if (!service) return [];
    const out = [];
    const cursor = new Date();
    for (let i = 0; i < 21 && out.length < 14; i++) {
      const d = new Date(cursor); d.setDate(cursor.getDate() + i);
      const key = toLocalDateKey(d);
      const dayKey = dayKeyFor(key);
      const hours = service.resourceRequired && resource
        ? getWorkingHours(resource, store.defaultHours, dayKey)
        : getWorkingHours(null, store.defaultHours, dayKey);
      out.push({ key, open: !!hours });
    }
    return out;
  }, [service, resource, store]);

  const slots = useMemo(() => {
    if (!service || !date || !service.exclusivity) return [];
    const dayKey = dayKeyFor(date);
    const hours = getWorkingHours(resource, store.defaultHours, dayKey);
    const raw = generateSlots(hours, service.slotIncrementMinutes || 30, service.durationMinutes || service.slotIncrementMinutes || 30);
    if (!resourceId) return raw.map(t => ({ time: t, taken: false }));
    return raw.map(t => ({
      time: t,
      taken: hasBookingConflict(store.bookings, resourceId, date, t, service.durationMinutes || service.slotIncrementMinutes || 30),
    }));
  }, [service, date, resource, resourceId, store]);

  const pickSlot = (t) => {
    if (service.durationMode !== "flexible") { setTime(t); setEndTime(null); return; }
    if (!rangeStart) { setRangeStart(t); setTime(t); setEndTime(null); return; }
    const start = rangeStart <= t ? rangeStart : t;
    const end = addMinutes(rangeStart <= t ? t : rangeStart, service.slotIncrementMinutes || 30);
    setTime(start); setEndTime(end); setRangeStart(null);
  };

  const canSubmitSchedule = date && (!service.exclusivity || (time && (service.durationMode !== "flexible" || endTime)));

  const createBooking = async () => {
    setError("");
    if (!customerFirstName.trim()) { setError("Enter your first name"); return; }
    if (!customerLastName.trim()) { setError("Enter your last name"); return; }
    if (!customerPhone.trim()) { setError("Enter a phone number so the store can reach you"); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/create-booking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug, serviceId, resourceId, date, time, endTime,
          customerFirstName: customerFirstName.trim(), customerLastName: customerLastName.trim(),
          customerPhone: customerPhone.trim(), customerEmail: customerEmail.trim(), notes,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        if (res.status === 409) { setStep("schedule"); setTime(null); setEndTime(null); } // slot taken — send them back to pick again
        else if (data.error === "Please select a resource") { setStep("resource"); } // defense-in-depth, shouldn't hit now that the click-through bug is fixed
        setSubmitting(false);
        return;
      }
      setBookingId(data.bookingId);
      setAmountDue(data.amount || 0);
      setStep(data.requiresPayment ? "payment" : "done");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setSubmitting(false);
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, bookingId, screenshotBase64: screenshotPreview }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setError(data.error || "Something went wrong. Please try again."); setSubmitting(false); return; }
      setStep("done");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    }
    setSubmitting(false);
  };

  if (phase === "loading") {
    return <Centered><div style={{color:"#6b7280",fontSize:14}}>Loading…</div></Centered>;
  }
  if (phase === "notfound") {
    return (
      <Centered>
        <h2 style={{color:"#111",margin:"0 0 8px"}}>Booking page not found</h2>
        <p style={{color:"#6b7280",fontSize:14}}>This link may be out of date, or online booking isn't turned on for this store.</p>
      </Centered>
    );
  }

  return (
    <div style={{minHeight:"100vh",boxSizing:"border-box",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",padding:"40px 16px",background:"#f1f8f6"}}>
      <div style={{maxWidth:520,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:52,height:52,borderRadius:14,overflow:"hidden",margin:"0 auto 10px"}}>
            <img src={store.logoUrl || "/icons/icon-192.png"} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          </div>
          <div style={{fontSize:20,fontWeight:800,color:"#111"}}>{store.storeName}</div>
          <div style={{fontSize:13,color:"#0d9488",fontWeight:700,marginTop:2}}>{store.tagline}</div>
        </div>

        <div style={{background:"#fff",borderRadius:18,padding:"26px 24px",boxShadow:"0 4px 24px rgba(0,0,0,0.06)"}}>
          {step !== "done" && step !== "service" && step !== "payment" && (
            <button onClick={() => setStep(step==="details"?"schedule":step==="schedule"&&service?.resourceRequired?"resource":"service")}
              style={{background:"none",border:"none",color:"#0d9488",fontSize:13,fontWeight:700,cursor:"pointer",padding:0,marginBottom:16,display:"flex",alignItems:"center",gap:4}}>
              <i className="ti ti-chevron-left"/> Back
            </button>
          )}

          {step === "service" && (
            <>
              <h2 style={{margin:"0 0 16px",fontSize:18}}>Choose a service</h2>
              {store.services.length === 0 && <Empty text="No services are available for booking right now."/>}
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {store.services.map(s => (
                  <button key={s.id} onClick={() => { setServiceId(s.id); setResourceId(null); setDate(null); setTime(null); setEndTime(null); setStep(s.resourceRequired ? "resource" : "schedule"); }}
                    style={{textAlign:"left",padding:"14px 16px",border:"1px solid #e5e7eb",borderRadius:12,background:"#fff",cursor:"pointer"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                      <div style={{fontWeight:700,fontSize:14,color:"#111"}}>{s.name}</div>
                      <div style={{fontWeight:800,fontSize:14,color:"#0d9488"}}>{fmtPeso(s.price)}</div>
                    </div>
                    <div style={{fontSize:12,color:"#9ca3af",marginTop:3}}>{s.durationMinutes ? `${s.durationMinutes} min` : "Flexible duration"}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === "resource" && service && (
            <>
              <h2 style={{margin:"0 0 16px",fontSize:18}}>Choose {store.resources.length ? "a resource" : "an option"}</h2>
              <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {store.resources.map(r => (
                  <button key={r.id} onClick={() => { setResourceId(r.id); setDate(null); setStep("schedule"); }}
                    style={{padding:"10px 16px",borderRadius:10,border:"1px solid #e5e7eb",background:"#fff",cursor:"pointer",fontSize:13,fontWeight:700,color:"#374151"}}>
                    {r.name}
                  </button>
                ))}
              </div>
              {store.resources.length === 0 && <Empty text="No resources are set up yet — please check back later."/>}
            </>
          )}

          {step === "schedule" && service && (
            <>
              <h2 style={{margin:"0 0 4px",fontSize:18}}>{service.name}</h2>
              <p style={{color:"#6b7280",fontSize:13,margin:"0 0 18px"}}>{resource ? resource.name+" · " : ""}{fmtPeso(service.price)}</p>

              <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:8}}>Date</div>
              <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:6,marginBottom:18}}>
                {dateOptions.map(d => (
                  <button key={d.key} disabled={!d.open} onClick={() => { setDate(d.key); setTime(null); setEndTime(null); setRangeStart(null); }}
                    style={{flex:"0 0 auto",padding:"10px 14px",borderRadius:10,border:date===d.key?"1px solid #0d9488":"1px solid #e5e7eb",background:date===d.key?"#0d9488":d.open?"#fff":"#f9fafb",color:date===d.key?"#fff":d.open?"#374151":"#d1d5db",cursor:d.open?"pointer":"not-allowed",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>
                    {fmtDateLabel(d.key)}
                  </button>
                ))}
              </div>

              {date && service.exclusivity && (
                <>
                  <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:8}}>
                    {service.durationMode==="flexible" ? (rangeStart ? "Tap an end time" : "Tap a start time") : "Time"}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:6}}>
                    {slots.map(s => {
                      const selected = service.durationMode==="flexible"
                        ? (rangeStart===s.time || (time && endTime && s.time>=time && s.time<endTime))
                        : time===s.time;
                      return (
                        <button key={s.time} disabled={s.taken} onClick={() => pickSlot(s.time)}
                          style={{padding:"9px 0",borderRadius:9,border:selected?"1px solid #0d9488":"1px solid #e5e7eb",background:s.taken?"#f9fafb":selected?"#0d9488":"#fff",color:s.taken?"#d1d5db":selected?"#fff":"#374151",cursor:s.taken?"not-allowed":"pointer",fontSize:12,fontWeight:700,textDecoration:s.taken?"line-through":"none"}}>
                          {fmtTimeLabel(s.time)}
                        </button>
                      );
                    })}
                  </div>
                  {slots.length===0 && <Empty text="No time slots available that day — try another date."/>}
                  {time && endTime && <div style={{fontSize:12,color:"#6b7280",marginTop:8}}>{fmtTimeLabel(time)} – {fmtTimeLabel(endTime)}</div>}
                </>
              )}

              {store.storePhone && (
                <div style={{fontSize:12,color:"#9ca3af",marginTop:16}}>
                  Can't find a time that works?{" "}
                  <a href={`tel:${store.storePhone}`} style={{color:"#0d9488",fontWeight:700,textDecoration:"none"}}>Call us: {store.storePhone}</a>
                </div>
              )}

              <button disabled={!canSubmitSchedule} onClick={() => setStep("details")}
                style={{width:"100%",marginTop:22,padding:"13px 0",background:canSubmitSchedule?"#0d9488":"#d1fae5",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:canSubmitSchedule?"pointer":"not-allowed"}}>
                Continue
              </button>
            </>
          )}

          {step === "details" && service && (
            <>
              <h2 style={{margin:"0 0 4px",fontSize:18}}>Your details</h2>
              <p style={{color:"#6b7280",fontSize:13,margin:"0 0 18px"}}>
                {service.name} · {fmtDateLabel(date)}{time?` · ${fmtTimeLabel(time)}${endTime?` – ${fmtTimeLabel(endTime)}`:""}`:""}
              </p>
              <div style={{display:"flex",gap:10}}>
                <div style={{flex:1}}>
                  <label style={LBL}>First Name</label>
                  <input value={customerFirstName} onChange={e=>setCustomerFirstName(e.target.value)} style={INP} placeholder="Juan"/>
                </div>
                <div style={{flex:1}}>
                  <label style={LBL}>Last Name</label>
                  <input value={customerLastName} onChange={e=>setCustomerLastName(e.target.value)} style={INP} placeholder="Dela Cruz"/>
                </div>
              </div>
              <label style={LBL}>Phone Number</label>
              <input value={customerPhone} onChange={e=>setCustomerPhone(e.target.value)} style={INP} placeholder="09XX XXX XXXX"/>
              <label style={LBL}>Email (optional)</label>
              <input value={customerEmail} onChange={e=>setCustomerEmail(e.target.value)} style={INP} placeholder="For your booking confirmation"/>
              <label style={LBL}>Notes (optional)</label>
              <input value={notes} onChange={e=>setNotes(e.target.value)} style={INP} placeholder="Anything the store should know"/>

              {error && <div style={{marginTop:14,padding:"10px 14px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,color:"#b91c1c",fontSize:13}}>{error}</div>}

              <button onClick={createBooking} disabled={submitting}
                style={{width:"100%",marginTop:20,padding:"13px 0",background:"#0d9488",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",opacity:submitting?0.7:1}}>
                {submitting ? "Booking…" : (service.requiresPayment ? "Continue to Payment" : "Confirm Booking")}
              </button>
            </>
          )}

          {step === "payment" && (
            <>
              <h2 style={{margin:"0 0 4px",fontSize:18}}>Pay with GCash</h2>
              <p style={{color:"#6b7280",fontSize:13,margin:"0 0 18px"}}>Your slot is held for a short while — send the exact amount below and upload your screenshot to confirm.</p>

              <div style={{background:"#f0fdfa",border:"1px solid #99f6e4",borderRadius:12,padding:16,textAlign:"center",marginBottom:18}}>
                <div style={{fontSize:12,color:"#0d9488",fontWeight:700,marginBottom:4}}>Amount to send</div>
                <div style={{fontSize:26,fontWeight:800,color:"#111"}}>{fmtPeso(amountDue)}</div>
              </div>

              {store.gcash?.qrUrl && <img src={store.gcash.qrUrl} alt="GCash QR code" style={{width:"100%",maxWidth:220,display:"block",margin:"0 auto 14px",borderRadius:10}}/>}
              {(store.gcash?.name || store.gcash?.number) && (
                <div style={{textAlign:"center",fontSize:13,marginBottom:20}}>
                  {store.gcash?.name && <div style={{fontWeight:700,color:"#111"}}>{store.gcash.name}</div>}
                  {store.gcash?.number && <div style={{color:"#6b7280"}}>{store.gcash.number}</div>}
                </div>
              )}
              {!store.gcash?.qrUrl && !store.gcash?.number && (
                <div style={{textAlign:"center",fontSize:13,color:"#b91c1c",marginBottom:20}}>This store hasn't set up their GCash details yet — please contact them directly to complete payment.</div>
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

          {step === "done" && (
            <div style={{textAlign:"center",padding:"10px 0"}}>
              <div style={{width:64,height:64,borderRadius:"50%",background:"#f0fdfa",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px"}}>
                <i className={`ti ${service?.requiresPayment?"ti-clock":"ti-check"}`} style={{fontSize:32,color:"#0d9488"}}/>
              </div>
              <h2 style={{margin:"0 0 8px",fontSize:20}}>{service?.requiresPayment ? "Payment submitted!" : "You're booked!"}</h2>
              <p style={{color:"#6b7280",fontSize:14,lineHeight:1.6}}>
                {service?.name} on {fmtDateLabel(date)}{time?` at ${fmtTimeLabel(time)}`:""}, for <b>{customerFirstName} {customerLastName}</b>.{" "}
                {service?.requiresPayment
                  ? `${store.storeName} will review your payment and confirm your booking shortly.`
                  : `${store.storeName} may contact you at ${customerPhone} to confirm.`}
              </p>
            </div>
          )}
        </div>
        {store.pageContent?.length > 0 && <PageContentBlocks blocks={store.pageContent}/>}
      </div>
    </div>
  );
}

function PageContentBlocks({blocks}) {
  return (
    <div style={{marginTop:28,display:"flex",flexDirection:"column",gap:22}}>
      {blocks.map(b => {
        if (b.type === "divider") return <div key={b.id} style={{height:1,background:"#e5e7eb"}}/>;
        if (b.type === "image") return (
          <figure key={b.id} style={{margin:0}}>
            <img src={b.url} alt={b.caption||""} style={{width:"100%",borderRadius:14,display:"block"}}/>
            {b.caption && <figcaption style={{fontSize:12,color:"#9ca3af",marginTop:6,textAlign:"center"}}>{b.caption}</figcaption>}
          </figure>
        );
        if (b.type === "columns") return (
          <div key={b.id} style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:18}}>
            {(b.columns||[]).map((c,i) => (
              <div key={i}>
                {c.heading && <div style={{fontWeight:700,fontSize:14,color:"#111",marginBottom:6}}>{c.heading}</div>}
                <div style={{fontSize:13,color:"#6b7280",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{c.body}</div>
              </div>
            ))}
          </div>
        );
        // richtext (default/fallback)
        {
          const sizes = {sm:{h:14,b:12},md:{h:16,b:13},lg:{h:20,b:15}}[b.fontSize||"md"];
          return (
            <div key={b.id} style={{textAlign:b.align||"left"}}>
              {b.heading && <div style={{fontWeight:800,fontSize:sizes.h,color:b.color||"#111",marginBottom:6}}>{b.heading}</div>}
              <div style={{fontSize:sizes.b,color:b.color||"#6b7280",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{b.body}</div>
            </div>
          );
        }
      })}
    </div>
  );
}

const LBL = {display:"block",fontSize:12,fontWeight:700,color:"#374151",marginBottom:6,marginTop:14};
const INP = {width:"100%",padding:"11px 14px",borderRadius:10,border:"1px solid #e5e7eb",fontSize:14,boxSizing:"border-box"};

function Centered({children}) {
  return <div style={{minHeight:"100vh",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",padding:24,textAlign:"center",background:"#f1f8f6"}}><div>{children}</div></div>;
}
function Empty({text}) {
  return <div style={{textAlign:"center",padding:"20px 0",color:"#9ca3af",fontSize:13}}>{text}</div>;
}
