import { useState, useEffect, useRef, useCallback } from "react";
import bcrypt from "bcryptjs";

// ════════════════════════════════════════════════════════
// SUPABASE CONFIG — loaded from .env (VITE_SUPA_URL / VITE_SUPA_ANON)
// ════════════════════════════════════════════════════════
const SUPA_URL  = import.meta.env.VITE_SUPA_URL  || "";
const SUPA_ANON = import.meta.env.VITE_SUPA_ANON || "";
const H = {"Content-Type":"application/json","apikey":SUPA_ANON,"Authorization":`Bearer ${SUPA_ANON}`};

const supa = {
  async get(table,match){
    try{const q=Object.entries(match).map(([k,v])=>`${k}=eq.${encodeURIComponent(v)}`).join("&");const r=await fetch(`${SUPA_URL}/rest/v1/${table}?${q}&limit=1`,{headers:H});const d=await r.json();return d[0]||null;}catch{return null;}
  },
  async update(table,match,data){
    try{const q=Object.entries(match).map(([k,v])=>`${k}=eq.${encodeURIComponent(v)}`).join("&");const r=await fetch(`${SUPA_URL}/rest/v1/${table}?${q}`,{method:"PATCH",headers:{...H,"Prefer":"return=representation"},body:JSON.stringify(data)});return r.ok;}catch{return false;}
  },
  async insert(table,data){
    try{const r=await fetch(`${SUPA_URL}/rest/v1/${table}`,{method:"POST",headers:{...H,"Prefer":"return=representation"},body:JSON.stringify(data)});const d=await r.json();return d[0]||null;}catch{return null;}
  },
  async uploadImage(storeId, productId, base64DataUrl) {
    try {
      const res  = await fetch(base64DataUrl);
      const blob = await res.blob();
      const mime = blob.type || "image/jpeg";
      const ext  = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
      const path = `${storeId}/${productId}.${ext}`;
      const r = await fetch(
        `${SUPA_URL}/storage/v1/object/product-images/${path}`,
        { method:"PUT", headers:{"apikey":SUPA_ANON,"Authorization":`Bearer ${SUPA_ANON}`,"Content-Type":mime,"x-upsert":"true"}, body:blob }
      );
      if(!r.ok){ const err=await r.text().catch(()=>""); console.error("[Storage] Upload failed",r.status,err); return null; }
      return `${SUPA_URL}/storage/v1/object/public/product-images/${path}`;
    } catch(e){ console.error("[Storage] Upload error",e); return null; }
  },
};

// ── COMPUTE STOCK (auto products use inclusions) ──
const computeStockPortal = (p, allProducts) => {
  if(p.stockMode !== "auto" || !p.recipe || !p.recipe.length) return p.stock;
  let min = Infinity;
  for(let i=0;i<p.recipe.length;i++){
    const r = p.recipe[i];
    if(!r.productId || !r.qty) continue;
    const ing = allProducts.find(x=>x.id===r.productId);
    if(!ing) continue;
    const ingStock = ing.stockMode==="auto" ? computeStockPortal(ing, allProducts) : ing.stock;
    min = Math.min(min, Math.floor(ingStock / r.qty));
  }
  return min === Infinity ? 0 : Math.max(0, min);
};

// ── IMAGE COMPRESSION ──
const compressImage = (file, maxSize=300, quality=0.7) => new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let w = img.width, h = img.height;
      if(w > maxSize || h > maxSize) {
        if(w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
        else       { w = Math.round(w * maxSize / h); h = maxSize; }
      }
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

const fmt        = (n) => `₱${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
// Format a Date as YYYY-MM-DD using LOCAL time components, not UTC.
// CRITICAL: .toISOString() always returns UTC — for PH (UTC+8), any
// order placed between 12:00am-8:00am local time would get stamped
// with the PREVIOUS day's date in the PWA, and this same bug here
// would ALSO misfile it under "Today" filtering on the portal side.
// Both apps need this fix for "Today" to actually mean today.
// NOTE FOR THE FUTURE — read this before adding stores outside the
// Philippines. See the matching comment in the PWA's App.jsx for the
// full explanation; short version: this assumes whoever's viewing the
// portal is in PH time (the device's own clock/timezone), which holds
// today but would need a per-store timezone setting if that changes.
const toLocalDateKey = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
};
const todayKey   = () => toLocalDateKey(new Date());
const weekStart  = () => { const d=new Date(); d.setDate(d.getDate()-d.getDay()); return toLocalDateKey(d); };
const monthStart = () => { const d=new Date(); return toLocalDateKey(new Date(d.getFullYear(),d.getMonth(),1)); };
const uid        = () => Math.random().toString(36).slice(2,10);

const SESSION_KEY = "portal_session";
const getSession  = () => { try{return JSON.parse(sessionStorage.getItem(SESSION_KEY));}catch{return null;} };
const saveSession = (s) => sessionStorage.setItem(SESSION_KEY,JSON.stringify(s));
const clearSession= () => sessionStorage.removeItem(SESSION_KEY);

// Resend API key is managed exclusively server-side (Vercel env: RESEND_API_KEY).
// It is never stored or read client-side to prevent key exposure.

// SECURITY: OTP generation, storage, and verification happen entirely on
// the server (/api/send-otp) using the Supabase SERVICE key. The browser
// never generates the code, never writes it to Supabase directly, and
// never reads it back — it only ever sees {ok:true}/{ok:false}. This
// replaces an earlier version that PATCHed the OTP into `stores` with the
// anon key and read it back to compare client-side, which meant the
// plaintext code was visible in DevTools → Network on every request.
const sendPortalOTP = async (email, storeName, purpose="sign-in") => {
  try {
    const r = await fetch("/api/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action:"send-otp", email, storeName, purpose }),
    });
    const data = await r.json().catch(()=>({}));
    if(r.ok && data.ok) return {ok:true};
    return {ok:false, error:data.error||"Failed to send code"};
  } catch {
    return {ok:false, error:"Network error"};
  }
};

const verifyPortalOTP = async (email, inputOtp) => {
  try {
    const r = await fetch("/api/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action:"verify-otp", email, otp:inputOtp }),
    });
    const data = await r.json().catch(()=>({}));
    return !!(r.ok && data.ok);
  } catch {
    return false;
  }
};

// ════════════════════════════════════════════════════════
// DEV CONSOLE IMPERSONATION TOKEN
// One-time, short-lived token generated by the Dev Console so a
// developer can open this Portal scoped to a specific store without
// the owner's password and without sending them an OTP. Single-use,
// expires in 2 minutes, and is marked used immediately on validation
// so it can never be replayed even if the URL leaks.
// ════════════════════════════════════════════════════════
const verifyDevToken = async (token) => {
  const row = await supa.get("dev_tokens",{token});
  if(!row) return null;
  if(row.used) return null;
  if(new Date(row.expires_at) < new Date()) return null;
  await supa.update("dev_tokens",{token},{used:true});
  return row.store_id;
};

const LBL={fontSize:11,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:0.5,display:"block",marginBottom:5};
const INP={width:"100%",padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,background:"#f9fafb",color:"#111",outline:"none",boxSizing:"border-box"};
function Card({children,style={}}){return<div style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",marginBottom:16,...style}}>{children}</div>;}
function SectionTitle({children}){return<div style={{fontWeight:800,fontSize:14,marginBottom:14}}>{children}</div>;}
function FRow({label,children,hint}){return<div><label style={LBL}>{label}{hint&&<span style={{fontSize:10,color:"#9ca3af",marginLeft:6,textTransform:"none",letterSpacing:0}}>{hint}</span>}</label><div style={{marginTop:5}}>{children}</div></div>;}
function Err({msg}){if(!msg)return null;return<div style={{marginTop:10,padding:"9px 12px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,fontSize:13,color:"#991b1b",display:"flex",alignItems:"center",gap:7}}><i className="ti ti-alert-circle" style={{fontSize:15,flexShrink:0}}/>{msg}</div>;}
function Ok({msg}){if(!msg)return null;return<div style={{marginTop:10,padding:"9px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:13,color:"#166534",display:"flex",alignItems:"center",gap:7}}><i className="ti ti-check" style={{fontSize:15,flexShrink:0}}/>{msg}</div>;}
function Toggle({checked,onChange,label}){return<label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}><div onClick={()=>onChange(!checked)} style={{width:40,height:22,borderRadius:11,background:checked?"#4f46e5":"#d1d5db",position:"relative",transition:"background 0.2s",flexShrink:0,cursor:"pointer"}}><div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:checked?20:2,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/></div>{label&&<span style={{fontSize:13,fontWeight:600,color:"#374151"}}>{label}</span>}</label>;}

// ════════════════════════════════════════════════════════
// PRODUCT SEARCH SELECT — type-to-filter dropdown for inclusions.
// Only shows active products. onSelect receives the full product object.
// ════════════════════════════════════════════════════════
function ProductSearchSelect({products, value, onSelect, placeholder, excludeId}){
  const [open,setOpen] = useState(false);
  const [query,setQuery] = useState(value||"");
  const [coords,setCoords] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(()=>{ setQuery(value||""); },[value]);

  useEffect(()=>{
    const onClickOutside = (e) => {
      if(wrapRef.current && !wrapRef.current.contains(e.target) &&
         !(e.target.closest && e.target.closest("[data-pss-panel]"))) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return ()=>document.removeEventListener("mousedown", onClickOutside);
  },[]);

  useEffect(()=>{
    if(!open) return;
    const updatePos = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if(r) setCoords({top:r.bottom+2, left:r.left, width:r.width});
    };
    updatePos();
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return ()=>{
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  },[open]);

  const active = (products||[]).filter(p=>p.active && p.id!==excludeId);
  const filtered = query.trim()
    ? active.filter(p=>p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : active;

  return (
    <div ref={wrapRef} style={{position:"relative"}}>
      <input
        ref={inputRef}
        value={query}
        onChange={e=>{ setQuery(e.target.value); setOpen(true); }}
        onFocus={()=>setOpen(true)}
        placeholder={placeholder||"Search product…"}
        style={{...INP, padding:"5px 8px"}}
      />
      {open && filtered.length>0 && coords && (
        <div data-pss-panel style={{position:"fixed", top:coords.top, left:coords.left, width:coords.width, zIndex:9999, background:"#fff", border:"1px solid #e5e7eb", borderRadius:8, maxHeight:220, overflowY:"auto", boxShadow:"0 4px 14px rgba(0,0,0,0.18)"}}>
          {filtered.slice(0,50).map(p=>(
            <div key={p.id}
              onMouseDown={()=>{ setQuery(p.name); setOpen(false); onSelect(p); }}
              style={{padding:"8px 10px", cursor:"pointer", fontSize:13, display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid #f3f4f6"}}
              onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"}
              onMouseLeave={e=>e.currentTarget.style.background="#fff"}
            >
              <span>{p.name}</span>
              <span style={{fontSize:11, color:"#9ca3af"}}>{fmt(p.price)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function printReport(html,title){
  const win=window.open("","_blank","width=900,height=700");if(!win)return;
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:12px;padding:20px;color:#111}h1{font-size:18px;font-weight:800;margin-bottom:4px}h2{font-size:13px;font-weight:700;margin:16px 0 8px;color:#4f46e5;border-bottom:2px solid #4f46e5;padding-bottom:4px}.meta{font-size:11px;color:#6b7280;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin-bottom:16px}th{background:#f3f4f6;padding:6px 8px;text-align:left;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;border-bottom:2px solid #e5e7eb}td{padding:6px 8px;border-bottom:1px solid #f3f4f6}.right{text-align:right}.bold{font-weight:800}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}.card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px}.card-label{font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px}.card-val{font-size:20px;font-weight:800;color:#4f46e5;margin-top:4px}.green{color:#166534}.red{color:#991b1b}@media print{button{display:none!important}}</style></head><body>${html}<div style="margin-top:24px;text-align:right"><button onclick="window.print()" style="padding:10px 22px;background:#4f46e5;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:800">Print</button><button onclick="window.close()" style="padding:10px 22px;background:#f3f4f6;color:#374151;border:none;border-radius:8px;cursor:pointer;font-size:14px;margin-left:8px">Close</button></div></body></html>`);
  win.document.close();
}

// ════════════ MAIN APP ════════════
export default function App(){
  const [session,setSession]=useState(()=>getSession());
  const [store,setStore]=useState(null);
  const [data,setData]=useState(null);
  const [licenseRow,setLicenseRow]=useState(null); // current license row for trial banner
  const [loading,setLoading]=useState(false);
  const [view,setView]=useState("dashboard");
  const [saveStatus,setSaveStatus]=useState("");
  const [drawerOpen,setDrawerOpen]=useState(false);
  const [devTokenChecking,setDevTokenChecking]=useState(false);
  const refreshRef=useRef(null);
  const lastPushTs=useRef(sessionStorage.getItem("portal_lastPush")||"0");

  // ── DEV CONSOLE IMPERSONATION ──
  // If a ?devtoken=XXXX param is present, validate it against dev_tokens.
  // On success, sign in as a special read/write "dev view" session scoped
  // to that store — no owner password, no OTP. The token is single-use and
  // gets stripped from the URL immediately so it can't be bookmarked/shared.
  useEffect(()=>{
    const params = new URLSearchParams(window.location.search);
    const devtoken = params.get("devtoken");
    if(!devtoken) return;
    setDevTokenChecking(true);
    (async()=>{
      const storeId = await verifyDevToken(devtoken);
      // Strip the token from the URL regardless of outcome — never leave it visible/bookmarkable
      window.history.replaceState({}, "", window.location.pathname);
      if(storeId){
        const devSession = {email:"dev-console", storeId, isDevView:true};
        saveSession(devSession);
        setSession(devSession);
      }
      setDevTokenChecking(false);
    })();
  },[]);

  const loadData=useCallback(async(storeId)=>{
    setLoading(true);
    const [s,d]=await Promise.all([
      supa.get("stores",{id:storeId}),
      supa.get("store_data",{store_id:storeId}),
    ]);
    setStore(s);

    // Fetch current license row so the trial banner has accurate data
    if(s?.license_id) {
      supa.get("licenses",{id:s.license_id}).then(lic=>setLicenseRow(lic||null)).catch(()=>{});
    } else {
      setLicenseRow(null);
    }

    // ── ONE-TIME IMAGE MIGRATION ──
    // Compress any existing full-size PNG images already stored in the database
    // This runs silently in the background and saves the compressed versions back
    if(d?.products?.length) {
      const needsCompression = d.products.filter(p =>
        p.image && p.image.startsWith("data:image/png") && p.image.length > 50000
      );
      if(needsCompression.length > 0) {
        // Compress each oversized image
        const compressBase64 = (base64, maxSize=300, quality=0.7) => new Promise(resolve => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            let w = img.width, h = img.height;
            if(w > maxSize || h > maxSize) {
              if(w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
              else       { w = Math.round(w * maxSize / h); h = maxSize; }
            }
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", quality));
          };
          img.src = base64;
        });
        const compressed = await Promise.all(
          d.products.map(async p => {
            if(p.image && p.image.startsWith("data:image/png") && p.image.length > 50000) {
              return {...p, image: await compressBase64(p.image)};
            }
            return p;
          })
        );
        d.products = compressed;
        // Save compressed images back to cloud silently
        supa.update("store_data",{store_id:storeId},{products:compressed,updated_at:new Date().toISOString()}).catch(()=>{});
      }
    }

    setData(d); setLoading(false);
    lastPushTs.current=new Date().toISOString();
    sessionStorage.setItem("portal_lastPush",lastPushTs.current);
  },[]);

  useEffect(()=>{
    if(session?.storeId){
      loadData(session.storeId);
      refreshRef.current=setInterval(()=>loadData(session.storeId),15000);
    }
    return()=>clearInterval(refreshRef.current);
  },[session,loadData]);

  // Save field — update Supabase and local data immediately
  const saveField=useCallback(async(field,value)=>{
    if(!session?.storeId)return false;
    setSaveStatus("saving");
    const now=new Date().toISOString();
    const ok=await supa.update("store_data",{store_id:session.storeId},{[field]:value,updated_at:now});
    if(ok){
      setSaveStatus("saved");
      setData(prev=>({...prev,[field]:value,updated_at:now}));
      // Update our last push time so POS knows cloud is newer
      lastPushTs.current=now;
      sessionStorage.setItem("portal_lastPush",now);
    } else { setSaveStatus("error"); }
    setTimeout(()=>setSaveStatus(""),2500);
    return ok;
  },[session]);

  const handleLogin=(sess)=>{saveSession(sess);setSession(sess);};
  const handleLogout=()=>{
    clearSession();setSession(null);setStore(null);setData(null);setView("dashboard");
    // If this was a dev-console session, also wipe any leftover URL params
    window.history.replaceState({}, "", window.location.pathname);
  };

  if(devTokenChecking) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0f0f1a",color:"#9ca3af",fontSize:13}}>
      Verifying access…
    </div>
  );

  if(!session)return<LoginScreen onLogin={handleLogin}/>;

  const theme=data?.theme||{};
  const PRIMARY=theme.primary||"#4f46e5";
  const SIDEBAR=theme.sidebar||"#1a1a2e";
  const BG=theme.bgColor||"#f0f0f8";
  const isOwner=!session?.isDevView; // Dev view is read-only; real owner login gets edit rights

  const NAV=[
    {id:"dashboard",icon:"ti-layout-dashboard",label:"Dashboard"},
    {id:"reports",  icon:"ti-chart-bar",        label:"Reports"},
    {id:"inventory",icon:"ti-box",              label:"Inventory"},
    {id:"orders",   icon:"ti-receipt",          label:"Orders"},
    {id:"accounts", icon:"ti-users",            label:"Accounts"},
    {id:"settings", icon:"ti-settings",         label:"Settings"},
  ];

  const SyncBadge=()=>(
    <div title={saveStatus==="saving"?"Saving…":saveStatus==="saved"?"Saved":saveStatus==="error"?"Save failed":""} style={{width:8,height:8,borderRadius:"50%",background:saveStatus==="saving"?"#f59e0b":saveStatus==="saved"?"#16a34a":saveStatus==="error"?"#dc2626":"transparent",boxShadow:saveStatus==="saved"?"0 0 6px #16a34a":saveStatus==="saving"?"0 0 6px #f59e0b":"none",flexShrink:0,transition:"background 0.3s"}}/>
  );

  return(
    <div style={{minHeight:"100vh",background:BG,fontFamily:"sans-serif"}}>
      {session.isDevView&&(
        <div style={{position:"sticky",top:0,zIndex:200,background:"#dc2626",color:"#fff",padding:"7px 16px",fontSize:12,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <i className="ti ti-tool" style={{fontSize:14}}/>
          DEVELOPER VIEW — {store?.store_name||"Loading…"} — not signed in as the owner
          <button onClick={handleLogout} style={{marginLeft:14,padding:"3px 10px",background:"rgba(255,255,255,0.2)",border:"none",borderRadius:6,color:"#fff",cursor:"pointer",fontSize:11,fontWeight:700}}>Exit</button>
        </div>
      )}
      {/* HEADER */}
      <div style={{background:SIDEBAR,color:"#fff",padding:"0 16px",display:"flex",alignItems:"center",gap:10,height:54,position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 8px rgba(0,0,0,0.3)"}}>
        {/* Hamburger — mobile only */}
        <button onClick={()=>setDrawerOpen(true)} style={{display:"none",background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,0.8)",fontSize:22,padding:4,flexShrink:0,className:"mobile-menu-btn"}} className="mobile-hamburger">
          <i className="ti ti-menu-2"/>
        </button>
        <style>{`@media(max-width:767px){.mobile-hamburger{display:block!important}.desktop-nav{display:none!important}}`}</style>

        {/* Logo */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginRight:4,flexShrink:0}}>
          <div style={{width:28,height:28,borderRadius:7,overflow:"hidden",background:"rgba(255,255,255,0.1)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{theme.logoUrl?<img src={theme.logoUrl} alt="logo" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:7}} onError={e=>{e.target.style.display="none";e.target.nextSibling.style.display="flex";}}/>:<img src="/icons/icon-192.png" alt="POS Pro" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:7}}/>}</div>
          <div>
            <div style={{fontWeight:800,fontSize:11,lineHeight:1}}>{store?.store_name||"POS Pro"}</div>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",marginTop:1}}>Owner Portal</div>
          </div>
        </div>

        {/* Desktop nav */}
        <div className="desktop-nav" style={{display:"flex",gap:1,flex:1,overflowX:"auto",scrollbarWidth:"none"}}>
          {NAV.map(n=>(
            <button key={n.id} onClick={()=>setView(n.id)} style={{padding:"6px 10px",borderRadius:7,border:"none",cursor:"pointer",background:view===n.id?PRIMARY:"transparent",color:view===n.id?"#fff":"rgba(255,255,255,0.55)",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",flexShrink:0}}>
              <i className={`ti ${n.icon}`} style={{fontSize:14}}/><span>{n.label}</span>
            </button>
          ))}
        </div>

        <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0,marginLeft:"auto"}}>
          <SyncBadge/>
          <button onClick={()=>loadData(session.storeId)} title="Refresh" style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:7,padding:"5px 8px",cursor:"pointer",color:"rgba(255,255,255,0.7)",fontSize:16}}><i className={`ti ti-refresh${loading?" ti-spin":""}`}/></button>
          <button onClick={handleLogout} title="Sign out" style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:7,padding:"5px 8px",cursor:"pointer",color:"rgba(255,255,255,0.7)",fontSize:16}}><i className="ti ti-logout"/></button>
        </div>
      </div>

      {/* MOBILE DRAWER */}
      {drawerOpen&&(
        <div style={{position:"fixed",inset:0,zIndex:500}} onClick={()=>setDrawerOpen(false)}>
          <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.5)"}}/>
          <div style={{position:"absolute",left:0,top:0,bottom:0,width:260,background:SIDEBAR,boxShadow:"4px 0 20px rgba(0,0,0,0.4)",display:"flex",flexDirection:"column",padding:"16px 12px"}} onClick={e=>e.stopPropagation()}>
            {/* Drawer header */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,padding:"0 4px"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:34,height:34,borderRadius:9,overflow:"hidden"}}><img src="/icons/icon-192.png" alt="POS Pro" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:9}}/></div>
                <div>
                  <div style={{fontWeight:800,fontSize:14,color:"#fff"}}>{store?.store_name||"POS Pro"}</div>
                  <div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Owner Portal</div>
                </div>
              </div>
              <button onClick={()=>setDrawerOpen(false)} style={{background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,0.5)",fontSize:20}}>
                <i className="ti ti-x"/>
              </button>
            </div>
            {/* Drawer nav items */}
            {NAV.map(n=>(
              <button key={n.id} onClick={()=>{setView(n.id);setDrawerOpen(false);}} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",borderRadius:10,border:"none",cursor:"pointer",background:view===n.id?PRIMARY:"transparent",color:view===n.id?"#fff":"rgba(255,255,255,0.6)",fontSize:14,fontWeight:600,marginBottom:4,textAlign:"left"}}>
                <i className={`ti ${n.icon}`} style={{fontSize:18,flexShrink:0}}/>{n.label}
              </button>
            ))}
            <div style={{marginTop:"auto",padding:"12px 14px",borderTop:"1px solid rgba(255,255,255,0.1)"}}>
              <button onClick={handleLogout} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,border:"none",cursor:"pointer",background:"transparent",color:"rgba(255,255,255,0.5)",fontSize:13,fontWeight:600,width:"100%"}}>
                <i className="ti ti-logout" style={{fontSize:16}}/>Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{maxWidth:1100,margin:"0 auto",padding:"20px 16px"}}>
        {loading&&!data&&<div style={{textAlign:"center",padding:80,color:"#9ca3af"}}><i className="ti ti-loader-2" style={{fontSize:40,display:"block",marginBottom:10}}/>Loading store data…</div>}
        {data&&view==="dashboard"&&<Dashboard store={store} data={data} primary={PRIMARY} licenseRow={licenseRow}/>}
        {data&&view==="reports"  &&<Reports   store={store} data={data} primary={PRIMARY} isOwner={isOwner} saveField={saveField}/>}
        {data&&view==="inventory"&&<Inventory store={store} data={data} session={session} saveField={saveField} primary={PRIMARY}/>}
        {data&&view==="orders"   &&<Orders    store={store} data={data} session={session} saveField={saveField}/>}
        {data&&view==="accounts" &&<Accounts  store={store} data={data} session={session} saveField={saveField}/>}
        {data&&view==="settings" &&<Settings  store={store} data={data} session={session} onRefresh={()=>loadData(session.storeId)}/>}
      </div>
    </div>
  );
}

// ════════════ LOGIN ════════════
function LoginScreen({onLogin}){
  const [screen,setScreen]=useState("email");
  const [email,setEmail]=useState("");
  const [otp,setOtp]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [info,setInfo]=useState("");
  const [countdown,setCountdown]=useState(0);
  const timerRef=useRef(null);

  const startCountdown=()=>{
    setCountdown(60);
    clearInterval(timerRef.current);
    timerRef.current=setInterval(()=>setCountdown(c=>{if(c<=1){clearInterval(timerRef.current);return 0;}return c-1;}),1000);
  };

  const sendOTP=async()=>{
    if(!email.trim()||!/\S+@\S+\.\S+/.test(email)){setError("Enter a valid email address");return;}
    setLoading(true);setError("");setInfo("Checking...");
    const store=await supa.get("stores",{owner_email:email.trim().toLowerCase()});
    if(!store){setError("No account found with this email.");setLoading(false);setInfo("");return;}
    // Block trial accounts from accessing the portal
    if(store.license_id){
      const lic=await supa.get("licenses",{id:store.license_id});
      if(lic?.plan==="trial"){setError("Trial accounts can't access the portal. Please upgrade to a paid plan first.");setLoading(false);setInfo("");return;}
    }
    const result=await sendPortalOTP(email.trim().toLowerCase(),store.store_name,"sign-in");
    setLoading(false);
    if(!result.ok){setError("Failed to send code. Try again.");setInfo("");return;}
    setInfo(result.dev?"[DEV] Check browser console for code":"Code sent! Check your email.");
    setScreen("otp");startCountdown();
  };

  const verifyOTP=async()=>{
    if(!otp||otp.length<6){setError("Enter the 6-digit code");return;}
    setLoading(true);setError("");
    const valid=await verifyPortalOTP(email.trim().toLowerCase(),otp.trim());
    if(!valid){setError("Invalid or expired code.");setLoading(false);return;}
    const store=await supa.get("stores",{owner_email:email.trim().toLowerCase()});
    if(!store){setError("Store not found.");setLoading(false);return;}
    clearInterval(timerRef.current);
    onLogin({storeId:store.id,email:store.owner_email,storeName:store.store_name,ownerName:store.owner_name});
    setLoading(false);
  };

  const BG="linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%)";
  return(
    <div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif",padding:20}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:66,height:66,borderRadius:18,overflow:"hidden",margin:"0 auto 12px",boxShadow:"0 8px 32px rgba(79,70,229,0.5)"}}><img src="/icons/icon-192.png" alt="POS Pro" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:18}}/></div>
          <div style={{fontSize:24,fontWeight:800,color:"#fff"}}>POS Pro</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginTop:3}}>Owner Portal</div>
        </div>
        <div style={{background:"#fff",borderRadius:20,padding:"28px 28px 24px",boxShadow:"0 24px 60px rgba(0,0,0,0.4)"}}>
          {screen==="email"&&(<>
            <div style={{fontWeight:800,fontSize:17,marginBottom:4}}>Sign In</div>
            <div style={{fontSize:13,color:"#9ca3af",marginBottom:20}}>Enter your owner email — we'll send a sign-in code</div>
            <FRow label="Owner Email"><input type="email" value={email} onChange={e=>{setEmail(e.target.value);setError("");}} onKeyDown={e=>e.key==="Enter"&&sendOTP()} placeholder="owner@email.com" style={INP} autoFocus/></FRow>
            <Err msg={error}/>
            {info&&<div style={{marginTop:8,padding:"8px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:12,color:"#166534"}}>{info}</div>}
            <button onClick={sendOTP} disabled={loading} style={{width:"100%",marginTop:16,padding:"12px 0",background:loading?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              {loading?<><i className="ti ti-loader-2" style={{fontSize:17}}/>Sending…</>:<><i className="ti ti-mail" style={{fontSize:17}}/>Send Sign-In Code</>}
            </button>
          </>)}
          {screen==="otp"&&(<>
            <button onClick={()=>{setScreen("email");setOtp("");setError("");setInfo("");clearInterval(timerRef.current);}} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",color:"#6b7280",fontSize:12,fontWeight:600,marginBottom:14,padding:0}}>
              <i className="ti ti-arrow-left" style={{fontSize:14}}/> Back
            </button>
            <div style={{fontWeight:800,fontSize:17,marginBottom:4}}>Enter Your Code</div>
            <div style={{fontSize:13,color:"#9ca3af",marginBottom:6}}>Code sent to:</div>
            <div style={{fontSize:14,fontWeight:700,color:"#4f46e5",marginBottom:14}}>{email}</div>
            {info&&<div style={{marginBottom:12,padding:"8px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:12,color:"#166534"}}>{info}</div>}
            <FRow label="6-Digit Code">
              <input type="text" inputMode="numeric" value={otp} onChange={e=>{setOtp(e.target.value.replace(/\D/g,"").slice(0,6));setError("");}} onKeyDown={e=>e.key==="Enter"&&verifyOTP()} placeholder="000000" style={{...INP,fontSize:26,fontWeight:800,letterSpacing:8,textAlign:"center"}} autoFocus/>
            </FRow>
            <Err msg={error}/>
            <button onClick={verifyOTP} disabled={loading||otp.length<6} style={{width:"100%",marginTop:14,padding:"12px 0",background:loading||otp.length<6?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              {loading?<><i className="ti ti-loader-2" style={{fontSize:17}}/>Verifying…</>:<><i className="ti ti-check" style={{fontSize:17}}/>Sign In</>}
            </button>
            <div style={{marginTop:12,textAlign:"center",fontSize:12,color:"#9ca3af"}}>
              {countdown>0?`Resend code in ${countdown}s`:<button onClick={()=>{setOtp("");sendOTP();}} style={{background:"none",border:"none",cursor:"pointer",color:"#4f46e5",fontSize:12,fontWeight:700}}>Resend Code</button>}
            </div>
          </>)}
        </div>
        <div style={{marginTop:14,textAlign:"center",fontSize:11,color:"rgba(255,255,255,0.25)"}}>POS Pro Owner Portal · client.pospro-portal.com</div>
      </div>
    </div>
  );
}
// ════════════ DASHBOARD ════════════
function Dashboard({store,data,primary,licenseRow}){
  const orders=(data?.orders||[]).filter(o=>o.status==="paid");
  const products=data?.products||[];
  const shifts=data?.shifts||[];
  const activeShift=data?.active_shift;
  const todayOrders=orders.filter(o=>o.dateKey===todayKey());
  const todaySales=todayOrders.reduce((s,o)=>s+o.total,0);
  const weekOrders=orders.filter(o=>o.dateKey>=weekStart());
  const weekSales=weekOrders.reduce((s,o)=>s+o.total,0);
  const lowStock=products.filter(p=>p.active&&computeStockPortal(p,products)>0&&computeStockPortal(p,products)<=5);
  const outOfStock=products.filter(p=>p.active&&computeStockPortal(p,products)<=0);
  const CARDS=[
    {label:"Today's Sales",  value:fmt(todaySales), sub:`${todayOrders.length} orders`,    color:primary,    icon:"ti-currency-peso"},
    {label:"This Week",      value:fmt(weekSales),  sub:`${weekOrders.length} orders`,     color:"#0891b2",  icon:"ti-chart-line"},
    {label:"Total Products", value:products.filter(p=>p.active).length, sub:`${outOfStock.length} out of stock`, color:"#059669", icon:"ti-box"},
    {label:"All Orders",     value:orders.length,   sub:`${shifts.length} shifts recorded`,color:"#d97706",  icon:"ti-receipt"},
  ];
  return(
    <div>
      {/* ── TRIAL BANNER ── */}
      {(()=>{
        // Use the license row fetched on load — more reliable than store.license_code
        if(!licenseRow?.code?.startsWith("TRIAL")||!licenseRow?.trial_expires_at) return null;
        const exp = licenseRow.trial_expires_at;
        const ms = new Date(exp)-new Date();
        const expired = ms<=0;
        const daysLeft = Math.max(0,Math.ceil(ms/(1000*60*60*24)));
        const urgent = daysLeft<=1&&!expired;
        if(expired) return(
          <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:12,padding:"14px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
            <i className="ti ti-clock-off" style={{fontSize:22,color:"#dc2626",flexShrink:0}}/>
            <div>
              <div style={{fontWeight:800,color:"#dc2626",fontSize:14}}>Trial Expired</div>
              <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>Contact your POS Pro provider to purchase a permanent activation code and continue.</div>
            </div>
          </div>
        );
        return(
          <div style={{background:urgent?"#fef2f2":"#fef3c7",border:`1px solid ${urgent?"#fecaca":"#fde68a"}`,borderRadius:12,padding:"14px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
            <i className={`ti ${urgent?"ti-alert-triangle":"ti-clock"}`} style={{fontSize:22,color:urgent?"#dc2626":"#d97706",flexShrink:0}}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:800,color:urgent?"#dc2626":"#92400e",fontSize:14}}>
                {urgent?"Trial expires today!":"Free Trial Active"}
              </div>
              <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>
                {daysLeft} day{daysLeft!==1?"s":""} remaining — expires {new Date(exp).toLocaleDateString("en-PH",{month:"long",day:"numeric",year:"numeric"})}. Contact your provider to upgrade.
              </div>
            </div>
          </div>
        );
      })()}

      {activeShift&&(()=>{
        const shiftOrders=orders.filter(o=>o.shiftId===activeShift.id);
        const shiftSales=shiftOrders.reduce((s,o)=>s+o.total,0);
        const liveBreakdown=shiftOrders.reduce((acc,o)=>{const m=o.payMethod||"cash";acc[m]=(acc[m]||0)+o.total;return acc;},{});
        return(
          <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:"14px 18px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:"#16a34a",boxShadow:"0 0 8px #16a34a",flexShrink:0}}/>
              <b style={{color:"#166534",fontSize:14}}>Shift In Progress</b>
              <span style={{fontSize:12,color:"#6b7280",marginLeft:"auto"}}>{activeShift.startTime}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:Object.keys(liveBreakdown).length>0?10:0}}>
              {[{label:"Cashier",value:activeShift.cashier,color:"#166534"},{label:"Opening Cash",value:fmt(activeShift.openCash),color:"#374151"},{label:"Shift Sales",value:fmt(shiftSales),color:primary||"#4f46e5"},{label:"Orders",value:`${shiftOrders.length} orders`,color:"#374151"}].map(r=>(
                <div key={r.label} style={{background:"#fff",borderRadius:8,padding:"8px 12px"}}>
                  <div style={{fontSize:10,color:"#9ca3af",fontWeight:600,textTransform:"uppercase",letterSpacing:0.4,marginBottom:3}}>{r.label}</div>
                  <div style={{fontSize:14,fontWeight:800,color:r.color}}>{r.value}</div>
                </div>
              ))}
            </div>
            {Object.keys(liveBreakdown).length>0&&(
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                <span style={{fontSize:10,color:"#6b7280",fontWeight:600,alignSelf:"center",textTransform:"uppercase",letterSpacing:0.4}}>Payments:</span>
                {Object.entries(liveBreakdown).map(([method,amt])=>(
                  <span key={method} style={{fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:8,background:method==="cash"?"#dcfce7":"#eff6ff",color:method==="cash"?"#166534":"#1e40af"}}>
                    {method.charAt(0).toUpperCase()+method.slice(1)}: {fmt(amt)}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:14,marginBottom:20}}>
        {CARDS.map(c=>(
          <div key={c.label} style={{background:"#fff",borderRadius:14,padding:18,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
              <div style={{fontSize:11,color:"#9ca3af",fontWeight:600}}>{c.label}</div>
              <div style={{width:34,height:34,borderRadius:9,background:c.color+"18",display:"flex",alignItems:"center",justifyContent:"center"}}><i className={`ti ${c.icon}`} style={{fontSize:17,color:c.color}}/></div>
            </div>
            <div style={{fontSize:24,fontWeight:800,color:c.color}}>{c.value}</div>
            <div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>{c.sub}</div>
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(290px,1fr))",gap:16}}>
        {/* Today's orders */}
        <Card>
          <SectionTitle>Today's Orders ({todayOrders.length})</SectionTitle>
          {todayOrders.length===0&&<div style={{fontSize:13,color:"#9ca3af",textAlign:"center",padding:"16px 0"}}>No orders today yet</div>}
          {todayOrders.slice(0,8).map(o=>(
            <div key={o.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid #f3f4f6"}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,fontFamily:"monospace"}}>{o.id}</div>
                <div style={{fontSize:11,color:"#9ca3af"}}>{o.cashier}{o.orderType?` · ${o.orderType}`:""} · {o.payMethod?.toUpperCase()}</div>
              </div>
              <div style={{fontWeight:800,fontSize:13,color:primary}}>{fmt(o.total)}</div>
            </div>
          ))}
          {todayOrders.length>8&&<div style={{fontSize:11,color:"#9ca3af",marginTop:8,textAlign:"center"}}>+{todayOrders.length-8} more orders</div>}
        </Card>
        {/* Stock alerts */}
        <Card>
          <SectionTitle>Stock Alerts</SectionTitle>
          {outOfStock.length===0&&lowStock.length===0&&<div style={{fontSize:13,color:"#16a34a",textAlign:"center",padding:"12px 0"}}>✅ All products well stocked</div>}
          {outOfStock.map(p=><div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:"#fef2f2",borderRadius:8,marginBottom:6}}><span style={{fontSize:13,fontWeight:600}}>{p.name}</span><span style={{fontSize:11,fontWeight:800,color:"#991b1b",background:"#fee2e2",padding:"2px 8px",borderRadius:10}}>OUT</span></div>)}
          {lowStock.map(p=><div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:"#fffbeb",borderRadius:8,marginBottom:6}}><span style={{fontSize:13,fontWeight:600}}>{p.name}</span><span style={{fontSize:11,fontWeight:800,color:"#92400e",background:"#fef3c7",padding:"2px 8px",borderRadius:10}}>{p.stock} left</span></div>)}
        </Card>
        {/* Recent shifts */}
        {shifts.length>0&&<Card>
          <SectionTitle>Recent Shifts</SectionTitle>
          {shifts.slice(0,5).map(s=>(
            <div key={s.id} style={{padding:"7px 0",borderBottom:"1px solid #f3f4f6"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:13,fontWeight:700}}>{s.cashier}</div>
                <div style={{fontSize:13,fontWeight:800,color:s.overShort>=0?"#166534":"#991b1b"}}>{s.overShort>=0?"+":""}{fmt(s.overShort)}</div>
              </div>
              <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>{s.startTime} · Sales: {fmt(s.totalSales)} · {s.shiftOrders} orders</div>
            </div>
          ))}
        </Card>}
      </div>
    </div>
  );
}

// ════════════ REPORTS ════════════

// ── PORTAL SHIFTS TAB ──
function PortalShiftsTab({shifts,filteredShifts,fmt,primary,shiftPeriod,setShiftPeriod,shiftFrom,setShiftFrom,shiftTo,setShiftTo,shiftCashier,setShiftCashier,isOwner,onSaveShifts}){
  const cashierList=[...new Set(shifts.map(s=>s.cashier).filter(Boolean))].sort();
  const [editShift,setEditShift]=useState(null);
  const [editActual,setEditActual]=useState("");
  const [editExpenses,setEditExpenses]=useState([]);
  const [editNotes,setEditNotes]=useState("");
  const [saveToast,setSaveToast]=useState(false);
  const openEdit=(s)=>{setEditShift(s);setEditActual(String(s.closeCash||0));setEditExpenses(s.expenses?.length?[...s.expenses]:[{name:"",amount:""}]);setEditNotes(s.notes||"");};
  const savePartialEdit=()=>{
    const actual=parseFloat(editActual)||0;
    const expenses=editExpenses.filter(e=>e.name&&parseFloat(e.amount)>0);
    const totalExp=expenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
    const expected=(parseFloat(editShift.openCash)||0)+(editShift.cashSales||0);
    const updated={...editShift,closeCash:actual,actualCash:actual,expenses,totalExpenses:totalExp,overShort:actual-expected-totalExp,notes:editNotes,editLocked:true,status:"closed"};
    if(onSaveShifts) onSaveShifts(updated);
    setEditShift(null);
    setSaveToast(true);
    setTimeout(()=>setSaveToast(false),2500);
  };
  const filteredSales=filteredShifts.reduce((s,x)=>s+(x.totalSales||0),0);
  const P=primary||"#4f46e5";
  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center",marginBottom:4}}>
        {[{v:"all",l:"All"},{v:"today",l:"Today"},{v:"week",l:"This Week"},{v:"month",l:"This Month"},{v:"custom",l:"Custom"}].map(o=>(
          <button key={o.v} onClick={()=>setShiftPeriod(o.v)} style={{padding:"4px 12px",borderRadius:6,border:`1px solid ${shiftPeriod===o.v?P:"#e5e7eb"}`,background:shiftPeriod===o.v?P:"#fff",color:shiftPeriod===o.v?"#fff":"#6b7280",fontSize:12,fontWeight:700,cursor:"pointer"}}>{o.l}</button>
        ))}
        {shiftPeriod==="custom"&&<>
          <input type="date" value={shiftFrom} onChange={e=>setShiftFrom(e.target.value)} style={{padding:"4px 8px",border:"1px solid #e5e7eb",borderRadius:6,fontSize:12}}/>
          <span style={{fontSize:12,color:"#9ca3af"}}>to</span>
          <input type="date" value={shiftTo} onChange={e=>setShiftTo(e.target.value)} style={{padding:"4px 8px",border:"1px solid #e5e7eb",borderRadius:6,fontSize:12}}/>
        </>}
        {cashierList.length>1&&(
          <select value={shiftCashier} onChange={e=>setShiftCashier(e.target.value)} style={{padding:"4px 10px",border:"1px solid #e5e7eb",borderRadius:6,fontSize:12,fontWeight:700,color:"#374151",background:"#fff",cursor:"pointer"}}>
            <option value="all">All Staff</option>
            {cashierList.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {filteredShifts.length!==shifts.length&&(
          <span style={{fontSize:11,color:"#9ca3af",marginLeft:4}}>{filteredShifts.length} of {shifts.length} shifts · {fmt(filteredSales)} total</span>
        )}
      </div>
      {filteredShifts.length===0&&<Card><div style={{textAlign:"center",color:"#9ca3af",padding:"24px 0",fontSize:13}}>{shifts.length===0?"No completed shifts yet":"No shifts in selected period"}</div></Card>}
      {filteredShifts.map(s=>(
        <Card key={s.id} style={{border:s.status==="partial"&&!s.editLocked?"1px solid #fcd34d":undefined}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,flexWrap:"wrap",gap:6}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <div style={{fontWeight:800,fontSize:13}}>{s.cashier}</div>
                {s.status==="partial"&&!s.editLocked&&<span style={{fontSize:10,fontWeight:800,padding:"1px 7px",borderRadius:8,background:"#fef3c7",color:"#92400e"}}>PARTIAL</span>}
                {s.closedReason==="auto_24h"&&<span style={{fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:8,background:"#f3f4f6",color:"#6b7280"}}>AUTO-ENDED</span>}
              </div>
              <div style={{fontSize:11,color:"#9ca3af"}}>{s.startTime} → {s.endTime}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              {s.status==="partial"&&!s.editLocked&&isOwner&&(
                <button onClick={()=>openEdit(s)} style={{padding:"3px 10px",background:"#fef3c7",border:"1px solid #fcd34d",borderRadius:7,cursor:"pointer",fontSize:11,fontWeight:700,color:"#92400e"}}>
                  <i className="ti ti-pencil" style={{fontSize:10,marginRight:3}}/>Edit
                </button>
              )}
              {s.status==="partial"&&s.editLocked&&<span style={{fontSize:10,color:"#9ca3af",fontStyle:"italic"}}>✓ Finalized</span>}
              {(s.status!=="partial"||s.editLocked)&&(
                <span style={{fontSize:13,fontWeight:800,padding:"3px 10px",borderRadius:10,background:s.overShort>=0?"#f0fdf4":"#fef2f2",color:s.overShort>=0?"#166534":"#991b1b"}}>{s.overShort>=0?"+":""}{fmt(s.overShort)}</span>
              )}
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(90px,1fr))",gap:7,marginBottom:s.payBreakdown&&Object.keys(s.payBreakdown).length>0?8:0}}>
            {[{l:"Sales",v:fmt(s.totalSales)},{l:"Opening",v:fmt(s.openCash)},{l:"Closing",v:s.status==="partial"&&!s.editLocked?"—":fmt(s.closeCash)},{l:"Expenses",v:fmt(s.totalExpenses||0)},{l:"Orders",v:s.shiftOrders}].map(m=>(
              <div key={m.l} style={{background:"#f9fafb",borderRadius:8,padding:"6px 10px"}}><div style={{fontSize:10,color:"#9ca3af"}}>{m.l}</div><div style={{fontSize:13,fontWeight:800}}>{m.v}</div></div>
            ))}
          </div>
          {s.payBreakdown&&Object.keys(s.payBreakdown).length>0&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
              <span style={{fontSize:10,color:"#9ca3af",fontWeight:600,alignSelf:"center"}}>PAYMENTS:</span>
              {Object.entries(s.payBreakdown).map(([method,amt])=>(
                <span key={method} style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:8,background:method==="cash"?"#dcfce7":"#eff6ff",color:method==="cash"?"#166534":"#1e40af"}}>
                  {method.charAt(0).toUpperCase()+method.slice(1)}: {fmt(amt)}
                </span>
              ))}
            </div>
          )}
          {s.expenses?.length>0&&(
            <div style={{marginTop:8,borderTop:"1px dashed #e5e7eb",paddingTop:8}}>
              <div style={{fontSize:10,fontWeight:800,color:"#9ca3af",marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Expenses</div>
              {s.expenses.map((e,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#6b7280",padding:"1px 0"}}><span>{e.name}</span><span>{fmt(parseFloat(e.amount)||0)}</span></div>
              ))}
            </div>
          )}
          {s.notes&&<div style={{marginTop:8,fontSize:12,color:"#6b7280",fontStyle:"italic"}}>Note: {s.notes}</div>}
          {s.status==="partial"&&!s.editLocked&&isOwner&&(
            <div style={{marginTop:8,padding:"7px 10px",background:"#fffbeb",border:"1px dashed #fcd34d",borderRadius:7,fontSize:11,color:"#92400e"}}>
              ⚠ Partial shift — closing cash not yet recorded. Tap Edit to finalize.
            </div>
          )}
        </Card>
      ))}
      {saveToast&&(
        <div style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",zIndex:400,background:"#15803d",color:"#fff",padding:"10px 22px",borderRadius:10,fontSize:13,fontWeight:700,boxShadow:"0 4px 16px rgba(0,0,0,0.2)",pointerEvents:"none"}}>
          ✓ Shift finalized and saved
        </div>
      )}
      {/* Partial Shift Edit Modal */}
      {editShift&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:16}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,width:"100%",maxWidth:400,maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{fontWeight:800,fontSize:15,marginBottom:4}}>Edit Partial Shift</div>
            <div style={{fontSize:12,color:"#6b7280",marginBottom:14}}>One-time edit for <b>{editShift.cashier}</b>'s partial shift. Locked after saving.</div>
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14,background:"#f9fafb",borderRadius:8,padding:"10px 12px"}}>
              {[{l:"Cashier",v:editShift.cashier},{l:"Started",v:editShift.startTime},{l:"Orders",v:editShift.shiftOrders},{l:"Sales",v:fmt(editShift.totalSales)},{l:"Opening Cash",v:fmt(editShift.openCash)}].map(r=>(
                <div key={r.l} style={{display:"flex",justifyContent:"space-between",fontSize:12}}><span style={{color:"#9ca3af"}}>{r.l}</span><span style={{fontWeight:700}}>{r.v}</span></div>
              ))}
            </div>
            <div style={{marginBottom:12}}>
              <label style={{fontSize:11,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:0.5,display:"block",marginBottom:5}}>Actual Cash in Drawer (₱)</label>
              <input type="number" value={editActual} onChange={e=>setEditActual(e.target.value)}
                style={{width:"100%",padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:16,fontWeight:700,outline:"none",boxSizing:"border-box"}}/>
            </div>
            <div style={{marginBottom:12}}>
              <label style={{fontSize:11,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:0.5,display:"block",marginBottom:5}}>Expenses</label>
              {editExpenses.map((e,i)=>(
                <div key={i} style={{display:"flex",gap:6,marginBottom:6}}>
                  <input value={e.name} onChange={ev=>{const ex=[...editExpenses];ex[i]={...ex[i],name:ev.target.value};setEditExpenses(ex);}} placeholder="Description" style={{flex:2,padding:"7px 10px",border:"1px solid #e5e7eb",borderRadius:7,fontSize:12,outline:"none"}}/>
                  <input type="number" value={e.amount} onChange={ev=>{const ex=[...editExpenses];ex[i]={...ex[i],amount:ev.target.value};setEditExpenses(ex);}} placeholder="₱0" style={{flex:1,padding:"7px 10px",border:"1px solid #e5e7eb",borderRadius:7,fontSize:12,outline:"none"}}/>
                  <button onClick={()=>setEditExpenses(editExpenses.filter((_,j)=>j!==i))} style={{padding:"4px 8px",border:"1px solid #fecaca",borderRadius:7,cursor:"pointer",background:"#fef2f2",color:"#dc2626",fontSize:12}}>✕</button>
                </div>
              ))}
              <button onClick={()=>setEditExpenses([...editExpenses,{name:"",amount:""}])} style={{fontSize:12,color:"#4f46e5",background:"none",border:"none",cursor:"pointer",fontWeight:700}}>+ Add expense</button>
            </div>
            <div style={{marginBottom:16}}>
              <label style={{fontSize:11,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:0.5,display:"block",marginBottom:5}}>Notes (optional)</label>
              <textarea value={editNotes} onChange={e=>setEditNotes(e.target.value)} placeholder="Any notes about this shift..." rows={2}
                style={{width:"100%",padding:"8px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:12,outline:"none",resize:"vertical",boxSizing:"border-box"}}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setEditShift(null)} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Cancel</button>
              <button onClick={savePartialEdit} style={{flex:2,padding:"10px 0",background:"#d97706",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>Save & Lock</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Reports({store,data,primary,isOwner,saveField}){
  const [period,setPeriod]=useState("today");
  const [tab,setTab]=useState("sales");
  const [from,setFrom]=useState("");const [to,setTo]=useState("");
  const [payFilter,setPayFilter]=useState("all");
  const [birMonth,setBirMonth]=useState(new Date().toISOString().slice(0,7));
  // Shift filter state lifted here so doPrintShifts can use filteredShifts
  const [shiftPeriod,setShiftPeriod]=useState("all");
  const [shiftFrom,setShiftFrom]=useState("");
  const [shiftTo,setShiftTo]=useState("");
  const [shiftCashier,setShiftCashier]=useState("all");
  const allOrders=(data?.orders||[]).filter(o=>o.status==="paid");
  const shifts=data?.shifts||[];
  const now=new Date();
  const todayStr=toLocalDateKey(now);
  const weekStartStr=toLocalDateKey(new Date(now.getFullYear(),now.getMonth(),now.getDate()-now.getDay()));
  const monthStartStr=toLocalDateKey(new Date(now.getFullYear(),now.getMonth(),1));
  const filteredShifts=shifts.filter(s=>{
    const d=(s.startDateKey||s.startTime||"").slice(0,10);
    if(shiftPeriod==="today")  return d===todayStr;
    if(shiftPeriod==="week")   return d>=weekStartStr;
    if(shiftPeriod==="month")  return d>=monthStartStr;
    if(shiftPeriod==="custom") return(!shiftFrom||d>=shiftFrom)&&(!shiftTo||d<=shiftTo);
    return true;
  }).filter(s=>shiftCashier==="all"||s.cashier===shiftCashier).sort((a,b)=>new Date(b.startTime)-new Date(a.startTime));
  const inPeriod=o=>{
    if(period==="today")  return o.dateKey===todayKey();
    if(period==="week")   return o.dateKey>=weekStart();
    if(period==="month")  return o.dateKey>=monthStart();
    if(period==="all")    return true;
    if(period==="custom") return(!from||o.dateKey>=from)&&(!to||o.dateKey<=to);
    return true;
  };
  const orders=allOrders.filter(o=>inPeriod(o)&&(payFilter==="all"||o.payMethod===payFilter));
  const totalSales=orders.reduce((s,o)=>s+o.total,0);
  const avg=orders.length?totalSales/orders.length:0;
  const payBreakdown={cash:0,gcash:0,maya:0,card:0};
  allOrders.filter(inPeriod).forEach(o=>{if(payBreakdown[o.payMethod]!==undefined)payBreakdown[o.payMethod]+=o.total;});
  const prodSales={};orders.forEach(o=>o.items?.forEach(i=>{prodSales[i.name]=(prodSales[i.name]||{qty:0,rev:0});prodSales[i.name].qty+=i.qty;prodSales[i.name].rev+=i.price*i.qty;}));
  const topProds=Object.entries(prodSales).sort((a,b)=>b[1].rev-a[1].rev).slice(0,10);
  const cashierS={};orders.forEach(o=>{cashierS[o.cashier]=(cashierS[o.cashier]||{n:0,rev:0});cashierS[o.cashier].n++;cashierS[o.cashier].rev+=o.total;});
  const typeS={};orders.forEach(o=>{if(o.orderType){typeS[o.orderType]=(typeS[o.orderType]||0)+o.total;}});
  const PERIODS=[{k:"today",l:"Today"},{k:"week",l:"Week"},{k:"month",l:"Month"},{k:"all",l:"All"},{k:"custom",l:"Custom"}];
  const periodLabel=PERIODS.find(p=>p.k===period)?.l||period;
  // BIR
  const birOrders=allOrders.filter(o=>o.dateKey?.startsWith(birMonth));
  const birGross=birOrders.reduce((s,o)=>s+o.total,0);
  const birVat=birOrders.reduce((s,o)=>s+(o.vatAmt||0),0);
  const birVatable=birOrders.filter(o=>o.vatAmt>0).reduce((s,o)=>s+(o.total-o.vatAmt),0);
  const birExempt=birOrders.filter(o=>!o.vatAmt).reduce((s,o)=>s+o.total,0);
  const doPrintSales=()=>{
    const pRows=topProds.map(([n,d],i)=>`<tr><td>#${i+1} ${n}</td><td class="right">${d.qty}</td><td class="right bold">${fmt(d.rev)}</td></tr>`).join("");
    const cRows=Object.entries(cashierS).map(([n,d])=>`<tr><td>${n}</td><td class="right">${d.n}</td><td class="right bold">${fmt(d.rev)}</td></tr>`).join("");
    const oRows=orders.slice(0,100).map(o=>`<tr><td style="font-family:monospace;font-size:11px">${o.id}</td><td>${o.date}</td><td>${o.cashier}</td><td>${o.payMethod?.toUpperCase()}</td><td class="right bold">${fmt(o.total)}</td></tr>`).join("");
    const payRows=Object.entries(payBreakdown).filter(([,v])=>v>0).map(([k,v])=>`<tr><td>${k.toUpperCase()}</td><td class="right bold">${fmt(v)}</td></tr>`).join("");
    printReport(`<h1>Sales Report — ${periodLabel}${payFilter!=="all"?` · ${payFilter.toUpperCase()}`:""}</h1><p class="meta">Store: ${store?.store_name} | ${new Date().toLocaleString("en-PH")} | ${orders.length} orders</p><div class="summary"><div class="card"><div class="card-label">Total Sales</div><div class="card-val">${fmt(totalSales)}</div></div><div class="card"><div class="card-label">Orders</div><div class="card-val">${orders.length}</div></div><div class="card"><div class="card-label">Avg Order</div><div class="card-val">${fmt(avg)}</div></div></div>${payRows?`<h2>By Payment Method</h2><table><thead><tr><th>Method</th><th class="right">Total</th></tr></thead><tbody>${payRows}</tbody></table>`:""}${topProds.length?`<h2>Top Products</h2><table><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Revenue</th></tr></thead><tbody>${pRows}</tbody></table>`:""}${Object.keys(cashierS).length?`<h2>By Cashier</h2><table><thead><tr><th>Cashier</th><th class="right">Orders</th><th class="right">Revenue</th></tr></thead><tbody>${cRows}</tbody></table>`:""}${orders.length?`<h2>Orders</h2><table><thead><tr><th>Order ID</th><th>Date</th><th>Cashier</th><th>Payment</th><th class="right">Total</th></tr></thead><tbody>${oRows}</tbody></table>`:""}`,`Sales Report — ${store?.store_name}`);
  };
  const doPrintShifts=()=>{
    const rows=filteredShifts.map(s=>{
      const payRow=s.payBreakdown&&Object.keys(s.payBreakdown).length>0
        ?`<tr><td colspan="8" style="padding:2px 8px 6px;font-size:10px;color:#6b7280;border-bottom:1px solid #e5e7eb">Payments: ${Object.entries(s.payBreakdown).map(([m,a])=>`<span style="background:${m==="cash"?"#dcfce7":"#eff6ff"};color:${m==="cash"?"#166534":"#1e40af"};padding:1px 6px;border-radius:4px;font-weight:700;margin-right:4px">${m.charAt(0).toUpperCase()+m.slice(1)}: ${fmt(a)}</span>`).join("")}</td></tr>`
        :"";
      return `<tr><td>${s.cashier}</td><td style="font-size:10px">${s.startTime}<br/>${s.endTime}</td><td class="right">${s.shiftOrders}</td><td class="right">${fmt(s.openCash)}</td><td class="right">${fmt(s.totalSales)}</td><td class="right">${fmt(s.totalExpenses||0)}</td><td class="right">${fmt(s.closeCash)}</td><td class="right ${s.overShort>=0?"green":"red"}">${s.overShort>=0?"+":""}${fmt(s.overShort)}</td></tr>${payRow}`;
    }).join("");
    printReport(`<h1>Shift Report</h1><p class="meta">Store: ${store?.store_name} | ${filteredShifts.length} shifts</p><table><thead><tr><th>Cashier</th><th>Period</th><th class="right">Orders</th><th class="right">Opening</th><th class="right">Sales</th><th class="right">Expenses</th><th class="right">Closing</th><th class="right">Over/Short</th></tr></thead><tbody>${rows}</tbody></table>`,`Shift Report — ${store?.store_name}`);
  };
  const doPrintBIR=()=>{
    printReport(`<h1>BIR Tax Reference — ${birMonth}</h1><p class="meta">Store: ${store?.store_name} | For reference only</p><table><thead><tr><th>Category</th><th class="right">Amount</th></tr></thead><tbody><tr><td>Gross Sales</td><td class="right bold">${fmt(birGross)}</td></tr><tr><td>VATable Sales</td><td class="right">${fmt(birVatable)}</td></tr><tr><td><b>Output VAT (12%)</b></td><td class="right bold" style="color:#4f46e5">${fmt(birVat)}</td></tr><tr><td>VAT-Exempt Sales</td><td class="right">${fmt(birExempt)}</td></tr><tr><td>Zero-Rated</td><td class="right">₱0.00</td></tr><tr><td>Total Orders</td><td class="right">${birOrders.length}</td></tr></tbody></table><div style="margin-top:14px;padding:10px 14px;background:#fef3c7;border-radius:8px;font-size:11px;color:#92400e">⚠️ For reference only. Consult your licensed accountant for official BIR filings.</div>`,`BIR Tax — ${store?.store_name}`);
  };
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          {[{k:"sales",l:"Sales"},{k:"shifts",l:"Shifts"},{k:"bir",l:"BIR Tax"}].map(t=><button key={t.k} onClick={()=>setTab(t.k)} style={{padding:"5px 14px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:12,fontWeight:700,borderColor:tab===t.k?primary:"#e5e7eb",background:tab===t.k?primary:"#fff",color:tab===t.k?"#fff":"#6b7280"}}>{t.l}</button>)}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          {tab==="sales"&&(<>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {PERIODS.map(p=><button key={p.k} onClick={()=>setPeriod(p.k)} style={{padding:"4px 9px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:700,borderColor:period===p.k?primary:"#e5e7eb",background:period===p.k?primary:"#fff",color:period===p.k?"#fff":"#6b7280"}}>{p.l}</button>)}
            </div>
            <select value={payFilter} onChange={e=>setPayFilter(e.target.value)} style={{padding:"4px 8px",border:"1px solid #e5e7eb",borderRadius:6,fontSize:11,background:"#f9fafb",cursor:"pointer"}}>
              <option value="all">All Payments</option>
              <option value="cash">Cash</option>
              <option value="gcash">GCash</option>
              <option value="maya">Maya</option>
              <option value="card">Card</option>
            </select>
          </>)}
          {tab==="bir"&&<input type="month" value={birMonth} onChange={e=>setBirMonth(e.target.value)} style={{...INP,width:"auto",padding:"4px 8px",fontSize:12}}/>}
          <button onClick={tab==="sales"?doPrintSales:tab==="shifts"?doPrintShifts:doPrintBIR} style={{padding:"5px 12px",background:"#374151",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:5}}><i className="ti ti-printer" style={{fontSize:14}}/>Print</button>
        </div>
      </div>
      {tab==="sales"&&period==="custom"&&(
        <Card style={{marginBottom:14,padding:"12px 16px"}}>
          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}><label style={{...LBL,margin:0}}>From</label><input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={{...INP,width:"auto",padding:"5px 9px"}}/></div>
            <div style={{display:"flex",alignItems:"center",gap:6}}><label style={{...LBL,margin:0}}>To</label><input type="date" value={to} onChange={e=>setTo(e.target.value)} style={{...INP,width:"auto",padding:"5px 9px"}}/></div>
            <button onClick={()=>{setFrom("");setTo("");}} style={{padding:"5px 10px",border:"1px solid #e5e7eb",borderRadius:6,cursor:"pointer",fontSize:11,background:"#f9fafb",color:"#6b7280"}}>Clear</button>
          </div>
        </Card>
      )}
      {tab==="sales"&&<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:18}}>
          {[{l:"Total Sales",v:fmt(totalSales),c:primary},{l:"Orders",v:orders.length,c:"#0891b2"},{l:"Avg Order",v:fmt(avg),c:"#059669"}].map(m=>(
            <Card key={m.l} style={{marginBottom:0}}><div style={{fontSize:11,color:"#9ca3af",marginBottom:5}}>{m.l}</div><div style={{fontSize:22,fontWeight:800,color:m.c}}>{m.v}</div></Card>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:14}}>
          <Card><SectionTitle>Top Products</SectionTitle>
            {topProds.length===0&&<div style={{fontSize:13,color:"#9ca3af",textAlign:"center",padding:"12px 0"}}>No data</div>}
            {topProds.map(([name,d],i)=>(
              <div key={name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #f3f4f6"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:10,fontWeight:800,color:"#d1d5db",minWidth:20}}>#{i+1}</span><div><div style={{fontSize:12,fontWeight:700}}>{name}</div><div style={{fontSize:10,color:"#9ca3af"}}>{d.qty} sold</div></div></div>
                <span style={{fontWeight:800,fontSize:12,color:primary}}>{fmt(d.rev)}</span>
              </div>
            ))}
          </Card>
          <Card><SectionTitle>By Cashier</SectionTitle>
            {Object.keys(cashierS).length===0&&<div style={{fontSize:13,color:"#9ca3af",textAlign:"center",padding:"12px 0"}}>No data</div>}
            {Object.entries(cashierS).sort((a,b)=>b[1].rev-a[1].rev).map(([name,d])=>(
              <div key={name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:"#f9fafb",borderRadius:8,marginBottom:6}}>
                <div><div style={{fontSize:13,fontWeight:700}}>{name}</div><div style={{fontSize:11,color:"#9ca3af"}}>{d.n} orders</div></div>
                <span style={{fontWeight:800,fontSize:12,color:primary}}>{fmt(d.rev)}</span>
              </div>
            ))}
          </Card>
          {Object.keys(typeS).length>0&&<Card><SectionTitle>By Order Type</SectionTitle>
            {Object.entries(typeS).map(([t,v])=>(
              <div key={t} style={{display:"flex",justifyContent:"space-between",padding:"6px 10px",background:"#f9fafb",borderRadius:6,marginBottom:6}}>
                <span style={{fontSize:12,fontWeight:700,color:"#5b21b6"}}>{t}</span><span style={{fontSize:12,fontWeight:800}}>{fmt(v)}</span>
              </div>
            ))}
          </Card>}
        </div>
      </>}
      {tab==="shifts"&&
              <PortalShiftsTab shifts={shifts} filteredShifts={filteredShifts} fmt={fmt} primary={primary} shiftPeriod={shiftPeriod} setShiftPeriod={setShiftPeriod} shiftFrom={shiftFrom} setShiftFrom={setShiftFrom} shiftTo={shiftTo} setShiftTo={setShiftTo} shiftCashier={shiftCashier} setShiftCashier={setShiftCashier} isOwner={isOwner} onSaveShifts={(updated)=>{
                const allShifts=data?.shifts||[];
                const newShifts=[updated,...allShifts.filter(s=>s.id!==updated.id)];
                saveField("shifts",newShifts);
              }}/>}
      {tab==="bir"&&(
        <div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10,marginBottom:14}}>
            {[{l:"Gross Sales",v:fmt(birGross)},{l:"Output VAT (12%)",v:fmt(birVat),bold:true},{l:"VATable Sales",v:fmt(birVatable)},{l:"VAT-Exempt",v:fmt(birExempt)},{l:"Total Orders",v:birOrders.length}].map(r=>(
              <div key={r.l} style={{background:"#fff",borderRadius:10,padding:14,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                <div style={{fontSize:10,color:"#9ca3af",marginBottom:4}}>{r.l}</div>
                <div style={{fontSize:r.bold?20:16,fontWeight:800,color:r.bold?primary:"#111"}}>{r.v}</div>
              </div>
            ))}
          </div>
          <div style={{background:"#fef3c7",border:"1px solid #fde68a",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#92400e"}}>
            ⚠️ <b>For reference only.</b> Consult your licensed accountant for official BIR Form 2550M/2550Q filings.
          </div>
        </div>
      )}
    </div>
  );
}
// ════════════ INVENTORY ════════════
function Inventory({store,data,session,primary}){
  const products=data?.products||[];
  const categories=data?.categories||[];
  const [search,setSearch]=useState("");
  const [catFilter,setCat]=useState("All");
  const filtered=products.filter(p=>
    (catFilter==="All"||p.category===catFilter)&&
    (p.name.toLowerCase().includes(search.toLowerCase())||p.sku?.includes(search))
  );
  const fmt=(n)=>`₱${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div style={{fontWeight:800,fontSize:18}}>Inventory <span style={{fontSize:13,fontWeight:600,color:"#9ca3af"}}>({products.filter(p=>p.active).length} active / {products.length} total)</span></div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name or SKU…" style={{...INP,width:220,padding:"7px 12px"}}/>
      </div>

      {/* Read-only notice */}
      <div style={{fontSize:11,color:"#9ca3af",marginBottom:12,padding:"7px 12px",background:"#f9fafb",borderRadius:8,border:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:6}}>
        <i className="ti ti-lock" style={{fontSize:12}}/>Inventory is view-only in the portal. Use the POS app to add, edit, or delete products.
      </div>

      {/* Category filters */}
      <div style={{display:"flex",gap:5,marginBottom:14,flexWrap:"wrap"}}>
        {["All",...categories].map(c=>(
          <button key={c} onClick={()=>setCat(c)} style={{padding:"4px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:700,borderColor:catFilter===c?(primary||"#4f46e5"):"#e5e7eb",background:catFilter===c?(primary||"#4f46e5"):"#fff",color:catFilter===c?"#fff":"#6b7280"}}>{c}</button>
        ))}
      </div>

      {/* Product table */}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
        <table style={{width:"100%",minWidth:580,borderCollapse:"collapse",fontSize:13}}>
          <thead>
            <tr style={{background:"#f9fafb"}}>
              {["Product","Category","Price","Stock","SKU","Status"].map(h=>(
                <th key={h} style={{padding:"9px 12px",textAlign:"left",fontWeight:700,fontSize:11,color:"#6b7280",borderBottom:"1px solid #e5e7eb"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(p=>(
              <tr key={p.id} style={{borderBottom:"0.5px solid #f3f4f6"}}>
                <td style={{padding:"10px 12px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:36,height:36,borderRadius:8,overflow:"hidden",background:"#f3f4f6",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {p.image?<img src={p.image} alt={p.name} style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<i className="ti ti-photo" style={{fontSize:16,color:"#d1d5db"}}/>}
                    </div>
                    <div>
                      <span style={{fontWeight:600}}>{p.name}</span>
                      <div style={{display:"flex",gap:4,marginTop:3,flexWrap:"wrap"}}>
                        {p.recipe?.length>0&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:8,background:"#e0f2fe",color:"#0891b2"}}>{p.recipe.length} inclusions</span>}
                        {p.recipe?.length>0&&p.stockMode==="auto"&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:8,background:"#f0fdf4",color:"#16a34a"}}>⚙ auto stock</span>}
                        {p.showInPOS===false&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:8,background:"#fef3c7",color:"#92400e"}}>Hidden from POS</span>}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{padding:"10px 12px",color:"#6b7280"}}>{p.category}</td>
                <td style={{padding:"10px 12px",fontWeight:700,color:primary||"#4f46e5"}}>{fmt(p.price)}</td>
                <td style={{padding:"10px 12px"}}>
                  {(()=>{
                    const stock = p.stockMode==="auto"&&p.recipe?.length
                      ? Math.min(...p.recipe.map(r=>{const ing=products.find(x=>x.id===r.productId);return ing?Math.floor((ing.stock||0)/r.qty):0}))
                      : (p.stock||0);
                    return(<div style={{display:"flex",alignItems:"center",gap:4}}>
                      <span style={{fontWeight:700,color:stock===0?"#dc2626":stock<10?"#f59e0b":"#111"}}>{stock}</span>
                      {p.stockMode==="auto"&&<span style={{fontSize:8,fontWeight:700,padding:"1px 4px",borderRadius:4,background:"#e0f2fe",color:"#0891b2"}}>AUTO</span>}
                    </div>);
                  })()}
                </td>
                <td style={{padding:"10px 12px",fontFamily:"monospace",fontSize:11,color:"#6b7280"}}>{p.sku||"—"}</td>
                <td style={{padding:"10px 12px"}}>
                  <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:p.active?"#f0fdf4":"#fef2f2",color:p.active?"#166534":"#991b1b"}}>{p.active?"Active":"Inactive"}</span>
                </td>
              </tr>
            ))}
            {filtered.length===0&&<tr><td colSpan={6} style={{padding:"40px",textAlign:"center",color:"#9ca3af"}}>No products found</td></tr>}
          </tbody>
        </table>
        </div>
      </Card>
    </div>
  );
}


// ════════════ ORDERS ════════════
function Orders({store,data,session,saveField}){
  const [filter,setFilter]=useState("all");
  const [search,setSearch]=useState("");
  const [detail,setDetail]=useState(null);
  const orders=data?.orders||[];
  const filtered=orders.filter(o=>(filter==="all"||o.status===filter)&&(o.id?.toLowerCase().includes(search.toLowerCase())||o.cashier?.toLowerCase().includes(search.toLowerCase())));

  // Orders are read-only in portal

  return(
    <div>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:14,flexWrap:"wrap"}}>
        <span style={{fontWeight:800,fontSize:18,marginRight:4}}>Orders</span>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search order ID or cashier…" style={{...INP,flex:1,minWidth:180,padding:"7px 12px"}}/>
        <div style={{display:"flex",gap:5}}>
          {["all","paid","void"].map(f=><button key={f} onClick={()=>setFilter(f)} style={{padding:"5px 12px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:12,fontWeight:700,textTransform:"capitalize",borderColor:filter===f?"#4f46e5":"#e5e7eb",background:filter===f?"#4f46e5":"#fff",color:filter===f?"#fff":"#6b7280"}}>{f}</button>)}
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {filtered.length===0&&<Card><div style={{textAlign:"center",color:"#9ca3af",padding:"24px 0",fontSize:13}}>No orders found</div></Card>}
        {filtered.map(o=>(
          <div key={o.id} onClick={()=>setDetail(o)} style={{background:"#fff",border:"0.5px solid rgba(0,0,0,0.07)",borderRadius:10,padding:12,cursor:"pointer",display:"flex",alignItems:"center",gap:10,boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontWeight:800,fontSize:13,fontFamily:"monospace"}}>{o.id}</span>
                <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:10,background:o.status==="paid"?"#f0fdf4":"#fef2f2",color:o.status==="paid"?"#166534":"#991b1b"}}>{o.status}</span>
                {o.orderType&&<span style={{fontSize:10,background:"#ede9fe",color:"#5b21b6",padding:"1px 6px",borderRadius:10,fontWeight:600}}>{o.orderType}</span>}
              </div>
              <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>{o.date} · {o.cashier}</div>
              <div style={{fontSize:12,color:"#6b7280",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.items?.map(i=>`${i.name} ×${i.qty}`).join(", ")}</div>
            </div>
            <span style={{fontWeight:800,fontSize:14,color:"#4f46e5",flexShrink:0}}>{fmt(o.total)}</span>
          </div>
        ))}
      </div>
      {detail&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:16}} onClick={e=>e.target===e.currentTarget&&setDetail(null)}>
          <div style={{background:"#fff",borderRadius:14,padding:24,width:"100%",maxWidth:400}}>
            <div style={{fontWeight:800,fontSize:15,marginBottom:4,fontFamily:"monospace"}}>{detail.id}</div>
            <div style={{fontSize:12,color:"#6b7280",marginBottom:12}}>{detail.date} · {detail.cashier} · {detail.payMethod?.toUpperCase()}{detail.orderType?` · ${detail.orderType}`:""}</div>
            {detail.items?.map((it,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"4px 0",borderBottom:"1px solid #f3f4f6"}}><span>{it.name} ×{it.qty}</span><span style={{fontWeight:700}}>{fmt(it.price*it.qty)}</span></div>)}
            {detail.discountAmt>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#16a34a",marginTop:6}}><span>Discount</span><span>−{fmt(detail.discountAmt)}</span></div>}
            {detail.vatAmt>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#0891b2",marginTop:4}}><span>VAT ({detail.vatPercent}%)</span><span>+{fmt(detail.vatAmt)}</span></div>}
            <div style={{display:"flex",justifyContent:"space-between",fontWeight:800,fontSize:16,margin:"10px 0 12px",paddingTop:8,borderTop:"1px dashed #e5e7eb"}}><span>Total</span><span style={{color:"#4f46e5"}}>{fmt(detail.total)}</span></div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setDetail(null)} style={{flex:1,padding:"9px 0",border:"1px solid #e5e7eb",background:"#fff",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Close</button>
              
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════ ACCOUNTS ════════════
function Accounts({store,data,session,saveField}){
  const accounts=data?.accounts||[];
  const roles=data?.roles||[];
  const [modal,setModal]=useState(null);
  const [form,setForm]=useState({});
  const [saving,setSaving]=useState(false);
  const [msg,setMsg]=useState("");
  const [showPw,setShowPw]=useState(false);

  const openAdd=()=>{setForm({id:"acc"+uid(),name:"",username:"",password:"",roleId:roles.find(r=>r.id==="role_staff")?.id||"role_staff",active:true,phone:"",email:"",address:"",notes:""});setModal("add");setMsg("");setShowPw(false);};
  const openEdit=(a)=>{setForm({...a,password:""});setModal("edit");setMsg("");setShowPw(false);};

  const save=async()=>{
    if(!form.name||!form.username||(modal==="add"&&!form.password)){setMsg("Name, username and password required");return;}
    setSaving(true);
    let finalForm = {...form};
    if(modal==="edit"){
      if(finalForm.password){
        finalForm.password = await bcrypt.hash(finalForm.password, 10);
      } else {
        const existing = accounts.find(a=>a.id===finalForm.id);
        finalForm.password = existing?.password || "";
      }
    } else {
      if(!finalForm.password.startsWith("$2")){
        finalForm.password = await bcrypt.hash(finalForm.password, 10);
      }
    }
    let updated;
    if(modal==="add"){
      if(accounts.find(a=>a.username===finalForm.username)){setMsg("Username already taken");setSaving(false);return;}
      updated=[...accounts,finalForm];
    } else {
      updated=accounts.map(a=>a.id===finalForm.id?finalForm:a);
    }
    const ok=await saveField("accounts",updated);
    setSaving(false);setMsg(ok?"Saved!":"Failed to save.");
    if(ok)setTimeout(()=>{setModal(null);setMsg("");},700);
  };

  const deleteAcc=async(id)=>{
    const updated=accounts.filter(a=>a.id!==id);
    await saveField("accounts",updated);
  };

  const ROLE_C={role_owner:"#dbeafe",role_manager:"#fef3c7",role_staff:"#f0fdf4"};
  const ROLE_T={role_owner:"#1e40af",role_manager:"#92400e",role_staff:"#166534"};

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontWeight:800,fontSize:18}}>Staff Accounts</div>
        <button onClick={openAdd} style={{padding:"7px 16px",background:"#4f46e5",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:5}}><i className="ti ti-plus"/>Add Account</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {accounts.map(a=>{
          const r=roles.find(r2=>r2.id===a.roleId);
          return(
            <Card key={a.id} style={{padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:0}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:ROLE_C[a.roleId]||"#f3f4f6",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,color:ROLE_T[a.roleId]||"#374151",flexShrink:0}}>{a.name.slice(0,2).toUpperCase()}</div>
              <div style={{flex:1,minWidth:120}}>
                <div style={{fontWeight:800,fontSize:14}}>{a.name}</div>
                <div style={{fontSize:12,color:"#9ca3af"}}>@{a.username} · <span style={{fontWeight:700,color:ROLE_T[a.roleId]||"#6b7280"}}>{r?.name||a.roleId}</span></div>
                {a.email&&<div style={{fontSize:11,color:"#9ca3af"}}>{a.email}</div>}
              </div>
              <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:10,background:a.active?"#f0fdf4":"#fef2f2",color:a.active?"#166634":"#991b1b"}}>{a.active?"Active":"Inactive"}</span>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>openEdit(a)} style={{background:"none",border:"1px solid #e5e7eb",borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:12,color:"#6b7280"}}>Edit</button>
                <button onClick={()=>deleteAcc(a.id)} style={{background:"none",border:"1px solid #fecaca",borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:12,color:"#ef4444"}}><i className="ti ti-trash"/></button>
              </div>
            </Card>
          );
        })}
      </div>
      {modal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:16}} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{background:"#fff",borderRadius:14,padding:24,width:"100%",maxWidth:420,maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:16}}>{modal==="add"?"Add Account":"Edit Account"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <FRow label="Full Name"><input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} style={INP}/></FRow>
                <FRow label="Username"><input value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value.toLowerCase().replace(/\s/g,"")}))} style={INP}/></FRow>
              </div>
              <FRow label="Password">
                <div style={{position:"relative"}}>
                  <input type={showPw?"text":"password"} value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} placeholder={modal==="edit"?"Leave blank to keep current password":"Minimum 6 characters"} style={{...INP,paddingRight:38}}/>
                  <button type="button" onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"#9ca3af",fontSize:17}}><i className={`ti ${showPw?"ti-eye-off":"ti-eye"}`}/></button>
                </div>
              </FRow>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <FRow label="Role">
                  <select value={form.roleId} onChange={e=>setForm(f=>({...f,roleId:e.target.value}))} style={INP}>
                    {roles.filter(r=>r.id!=="role_programmer").map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </FRow>
                <FRow label="Status">
                  <select value={form.active?"active":"inactive"} onChange={e=>setForm(f=>({...f,active:e.target.value==="active"}))} style={INP}><option value="active">Active</option><option value="inactive">Inactive</option></select>
                </FRow>
              </div>
              <div style={{borderTop:"1px dashed #e5e7eb",paddingTop:10}}>
                <div style={{fontSize:11,fontWeight:800,color:"#9ca3af",marginBottom:8,textTransform:"uppercase"}}>Additional Info</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <FRow label="Phone"><input value={form.phone||""} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+63 9XX XXX XXXX" style={INP}/></FRow>
                  <FRow label="Email"><input value={form.email||""} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="email@example.com" style={INP}/></FRow>
                </div>
                <FRow label="Address"><input value={form.address||""} onChange={e=>setForm(f=>({...f,address:e.target.value}))} style={INP}/></FRow>
                <FRow label="Notes"><textarea value={form.notes||""} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} rows={2} style={{...INP,resize:"none",marginTop:4}}/></FRow>
              </div>
            </div>
            {msg&&<div style={{marginTop:10,fontSize:13,fontWeight:700,color:msg==="Saved!"?"#166534":"#991b1b"}}>{msg}</div>}
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>setModal(null)} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Cancel</button>
              <button onClick={save} disabled={saving} style={{flex:2,padding:"10px 0",background:saving?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>{saving?"Saving…":modal==="add"?"Create Account":"Save Changes"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ════════════ SETTINGS ════════════
function Settings({store,data,session,onRefresh}){
  const [sTab,setSTab]=useState("appearance");
  const theme=data?.theme||{};
  const orderSettings=data?.order_settings||{};
  const skuSettings=data?.sku_settings||{};
  const TABS=[{k:"appearance",l:"Appearance"},{k:"orders",l:"Order Settings"},{k:"sku",l:"SKU"},{k:"devices",l:"Devices"}];
  const RO={fontSize:13,color:"#374151",padding:"8px 12px",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8};
  const LBL2={fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:4,display:"block"};
  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {TABS.map(t=><button key={t.k} onClick={()=>setSTab(t.k)} style={{padding:"6px 16px",borderRadius:8,border:"1px solid",cursor:"pointer",fontSize:13,fontWeight:700,borderColor:sTab===t.k?"#4f46e5":"#e5e7eb",background:sTab===t.k?"#4f46e5":"#fff",color:sTab===t.k?"#fff":"#6b7280"}}>{t.l}</button>)}
      </div>
      {sTab!=="devices"&&<div style={{fontSize:11,color:"#9ca3af",marginBottom:16,padding:"8px 12px",background:"#f9fafb",borderRadius:8,border:"1px solid #e5e7eb"}}>
        <i className="ti ti-lock" style={{marginRight:6}}/>Settings are read-only in the portal. To change settings, open the POS app on your device.
      </div>}
      {sTab==="appearance"&&(
        <Card>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>Appearance</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12}}>
            <div><label style={LBL2}>Store Name</label><div style={RO}>{theme.storeName||store?.store_name||"—"}</div></div>
            <div><label style={LBL2}>Logo Text</label><div style={RO}>{theme.logoText||"—"}</div></div>
            <div><label style={LBL2}>Font</label><div style={RO}>{theme.fontFamily||"sans-serif"}</div></div>
            <div><label style={LBL2}>Border Radius</label><div style={RO}>{theme.borderRadius||"10"}px</div></div>
            <div><label style={LBL2}>Primary Color</label><div style={{...RO,display:"flex",alignItems:"center",gap:8}}><span style={{width:16,height:16,borderRadius:4,background:theme.primary||"#4f46e5",display:"inline-block",border:"1px solid #e5e7eb"}}/>{theme.primary||"#4f46e5"}</div></div>
            <div><label style={LBL2}>Sidebar Color</label><div style={{...RO,display:"flex",alignItems:"center",gap:8}}><span style={{width:16,height:16,borderRadius:4,background:theme.sidebar||"#1a1a2e",display:"inline-block",border:"1px solid #e5e7eb"}}/>{theme.sidebar||"#1a1a2e"}</div></div>
          </div>
        </Card>
      )}
      {sTab==="orders"&&(
        <Card>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>Order Settings</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12,marginBottom:16}}>
            <div><label style={LBL2}>VAT</label><div style={RO}>{orderSettings.vatEnabled?`Enabled — ${orderSettings.vatPercent||12}%`:"Disabled"}</div></div>
            <div><label style={LBL2}>Order Number Prefix</label><div style={RO}>{orderSettings.orderNumPrefix||"ORD"}</div></div>
            <div><label style={LBL2}>Order Number Format</label><div style={RO}>{orderSettings.orderNumFormat||"prefix-datetime"}</div></div>
          </div>
          {(orderSettings.orderTypes||[]).length>0&&(
            <div style={{marginBottom:12}}>
              <label style={LBL2}>Order Types</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {orderSettings.orderTypes.map(t=><span key={t.id} style={{fontSize:12,padding:"3px 10px",borderRadius:6,background:t.enabled?"#f0fdf4":"#f3f4f6",color:t.enabled?"#166534":"#6b7280",border:`1px solid ${t.enabled?"#bbf7d0":"#e5e7eb"}`}}>{t.label}{t.enabled?" ✓":""}</span>)}
              </div>
            </div>
          )}
          {(orderSettings.orderSources||[]).length>0&&(
            <div>
              <label style={LBL2}>Order Sources</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {orderSettings.orderSources.map(s=><span key={s.id} style={{fontSize:12,padding:"3px 10px",borderRadius:6,background:"#f0f9ff",color:"#0369a1",border:"1px solid #bae6fd"}}>{s.label}</span>)}
              </div>
            </div>
          )}
        </Card>
      )}
      {sTab==="sku"&&(
        <Card>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>SKU Settings</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12}}>
            <div><label style={LBL2}>Prefix</label><div style={RO}>{skuSettings.prefix||"SW"}</div></div>
            <div><label style={LBL2}>Suffix</label><div style={RO}>{skuSettings.suffix||"—"}</div></div>
            <div><label style={LBL2}>Last Counter</label><div style={RO}>{skuSettings.counter||0}</div></div>
          </div>
          <div style={{marginTop:12,fontSize:12,color:"#6b7280"}}>
            Next SKU will be: <b style={{fontFamily:"monospace"}}>{(skuSettings.prefix||"SW").toUpperCase()}{String((skuSettings.counter||0)+1).padStart(5,"0")}{(skuSettings.suffix||"").toUpperCase()}</b>
          </div>
        </Card>
      )}
      {sTab==="devices"&&<DevicesTab store={store} session={session} onRefresh={onRefresh}/>}
    </div>
  );
}
function DevicesTab({store,session,onRefresh}){
  const [devices,setDevices]=useState(store?.devices||[]);
  const [otpModal,setOtpModal]=useState(null); // null | {deviceId, deviceName}
  const [otp,setOtp]=useState("");
  const [otpSent,setOtpSent]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");

  // Reload devices from store whenever store changes
  useEffect(()=>{ setDevices(store?.devices||[]); },[store]);

  const sendRemoveOTP=async(device)=>{
    if(session?.isDevView){setError("Device removal is disabled in Developer View — sign in as the owner to manage devices.");return;}
    setLoading(true);setError("");setSuccess("");
    // Reuse portal OTP system — sends to owner email
    const result=await sendPortalOTP(session.email, store?.store_name||"POS Pro","device");
    setLoading(false);
    if(!result.ok){setError("Failed to send code. Check your connection.");return;}
    setOtpSent(true);
    setOtpModal(device);
    setOtp("");
    setSuccess(result.dev?"[DEV] Check console for OTP":"Code sent to your email!");
  };

  const confirmRemove=async()=>{
    if(!otp||otp.length<6){setError("Enter the 6-digit code");return;}
    setLoading(true);setError("");
    // Verify OTP
    const valid=await verifyPortalOTP(session.email,otp.trim());
    if(!valid){setError("Invalid or expired code.");setLoading(false);return;}
    // Remove device from stores.devices
    const updated=(store?.devices||[]).filter(d=>d.id!==otpModal.id);
    const ok=await supa.update("stores",{id:session.storeId},{devices:updated});
    setLoading(false);
    if(!ok){setError("Failed to remove device. Try again.");return;}
    setDevices(updated);
    setOtpModal(null);setOtp("");setOtpSent(false);
    setSuccess(`"${otpModal.name}" has been removed.`);
    if(onRefresh) onRefresh();
  };

  const fmtDate=(s)=>{if(!s)return"—";try{return new Date(s).toLocaleDateString("en-PH",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}catch{return s;}};
  const maxDevices=store?.max_devices||1;

  return(
    <div>
      <Card>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
          <div>
            <div style={{fontWeight:800,fontSize:15}}>Registered Devices</div>
            <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{devices.length} of {maxDevices} slots used</div>
          </div>
          <div style={{fontSize:11,background:"#f0fdf4",color:"#166534",padding:"4px 12px",borderRadius:20,fontWeight:700,border:"1px solid #bbf7d0"}}>
            Plan: {maxDevices} device{maxDevices>1?"s":""}
          </div>
        </div>

        {success&&<div style={{padding:"9px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:13,color:"#166534",marginBottom:14,display:"flex",alignItems:"center",gap:7}}><i className="ti ti-check"/>{success}</div>}

        {devices.length===0&&(
          <div style={{textAlign:"center",padding:"32px 0",color:"#9ca3af"}}>
            <i className="ti ti-device-desktop" style={{fontSize:36,display:"block",marginBottom:8}}/>
            <div style={{fontSize:13}}>No devices registered yet</div>
            <div style={{fontSize:11,marginTop:4}}>Devices appear here when the POS app is activated</div>
          </div>
        )}

        {devices.map(d=>(
          <div key={d.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",background:"#f9fafb",borderRadius:10,border:"1px solid #e5e7eb",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{width:40,height:40,borderRadius:10,background:"#ede9fe",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <i className="ti ti-device-desktop" style={{fontSize:20,color:"#4f46e5"}}/>
              </div>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>{d.name||"Unnamed Device"}</div>
                <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>
                  {d.type==="branch"?"Branch Store":"Connected POS"} · ID: <span style={{fontFamily:"monospace"}}>{d.id?.slice(-8)}</span>
                </div>
                <div style={{fontSize:11,color:"#9ca3af"}}>Last seen: {fmtDate(d.last_seen_at)}</div>
              </div>
            </div>
            <button onClick={()=>sendRemoveOTP(d)} disabled={loading} style={{padding:"7px 14px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,cursor:loading?"not-allowed":"pointer",fontSize:12,fontWeight:700,color:"#991b1b",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
              <i className="ti ti-trash" style={{fontSize:13}}/> Remove
            </button>
          </div>
        ))}

        {devices.length<maxDevices&&(
          <div style={{padding:"14px 16px",background:"#f9fafb",borderRadius:10,border:"1.5px dashed #d1d5db",textAlign:"center",color:"#9ca3af",fontSize:12}}>
            <i className="ti ti-plus" style={{fontSize:16,display:"block",marginBottom:4}}/>
            {maxDevices-devices.length} slot{maxDevices-devices.length>1?"s":""} available — activate from the POS app
          </div>
        )}
      </Card>

      {/* OTP Confirmation Modal */}
      {otpModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:28,width:"100%",maxWidth:400}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:4}}>Confirm Device Removal</div>
            <div style={{fontSize:13,color:"#9ca3af",marginBottom:16}}>
              To remove <b>{otpModal.name}</b>, enter the code sent to your email.
            </div>
            {success&&<div style={{padding:"8px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:12,color:"#166534",marginBottom:12}}>{success}</div>}
            <div style={{background:"#fef3c7",border:"1px solid #fde68a",borderRadius:8,padding:"10px 12px",marginBottom:16,fontSize:12,color:"#92400e"}}>
              ⚠️ Removing this device will log it out immediately on next sync.
            </div>
            <FRow label="6-Digit Code">
              <input
                type="text" inputMode="numeric"
                value={otp}
                onChange={e=>{setOtp(e.target.value.replace(/\D/g,"").slice(0,6));setError("");}}
                onKeyDown={e=>e.key==="Enter"&&confirmRemove()}
                placeholder="000000"
                style={{...INP,fontSize:24,fontWeight:800,letterSpacing:8,textAlign:"center"}}
                autoFocus
              />
            </FRow>
            <Err msg={error}/>
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>{setOtpModal(null);setOtp("");setOtpSent(false);setError("");}} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Cancel</button>
              <button onClick={confirmRemove} disabled={loading||otp.length<6} style={{flex:2,padding:"10px 0",background:loading||otp.length<6?"#fca5a5":"#dc2626",color:"#fff",border:"none",borderRadius:8,cursor:loading||otp.length<6?"not-allowed":"pointer",fontSize:13,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                {loading?<><i className="ti ti-loader-2"/>Verifying…</>:<><i className="ti ti-trash"/>Remove Device</>}
              </button>
            </div>
            <div style={{marginTop:12,textAlign:"center"}}>
              <button onClick={()=>sendRemoveOTP(otpModal)} disabled={loading} style={{background:"none",border:"none",cursor:"pointer",color:"#4f46e5",fontSize:12,fontWeight:600}}>
                Resend Code
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
