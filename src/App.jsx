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
const todayKey   = () => new Date().toISOString().slice(0,10);
const weekStart  = () => { const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
const monthStart = () => new Date().toISOString().slice(0,7)+"-01";
const uid        = () => Math.random().toString(36).slice(2,10);

const SESSION_KEY = "portal_session";
const getSession  = () => { try{return JSON.parse(sessionStorage.getItem(SESSION_KEY));}catch{return null;} };
const saveSession = (s) => sessionStorage.setItem(SESSION_KEY,JSON.stringify(s));
const clearSession= () => sessionStorage.removeItem(SESSION_KEY);

// Resend API key is managed exclusively server-side (Vercel env: RESEND_API_KEY).
// It is never stored or read client-side to prevent key exposure.

const sendPortalOTP = async (email, storeName, purpose="sign-in") => {
  const otp    = String(Math.floor(100000+Math.random()*900000));
  const expiry = new Date(Date.now()+10*60*1000).toISOString();
  // Store OTP in Supabase
  await supa.update("stores",{owner_email:email.toLowerCase()},{otp_code:otp,otp_expiry:expiry});

  // Call our Vercel serverless function (which calls Resend server-side)
  try {
    const r = await fetch("/api/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp, storeName, purpose }),
    });
    if(r.ok) return {ok:true};
    // If serverless function not available, log to console (dev mode)
    console.log(`[DEV] OTP for ${email}: ${otp}`);
    return {ok:true, dev:true, otp};
  } catch {
    // Fallback for local development
    console.log(`[DEV] OTP for ${email}: ${otp}`);
    return {ok:true, dev:true, otp};
  }
};

const verifyPortalOTP = async (email, inputOtp) => {
  const store = await supa.get("stores",{owner_email:email.toLowerCase()});
  if(!store||store.otp_code!==inputOtp) return false;
  if(new Date()>new Date(store.otp_expiry)) return false;
  await supa.update("stores",{owner_email:email.toLowerCase()},{otp_code:null,otp_expiry:null});
  return true;
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
      refreshRef.current=setInterval(()=>loadData(session.storeId),60000);
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
          <div style={{width:28,height:28,borderRadius:7,overflow:"hidden"}}><img src="/icons/icon-192.png" alt="POS Pro" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:7}}/></div>
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
        {data&&view==="reports"  &&<Reports   store={store} data={data} primary={PRIMARY}/>}
        {data&&view==="inventory"&&<Inventory store={store} data={data} session={session} saveField={saveField} primary={PRIMARY}/>}
        {data&&view==="orders"   &&<Orders    store={store} data={data} session={session} saveField={saveField}/>}
        {data&&view==="accounts" &&<Accounts  store={store} data={data} session={session} saveField={saveField}/>}
        {data&&view==="settings" &&<Settings  store={store} data={data} session={session} saveField={saveField} onRefresh={()=>loadData(session.storeId)} setStore={setStore}/>}
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
function PortalShiftsTab({shifts,fmt,primary}){
  const [shiftPeriod,setShiftPeriod]=useState("all");
  const [shiftFrom,setShiftFrom]=useState("");
  const [shiftTo,setShiftTo]=useState("");
  const [shiftCashier,setShiftCashier]=useState("all");
  const now=new Date();
  const todayStr=now.toISOString().slice(0,10);
  const weekStartStr=new Date(now.getFullYear(),now.getMonth(),now.getDate()-now.getDay()).toISOString().slice(0,10);
  const monthStartStr=new Date(now.getFullYear(),now.getMonth(),1).toISOString().slice(0,10);
  const cashierList=[...new Set(shifts.map(s=>s.cashier).filter(Boolean))].sort();
  const filteredShifts=shifts.filter(s=>{
    const d=(s.startDateKey||s.startTime||"").slice(0,10);
    if(shiftPeriod==="today")  return d===todayStr;
    if(shiftPeriod==="week")   return d>=weekStartStr;
    if(shiftPeriod==="month")  return d>=monthStartStr;
    if(shiftPeriod==="custom") return (!shiftFrom||d>=shiftFrom)&&(!shiftTo||d<=shiftTo);
    return true;
  }).filter(s=>shiftCashier==="all"||s.cashier===shiftCashier);
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
        <Card key={s.id}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,flexWrap:"wrap",gap:6}}>
            <div><div style={{fontWeight:800,fontSize:13}}>{s.cashier}</div><div style={{fontSize:11,color:"#9ca3af"}}>{s.startTime} → {s.endTime}</div></div>
            <span style={{fontSize:13,fontWeight:800,padding:"3px 10px",borderRadius:10,background:s.overShort>=0?"#f0fdf4":"#fef2f2",color:s.overShort>=0?"#166534":"#991b1b"}}>{s.overShort>=0?"+":""}{fmt(s.overShort)}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(90px,1fr))",gap:7,marginBottom:s.payBreakdown&&Object.keys(s.payBreakdown).length>0?8:0}}>
            {[{l:"Sales",v:fmt(s.totalSales)},{l:"Opening",v:fmt(s.openCash)},{l:"Closing",v:fmt(s.closeCash)},{l:"Expenses",v:fmt(s.totalExpenses||0)},{l:"Orders",v:s.shiftOrders}].map(m=>(
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
        </Card>
      ))}
    </div>
  );
}

function Reports({store,data,primary}){
  const [period,setPeriod]=useState("today");
  const [tab,setTab]=useState("sales");
  const [from,setFrom]=useState("");const [to,setTo]=useState("");
  const [payFilter,setPayFilter]=useState("all");
  const [birMonth,setBirMonth]=useState(new Date().toISOString().slice(0,7));
  const allOrders=(data?.orders||[]).filter(o=>o.status==="paid");
  const shifts=data?.shifts||[];
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
    const rows=shifts.map(s=>{
      const payRow=s.payBreakdown&&Object.keys(s.payBreakdown).length>0
        ?`<tr><td colspan="8" style="padding:2px 8px 6px;font-size:10px;color:#6b7280;border-bottom:1px solid #e5e7eb">Payments: ${Object.entries(s.payBreakdown).map(([m,a])=>`<span style="background:${m==="cash"?"#dcfce7":"#eff6ff"};color:${m==="cash"?"#166534":"#1e40af"};padding:1px 6px;border-radius:4px;font-weight:700;margin-right:4px">${m.charAt(0).toUpperCase()+m.slice(1)}: ${fmt(a)}</span>`).join("")}</td></tr>`
        :"";
      return `<tr><td>${s.cashier}</td><td style="font-size:10px">${s.startTime}<br/>${s.endTime}</td><td class="right">${s.shiftOrders}</td><td class="right">${fmt(s.openCash)}</td><td class="right">${fmt(s.totalSales)}</td><td class="right">${fmt(s.totalExpenses||0)}</td><td class="right">${fmt(s.closeCash)}</td><td class="right ${s.overShort>=0?"green":"red"}">${s.overShort>=0?"+":""}${fmt(s.overShort)}</td></tr>${payRow}`;
    }).join("");
    printReport(`<h1>Shift Report</h1><p class="meta">Store: ${store?.store_name} | ${shifts.length} shifts</p><table><thead><tr><th>Cashier</th><th>Period</th><th class="right">Orders</th><th class="right">Opening</th><th class="right">Sales</th><th class="right">Expenses</th><th class="right">Closing</th><th class="right">Over/Short</th></tr></thead><tbody>${rows}</tbody></table>`,`Shift Report — ${store?.store_name}`);
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
      {tab==="shifts"&&<PortalShiftsTab shifts={shifts} fmt={fmt} primary={primary}/>}
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
function Inventory({store,data,session,saveField,primary}){
  const products=data?.products||[];
  const categories=data?.categories||[];
  const skuSettings=data?.sku_settings||{prefix:"SW",suffix:"",counter:0};
  const [search,setSearch]=useState("");
  const [catFilter,setCat]=useState("All");
  const [modal,setModal]=useState(null); // null | "add" | "edit"
  const [form,setForm]=useState({});
  const [saving,setSaving]=useState(false);
  const [msg,setMsg]=useState("");
  const [deleteModal,setDeleteModal]=useState(null);
  const [deleteReason,setDeleteReason]=useState("");
  const [deleting,setDeleting]=useState(false);
  const [updateModal,setUpdateModal]=useState(null);
  const [actionVal,setActionVal]=useState("");
  const [actionVal2,setActionVal2]=useState("");
  const [actionLoading,setActionLoading]=useState(false);
  // CSV
  const [importModal,setImportModal]=useState(false);
  const [importRows,setImportRows]=useState([]);
  const [importErrors,setImportErrors]=useState([]);
  const [importing,setImporting]=useState(false);
  const csvRef=useRef(null);
  const imgRef=useRef(null);

  const genNextSKU=()=>{
    const counter=(skuSettings.counter||0)+1;
    return `${(skuSettings.prefix||"SW").toUpperCase()}${String(counter).padStart(5,"0")}${(skuSettings.suffix||"").toUpperCase()}`;
  };

  const openAdd=()=>{setForm({id:"p"+uid(),name:"",price:"",category:categories[0]||"Food",stock:0,sku:genNextSKU(),active:true,image:"",showInPOS:true,recipe:[],stockMode:"manual"});setModal("add");setMsg("");};
  const openEdit=(p)=>{setForm({...p,price:String(p.price),stock:String(p.stock)});setModal("edit");setMsg("");};

  const save=async()=>{
    if(!form.name||!form.price){setMsg("Name and price are required");return;}
    setSaving(true);
    let updated;
    if(modal==="add"){
      updated=[...products,{...form,price:parseFloat(form.price)||0,stock:parseInt(form.stock)||0}];
      await saveField("sku_settings",{...skuSettings,counter:(skuSettings.counter||0)+1});
    } else {
      updated=products.map(p=>p.id===form.id?{...form,price:parseFloat(form.price)||0,stock:parseInt(form.stock)||0}:p);
    }
    const ok=await saveField("products",updated);
    setSaving(false);setMsg(ok?"Saved!":"Failed to save.");
    if(ok)setTimeout(()=>{setModal(null);setMsg("");},700);
  };

  const doDelete=async()=>{
    if(!deleteModal)return;
    setDeleting(true);
    const updated=products.filter(p=>p.id!==deleteModal.id);
    const ok=await saveField("products",updated);
    setDeleting(false);
    if(ok){setDeleteModal(null);setDeleteReason("");}
    else setMsg("Failed to delete.");
  };

  const addPortalLog=async(type,action,detail)=>{
    try{
      const fresh=await supa.get("store_data",{store_id:session?.storeId});
      const existing=fresh?.logs||data?.logs||[];
      const entry={id:"log-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,6),type,action,detail,actor:store?.owner_name||"Owner",actorRole:"role_owner",device:"portal",ts:new Date().toISOString(),dateKey:new Date().toISOString().slice(0,10)};
      const SIX_MONTHS_AGO=new Date(Date.now()-180*24*60*60*1000).toISOString();
      const updated=[entry,...existing.filter(l=>l.ts>SIX_MONTHS_AGO)].slice(0,5000);
      await saveField("logs",updated);
    }catch(e){}
  };

  const openAction=(product,action)=>{setUpdateModal({product,action});setActionVal(action==="category"?product.category:"");setActionVal2("");};

  const doAction=async()=>{
    const {product,action}=updateModal;
    setActionLoading(true);
    let updated;let logDetail="";
    const fmtP=(n)=>`₱${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    if(action==="rename"){if(!actionVal.trim()){setActionLoading(false);return;}updated=products.map(p=>p.id===product.id?{...p,name:actionVal.trim()}:p);logDetail=`Renamed: "${product.name}" → "${actionVal.trim()}"`;
    }else if(action==="category"){updated=products.map(p=>p.id===product.id?{...p,category:actionVal}:p);logDetail=`Category changed: ${product.name} — "${product.category}" → "${actionVal}"`;
    }else if(action==="price"){const newPrice=parseFloat(actionVal);if(!newPrice||newPrice<=0){setActionLoading(false);return;}updated=products.map(p=>p.id===product.id?{...p,price:newPrice}:p);logDetail=`Price adjusted: ${product.name} — ${fmtP(product.price)} → ${fmtP(newPrice)}`;
    }else if(action==="add_stock"){const qty=parseInt(actionVal)||0;if(qty<=0){setActionLoading(false);return;}updated=products.map(p=>p.id===product.id?{...p,stock:p.stock+qty}:p);logDetail=`Stock added: ${product.name} +${qty} (${product.stock} → ${product.stock+qty})${actionVal2?` — Note: ${actionVal2}`:""}`;
    }else if(action==="remove_stock"){const qty=parseInt(actionVal)||0;if(qty<=0||!actionVal2.trim()){setActionLoading(false);return;}const newStock=Math.max(0,product.stock-qty);updated=products.map(p=>p.id===product.id?{...p,stock:newStock}:p);logDetail=`Stock removed: ${product.name} -${qty} (${product.stock} → ${newStock}) — Reason: ${actionVal2}`;
    }else if(action==="sku"){if(!actionVal.trim()){setActionLoading(false);return;}updated=products.map(p=>p.id===product.id?{...p,sku:actionVal.trim().toUpperCase()}:p);logDetail=`SKU updated: ${product.name} — "${product.sku}" → "${actionVal.trim().toUpperCase()}"`;
    }else if(action==="status"){const newStatus=!product.active;updated=products.map(p=>p.id===product.id?{...p,active:newStatus}:p);logDetail=`Status changed: ${product.name} — ${product.active?"Active → Inactive":"Inactive → Active"}`;
    }else if(action==="showInPOS"){const newVal=product.showInPOS===false?true:false;updated=products.map(p=>p.id===product.id?{...p,showInPOS:newVal}:p);logDetail=`POS visibility: ${product.name} — ${newVal?"Now visible in POS":"Now hidden from POS"}`;
    }else if(action==="stockMode"){if(!product.recipe?.length){setActionLoading(false);return;}const newMode=product.stockMode==="auto"?"manual":"auto";updated=products.map(p=>p.id===product.id?{...p,stockMode:newMode}:p);logDetail=`Stock mode: ${product.name} → ${newMode}`;
    }else if(action==="image"){const newImg=actionVal==="__remove__"?"":actionVal;updated=products.map(p=>p.id===product.id?{...p,image:newImg}:p);logDetail=newImg?`Image updated: ${product.name}`:`Image removed: ${product.name}`;
    }else if(action==="delete"){updated=products.filter(p=>p.id!==product.id);logDetail=`Product deleted: "${product.name}" (SKU: ${product.sku||"—"})${actionVal2.trim()?` — Reason: ${actionVal2.trim()}`:""}`;
    }
    const ok=await saveField("products",updated);
    if(ok&&logDetail)await addPortalLog("INVENTORY",action,logDetail);
    setActionLoading(false);setUpdateModal(null);setActionVal("");setActionVal2("");
  };

  const handleImg=async(e)=>{
    const f=e.target.files[0];if(!f)return;
    const compressed=await compressImage(f);
    const sess=getSession();
    const storeId=sess?.storeId||"";
    const productId=form.id||("p"+Math.random().toString(36).slice(2,10));
    const url=storeId?await supa.uploadImage(storeId,productId,compressed):null;
    setForm(x=>({...x,image:url||compressed}));
  };

  // ── CSV EXPORT ──
  const exportCSV=()=>{
    const headers=["name","category","price","stock","sku","active"];
    const rows=products.map(p=>[`"${(p.name||"").replace(/"/g,'""')}"`,,`"${(p.category||"").replace(/"/g,'""')}"`,,p.price||0,p.stock||0,`"${(p.sku||"").replace(/"/g,'""')}"`,p.active===false?"false":"true"].join(","));
    const csv=[headers.join(","),...rows].join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`inventory-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
  };

  // ── CSV IMPORT ──
  const handleCSVFile=(e)=>{
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      const text=ev.target.result;
      const lines=text.split("\n").map(l=>l.trim()).filter(Boolean);
      if(lines.length<2){alert("CSV is empty");return;}
      const headers=lines[0].toLowerCase().split(",").map(h=>h.trim().replace(/"/g,""));
      const nameIdx=headers.indexOf("name"),catIdx=headers.indexOf("category"),priceIdx=headers.indexOf("price"),stockIdx=headers.indexOf("stock"),skuIdx=headers.indexOf("sku"),activeIdx=headers.indexOf("active");
      if(nameIdx===-1||priceIdx===-1){alert("CSV must have name and price columns");return;}
      const rows=[];const errors=[];
      lines.slice(1).forEach((line,i)=>{
        const cols=line.match(/(".*?"|[^,]+)(?=,|$)/g)||line.split(",");
        const clean=cols.map(c=>c.trim().replace(/^"|"$/g,"").replace(/""/g,'"'));
        const name=clean[nameIdx]?.trim()||"";const price=parseFloat(clean[priceIdx])||0;
        if(!name){errors.push(`Row ${i+2}: missing name`);return;}
        if(price<=0){errors.push(`Row ${i+2}: invalid price`);return;}
        rows.push({name,category:catIdx!==-1?clean[catIdx]||categories[0]||"Others":categories[0]||"Others",price,stock:stockIdx!==-1?parseInt(clean[stockIdx])||0:0,sku:skuIdx!==-1?clean[skuIdx]||"":"",active:activeIdx!==-1?clean[activeIdx]?.toLowerCase()!=="false":true,_action:"?",_matchId:null});
      });
      rows.forEach(r=>{const bysku=r.sku&&products.find(p=>p.sku===r.sku);const byname=!bysku&&products.find(p=>p.name.toLowerCase()===r.name.toLowerCase());r._action=bysku||byname?"update":"create";r._matchId=bysku?.id||byname?.id||null;});
      setImportRows(rows);setImportErrors(errors);setImportModal(true);e.target.value="";
    };
    reader.readAsText(file);
  };

  const doImport=async()=>{
    setImporting(true);
    let nextCounter=skuSettings.counter||0;const newCats=[...categories];const updated=[...products];
    importRows.forEach(r=>{
      if(r.category&&!newCats.includes(r.category))newCats.push(r.category);
      if(!r.sku){nextCounter++;r.sku=`${(skuSettings.prefix||"SW").toUpperCase()}${String(nextCounter).padStart(5,"0")}${(skuSettings.suffix||"").toUpperCase()}`;}
      if(r._action==="update"&&r._matchId){const idx=updated.findIndex(p=>p.id===r._matchId);if(idx!==-1)updated[idx]={...updated[idx],name:r.name,category:r.category,price:r.price,stock:r.stock,sku:r.sku,active:r.active};}
      else updated.push({id:"p"+uid(),name:r.name,category:r.category,price:r.price,stock:r.stock,sku:r.sku,active:r.active,image:""});
    });
    await saveField("products",updated);
    if(newCats.length>categories.length)await saveField("categories",newCats);
    await saveField("sku_settings",{...skuSettings,counter:nextCounter});
    setImporting(false);setImportModal(false);setImportRows([]);setImportErrors([]);
  };

  const filtered=products.filter(p=>(catFilter==="All"||p.category===catFilter)&&(p.name.toLowerCase().includes(search.toLowerCase())||p.sku?.includes(search)));
  const fmt=(n)=>`₱${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div style={{fontWeight:800,fontSize:18}}>Inventory <span style={{fontSize:13,fontWeight:600,color:"#9ca3af"}}>({products.filter(p=>p.active).length} active / {products.length} total)</span></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name or SKU…" style={{...INP,width:180,padding:"7px 12px"}}/>
          <button onClick={exportCSV} style={{padding:"7px 10px",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:12,background:"#f9fafb",display:"flex",alignItems:"center",gap:4}}><i className="ti ti-download"/>Export</button>
          <button onClick={()=>csvRef.current.click()} style={{padding:"7px 10px",border:`1px solid ${primary||"#4f46e5"}`,borderRadius:8,cursor:"pointer",fontSize:12,background:"#f5f3ff",color:primary||"#4f46e5",fontWeight:700,display:"flex",alignItems:"center",gap:4}}><i className="ti ti-upload"/>Import</button>
          <input ref={csvRef} type="file" accept=".csv" onChange={handleCSVFile} style={{display:"none"}}/>
          <button onClick={openAdd} style={{padding:"7px 14px",background:primary||"#4f46e5",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:5}}><i className="ti ti-plus"/>Add Product</button>
        </div>
      </div>

      {/* Category filters */}
      <div style={{display:"flex",gap:5,marginBottom:14,flexWrap:"wrap"}}>
        {["All",...categories].map(c=>(
          <button key={c} onClick={()=>setCat(c)} style={{padding:"4px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:700,borderColor:catFilter===c?(primary||"#4f46e5"):"#e5e7eb",background:catFilter===c?(primary||"#4f46e5"):"#fff",color:catFilter===c?"#fff":"#6b7280"}}>{c}</button>
        ))}
      </div>

      {/* Product table */}
      <Card style={{padding:0,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead>
            <tr style={{background:"#f9fafb"}}>
              {["Product","Category","Price","Stock","SKU","Status",""].map(h=>(
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
                        {p.recipe?.length>0&&p.recipe.some(r=>{const ing=products.find(x=>x.id===r.productId);return !ing||!ing.active;})&&<span title="Some inclusions are hidden or deleted" style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:8,background:"#fef2f2",color:"#dc2626"}}>⚠ inclusion issue</span>}
                        {p.showInPOS===false&&<span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:8,background:"#fef3c7",color:"#92400e"}}>Hidden from POS</span>}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{padding:"10px 12px",color:"#6b7280"}}>{p.category}</td>
                <td style={{padding:"10px 12px",fontWeight:700,color:primary||"#4f46e5"}}>{fmt(p.price)}</td>
                <td style={{padding:"10px 12px"}}>{(()=>{
                  const s=computeStockPortal(p,products);
                  return(<div style={{display:"flex",alignItems:"center",gap:4}}><span style={{fontWeight:700,color:s===0?"#dc2626":s<10?"#f59e0b":"#111"}}>{s}</span>{p.stockMode==="auto"&&<span style={{fontSize:8,fontWeight:700,padding:"1px 4px",borderRadius:4,background:"#e0f2fe",color:"#0891b2"}}>AUTO</span>}</div>);
                })()}</td>
                <td style={{padding:"10px 12px",fontFamily:"monospace",fontSize:11,color:"#6b7280"}}>{p.sku||"—"}</td>
                <td style={{padding:"10px 12px"}}>
                  <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:p.active?"#f0fdf4":"#fef2f2",color:p.active?"#166534":"#991b1b"}}>{p.active?"Active":"Inactive"}</span>
                </td>
                <td style={{padding:"10px 12px"}}>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>openAction(p,"menu")} style={{padding:"4px 10px",background:primary||"#4f46e5",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4}}><i className="ti ti-dots" style={{fontSize:12}}/>Update</button>
                    <button onClick={()=>{setDeleteModal(p);setDeleteReason("");}} style={{padding:"4px 8px",background:"#fef2f2",color:"#dc2626",border:"1px solid #fecaca",borderRadius:6,cursor:"pointer",fontSize:11}}><i className="ti ti-trash" style={{fontSize:12}}/></button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length===0&&<tr><td colSpan={7} style={{padding:"40px",textAlign:"center",color:"#9ca3af"}}>No products found</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* CSV Import Modal */}
      {importModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,width:"100%",maxWidth:560,maxHeight:"85vh",overflow:"auto"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:4}}>Import Preview — {importRows.length} rows</div>
            {importErrors.length>0&&<div style={{background:"#fef3c7",border:"1px solid #fde68a",borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:12,color:"#92400e"}}>{importErrors.length} rows skipped: {importErrors.join(", ")}</div>}
            <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"8px 12px",marginBottom:12,display:"flex",gap:16,fontSize:13}}>
              <span><b>{importRows.filter(r=>r._action==="create").length}</b> will be created</span>
              <span><b>{importRows.filter(r=>r._action==="update").length}</b> will be updated</span>
            </div>
            <div style={{maxHeight:240,overflowY:"auto",marginBottom:14}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr style={{background:"#f9fafb"}}>{["Action","Name","Category","Price","Stock"].map(h=><th key={h} style={{padding:"6px 8px",textAlign:"left",fontWeight:700,fontSize:10,color:"#6b7280",borderBottom:"1px solid #e5e7eb"}}>{h}</th>)}</tr></thead>
                <tbody>{importRows.map((r,i)=><tr key={i} style={{borderBottom:"0.5px solid #f3f4f6"}}>
                  <td style={{padding:"6px 8px"}}><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:8,background:r._action==="create"?"#f0fdf4":"#dbeafe",color:r._action==="create"?"#166534":"#1e40af"}}>{r._action}</span></td>
                  <td style={{padding:"6px 8px",fontWeight:600}}>{r.name}</td>
                  <td style={{padding:"6px 8px",color:"#6b7280"}}>{r.category}</td>
                  <td style={{padding:"6px 8px"}}>₱{r.price}</td>
                  <td style={{padding:"6px 8px"}}>{r.stock}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setImportModal(false);setImportRows([]);}} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Cancel</button>
              <button onClick={doImport} disabled={importing} style={{flex:2,padding:"10px 0",background:importing?"#a5b4fc":(primary||"#4f46e5"),color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>{importing?"Importing…":`Confirm (${importRows.length} rows)`}</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,width:"100%",maxWidth:400}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:4,color:"#dc2626"}}>Delete Product</div>
            <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:"#991b1b"}}>
              Are you sure you want to delete <b>{deleteModal.name}</b>? This cannot be undone.
            </div>
            <FRow label="Reason" hint="optional">
              <input value={deleteReason} onChange={e=>setDeleteReason(e.target.value)} placeholder="e.g. Discontinued, Duplicate…" style={INP} autoFocus/>
            </FRow>
            <div style={{display:"flex",gap:8,marginTop:14}}>
              <button onClick={()=>setDeleteModal(null)} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Cancel</button>
              <button onClick={doDelete} disabled={deleting} style={{flex:1,padding:"10px 0",background:deleting?"#fca5a5":"#dc2626",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>{deleting?"Deleting…":"Delete"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Modal */}
      {modal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,width:"100%",maxWidth:480,maxHeight:"90vh",overflow:"auto"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:16}}>{modal==="add"?"Add Product":"Edit Product"}</div>
            <FRow label="Product Image">
              <div style={{display:"flex",alignItems:"center",gap:12,marginTop:4}}>
                <div style={{width:64,height:64,borderRadius:10,border:"2px dashed #e5e7eb",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",background:"#f9fafb",flexShrink:0}}>
                  {form.image?<img src={form.image} alt="product" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<i className="ti ti-photo" style={{fontSize:22,color:"#d1d5db"}}/>}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  <button onClick={()=>imgRef.current.click()} style={{padding:"6px 12px",border:"1px solid #e5e7eb",borderRadius:7,cursor:"pointer",fontSize:12,background:"#f9fafb",fontWeight:700,display:"flex",alignItems:"center",gap:5}}><i className="ti ti-upload"/>Upload</button>
                  {form.image&&<button onClick={()=>setForm(f=>({...f,image:""}))} style={{padding:"4px 10px",border:"1px solid #fecaca",borderRadius:7,cursor:"pointer",fontSize:11,background:"#fef2f2",color:"#991b1b"}}>Remove</button>}
                </div>
                <input ref={imgRef} type="file" accept="image/*" onChange={handleImg} style={{display:"none"}}/>
              </div>
            </FRow>
            <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:10}}>
              <FRow label="Name"><input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Product name" style={INP} autoFocus/></FRow>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <FRow label="Category">
                  <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} style={INP}>
                    {categories.map(c=><option key={c}>{c}</option>)}
                  </select>
                </FRow>
                <FRow label="Price (₱)"><input type="number" value={form.price} onChange={e=>setForm(f=>({...f,price:e.target.value}))} style={INP}/></FRow>
              </div>
              {(form.stockMode||"manual")!=="auto"&&<FRow label="Stock"><input type="number" value={form.stock} onChange={e=>setForm(f=>({...f,stock:e.target.value}))} style={INP}/></FRow>}
              {(form.stockMode||"manual")==="auto"&&form.recipe?.length>0&&<div style={{padding:"8px 12px",background:"#e0f2fe",borderRadius:8,fontSize:12,color:"#0891b2",fontWeight:600}}>⚙ Stock auto-computed from inclusions</div>}
              {form.recipe?.length>0&&(
                <FRow label="Stock Mode">
                  <div style={{display:"flex",gap:8,marginTop:4}}>
                    {["manual","auto"].map(m=>(
                      <button key={m} onClick={()=>setForm(f=>({...f,stockMode:m}))} style={{flex:1,padding:"7px 0",borderRadius:8,border:`1.5px solid ${(form.stockMode||"manual")===m?"#4f46e5":"#e5e7eb"}`,background:(form.stockMode||"manual")===m?"#4f46e5":"#fff",color:(form.stockMode||"manual")===m?"#fff":"#6b7280",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                        {m==="auto"?"⚙ Auto (from inclusions)":"Manual"}
                      </button>
                    ))}
                  </div>
                  {(form.stockMode||"manual")==="auto"&&<div style={{fontSize:11,color:"#0891b2",marginTop:5}}>Stock = minimum servings possible from inclusion stocks</div>}
                </FRow>
              )}
              <FRow label="SKU"><input value={form.sku} onChange={e=>setForm(f=>({...f,sku:e.target.value.toUpperCase()}))} style={{...INP,fontFamily:"monospace"}}/></FRow>
              <FRow label="Status">
                <select value={form.active?"active":"hidden"} onChange={e=>setForm(f=>({...f,active:e.target.value==="active"}))} style={INP}>
                  <option value="active">Active</option>
                  <option value="hidden">Inactive</option>
                </select>
              </FRow>
              <FRow label="Show in POS">
                <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",marginTop:4}}>
                  <div onClick={()=>setForm(f=>({...f,showInPOS:!(f.showInPOS!==false)}))} style={{width:40,height:22,borderRadius:11,background:form.showInPOS!==false?"#4f46e5":"#d1d5db",position:"relative",transition:"background 0.2s",flexShrink:0,cursor:"pointer"}}>
                    <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:form.showInPOS!==false?20:2,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
                  </div>
                  <span style={{fontSize:12,color:"#6b7280"}}>{form.showInPOS!==false?"Visible in POS cashier grid":"Hidden from POS cashier grid (inclusions, internal items)"}</span>
                </label>
              </FRow>
              <FRow label="Inclusions" hint="optional — deducts stock on sale">
                <div style={{marginTop:4}}>
                  {(form.recipe||[]).map((r,i)=>{
                    const selProd = r.productId ? products.find(p=>p.id===r.productId) : null;
                    return(
                    <div key={i} style={{display:"flex",gap:6,alignItems:"center",marginBottom:6}}>
                      <div style={{flex:2}}>
                        <ProductSearchSelect
                          products={products}
                          value={selProd?.name||""}
                          excludeId={form.id}
                          placeholder="Search inclusion…"
                          onSelect={(p)=>{const rec=[...(form.recipe||[])];rec[i]={...rec[i],productId:p.id};setForm(f=>({...f,recipe:rec}));}}
                        />
                      </div>
                      <input type="number" min={0.01} step={0.01} value={r.qty||""} onChange={e=>{const rec=[...(form.recipe||[])];rec[i]={...rec[i],qty:parseFloat(e.target.value)||0};setForm(f=>({...f,recipe:rec}));}} placeholder="Qty" style={{...INP,width:70,padding:"6px 8px",textAlign:"center"}}/>
                      <button onClick={()=>{const rec=(form.recipe||[]).filter((_,j)=>j!==i);setForm(f=>({...f,recipe:rec}));}} style={{padding:"5px 8px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:6,cursor:"pointer",color:"#dc2626",flexShrink:0}}>✕</button>
                    </div>
                    );
                  })}
                  <button onClick={()=>setForm(f=>({...f,recipe:[...(f.recipe||[]),{productId:"",qty:1}]}))} style={{padding:"5px 12px",border:"1.5px dashed #d1d5db",borderRadius:7,cursor:"pointer",fontSize:11,color:"#6b7280",background:"#f9fafb",width:"100%"}}>+ Add Inclusion</button>
                </div>
              </FRow>
              {msg&&<div style={{fontSize:12,color:msg==="Saved!"?"#166534":"#dc2626",fontWeight:700}}>{msg}</div>}
              <div style={{display:"flex",gap:8,marginTop:4}}>
                <button onClick={()=>setModal(null)} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Cancel</button>
                <button onClick={save} disabled={saving} style={{flex:2,padding:"10px 0",background:saving?"#a5b4fc":(primary||"#4f46e5"),color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>{saving?"Saving…":modal==="add"?"Add Product":"Save Changes"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* ── ACTION MENU MODAL ── */}
      {updateModal?.action==="menu"&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,width:"100%",maxWidth:360,maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontWeight:800,fontSize:15}}>Update: {updateModal.product.name}</div>
              <button onClick={()=>setUpdateModal(null)} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"#9ca3af"}}>✕</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {[{id:"rename",label:"Rename",icon:"ti-pencil",color:"#4f46e5"},{id:"category",label:"Change Category",icon:"ti-tag",color:"#0891b2"},{id:"price",label:"Adjust Price",icon:"ti-currency-peso",color:"#059669"},{id:"image",label:"Update Image",icon:"ti-photo",color:"#7c3aed"},{id:"add_stock",label:"Add Stock",icon:"ti-plus",color:"#16a34a"},{id:"remove_stock",label:"Remove Stock",icon:"ti-minus",color:"#dc2626"},{id:"sku",label:"Edit SKU",icon:"ti-barcode",color:"#7c3aed"},{id:"status",label:"Toggle Status",icon:"ti-eye",color:"#6b7280"},{id:"showInPOS",label:"Toggle POS Visibility",icon:"ti-layout-grid",color:"#7c3aed"},{id:"stockMode",label:"Stock Mode",icon:"ti-settings-automation",color:"#7c3aed"}].map(a=>(
                <button key={a.id} onClick={()=>{
                  if(a.id==="status"){const p=updateModal.product;const upd=products.map(x=>x.id===p.id?{...x,active:!x.active}:x);saveField("products",upd).then(ok=>{if(ok)addPortalLog("INVENTORY","status",`Status changed: ${p.name} — ${p.active?"Active → Inactive":"Inactive → Active"}`);});setUpdateModal(null);}
                  else if(a.id==="showInPOS"){const p=updateModal.product;const nv=p.showInPOS===false?true:false;const upd=products.map(x=>x.id===p.id?{...x,showInPOS:nv}:x);saveField("products",upd).then(ok=>{if(ok)addPortalLog("INVENTORY","showInPOS",`POS visibility: ${p.name} — ${nv?"Now visible in POS":"Now hidden from POS"}`);});setUpdateModal(null);}
                  else if(a.id==="stockMode"){const p=updateModal.product;if(!p.recipe?.length)return;const nm=p.stockMode==="auto"?"manual":"auto";const upd=products.map(x=>x.id===p.id?{...x,stockMode:nm}:x);saveField("products",upd).then(ok=>{if(ok)addPortalLog("INVENTORY","stockMode",`Stock mode: ${p.name} → ${nm}`);});setUpdateModal(null);}
                  else{setUpdateModal({...updateModal,action:a.id});setActionVal(a.id==="category"?updateModal.product.category:"");setActionVal2("");}
                }} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",textAlign:"left"}}>
                  <div style={{width:34,height:34,borderRadius:9,background:a.color+"18",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><i className={`ti ${a.icon}`} style={{fontSize:17,color:a.color}}/></div>
                  <span style={{fontWeight:700,fontSize:13,color:"#374151",flex:1}}>{a.label}</span>
                  {a.id==="status"&&<span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:10,background:updateModal.product.active?"#f0fdf4":"#fef2f2",color:updateModal.product.active?"#166534":"#991b1b"}}>{updateModal.product.active?"Active":"Inactive"}</span>}
                  {a.id!=="status"&&<i className="ti ti-chevron-right" style={{fontSize:15,color:"#d1d5db"}}/>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── ACTION SUB-MODALS ── */}
      {updateModal&&updateModal.action!=="menu"&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,width:"100%",maxWidth:420,maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontWeight:800,fontSize:15}}>{updateModal.action==="rename"?"Rename":updateModal.action==="category"?"Change Category":updateModal.action==="price"?"Adjust Price":updateModal.action==="image"?"Update Image":updateModal.action==="add_stock"?"Add Stock":updateModal.action==="remove_stock"?"Remove Stock":updateModal.action==="sku"?"Edit SKU":updateModal.action==="delete"?"Delete Product":"Update"}</div>
              <button onClick={()=>setUpdateModal(null)} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"#9ca3af"}}>✕</button>
            </div>
            <div style={{background:"#f9fafb",borderRadius:8,padding:"8px 12px",marginBottom:14,fontSize:12,color:"#6b7280"}}>Product: <b style={{color:"#111"}}>{updateModal.product.name}</b></div>
            {updateModal.action==="rename"&&<FRow label="New Name"><input value={actionVal} onChange={e=>setActionVal(e.target.value)} placeholder={updateModal.product.name} style={INP} autoFocus onKeyDown={e=>e.key==="Enter"&&doAction()}/></FRow>}
            {updateModal.action==="category"&&<FRow label="New Category"><select value={actionVal} onChange={e=>setActionVal(e.target.value)} style={INP}>{categories.map(c=><option key={c} value={c}>{c}</option>)}</select></FRow>}
            {updateModal.action==="price"&&<FRow label={`New Price (current: ₱${updateModal.product.price})`}><input type="number" value={actionVal} onChange={e=>setActionVal(e.target.value)} placeholder="0.00" style={INP} autoFocus/></FRow>}
            {updateModal.action==="add_stock"&&<><FRow label={`Qty to Add (current: ${updateModal.product.stock})`}><input type="number" value={actionVal} onChange={e=>setActionVal(e.target.value)} placeholder="0" style={INP} autoFocus/></FRow><div style={{marginTop:10}}><FRow label="Note (optional)"><input value={actionVal2} onChange={e=>setActionVal2(e.target.value)} placeholder="e.g. Restock delivery" style={INP}/></FRow></div></>}
            {updateModal.action==="remove_stock"&&<><FRow label={`Qty to Remove (current: ${updateModal.product.stock})`}><input type="number" value={actionVal} onChange={e=>setActionVal(e.target.value)} placeholder="0" style={INP} autoFocus/></FRow><div style={{marginTop:10}}><FRow label="Reason (required)"><input value={actionVal2} onChange={e=>setActionVal2(e.target.value)} placeholder="e.g. Damaged, Expired…" style={INP}/></FRow></div></>}
            {updateModal.action==="sku"&&<FRow label={`New SKU (current: ${updateModal.product.sku||"none"})`}><input value={actionVal} onChange={e=>setActionVal(e.target.value.toUpperCase())} placeholder="e.g. SW00001" style={{...INP,fontFamily:"monospace",fontWeight:700}} autoFocus/></FRow>}
            {updateModal.action==="image"&&(
              <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:14}}>
                <div style={{width:80,height:80,borderRadius:10,border:"2px dashed #e5e7eb",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",background:"#f9fafb",flexShrink:0}}>
                  {(actionVal&&actionVal!=="__remove__")||(!actionVal&&updateModal.product.image)?<img src={actionVal&&actionVal!=="__remove__"?actionVal:updateModal.product.image} alt="preview" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<i className="ti ti-photo" style={{fontSize:28,color:"#d1d5db"}}/>}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  <button onClick={()=>{const inp=document.createElement("input");inp.type="file";inp.accept="image/*";inp.onchange=async e=>{const f=e.target.files[0];if(!f)return;const c=await compressImage(f);const sId=getSession()?.storeId||"";const url=sId?await supa.uploadImage(sId,updateModal.product.id,c):null;setActionVal(url||c);};inp.click();}} style={{padding:"7px 14px",border:"1px solid #e5e7eb",borderRadius:7,cursor:"pointer",fontSize:12,background:"#f9fafb",fontWeight:700,display:"flex",alignItems:"center",gap:5}}><i className="ti ti-upload"/>Upload</button>
                  {(actionVal||updateModal.product.image)&&<button onClick={()=>setActionVal("__remove__")} style={{padding:"5px 12px",border:"1px solid #fecaca",borderRadius:7,cursor:"pointer",fontSize:11,background:"#fef2f2",color:"#991b1b"}}>Remove Image</button>}
                </div>
              </div>
            )}
            {updateModal.action==="delete"&&(
              <div>
                <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                  <div style={{fontWeight:700,color:"#991b1b",marginBottom:4}}>⚠️ Delete "{updateModal.product.name}"?</div>
                  <div style={{fontSize:12,color:"#6b7280"}}>This cannot be undone.</div>
                  {updateModal.product.stock>0&&<div style={{fontSize:12,color:"#dc2626",marginTop:6,fontWeight:700}}>{updateModal.product.stock} units of stock will be lost.</div>}
                </div>
                <FRow label="Reason" hint="optional"><input value={actionVal2} onChange={e=>setActionVal2(e.target.value)} placeholder="e.g. Discontinued…" style={INP} autoFocus/></FRow>
              </div>
            )}
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>setUpdateModal({...updateModal,action:"menu"})} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>← Back</button>
              <button onClick={doAction} disabled={actionLoading} style={{flex:2,padding:"10px 0",background:actionLoading?"#a5b4fc":updateModal.action==="delete"?"#dc2626":(primary||"#4f46e5"),color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>
                {actionLoading?"Saving…":updateModal.action==="delete"?"Delete Product":"Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

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
function Settings({store,data,session,saveField,onRefresh,setStore}){
  const [sTab,setSTab]=useState("appearance");
  const theme=data?.theme||{};
  const orderSettings=data?.order_settings||{};
  const skuSettings=data?.sku_settings||{};
  const [themeForm,setThemeForm]=useState({
    storeName:  theme.storeName||store?.store_name||"My Store",
    primary:    theme.primary||"#4f46e5",
    sidebar:    theme.sidebar||"#1a1a2e",
    bgColor:    theme.bgColor||"#f0f0f8",
    logoText:   theme.logoText||"POS",
    fontFamily: theme.fontFamily||"sans-serif",
    borderRadius:theme.borderRadius||"10",
  });
  const [osForm,setOsForm]=useState({
    vatEnabled:  orderSettings.vatEnabled||false,
    vatPercent:  orderSettings.vatPercent||12,
    orderTypes:  (()=>{
      const types = orderSettings.orderTypes||[];
      const BUILT_INS=[{id:"ot1",label:"Dine-in",enabled:false,locked:true},{id:"ot2",label:"Take-out",enabled:false,locked:true}];
      const hasOt1=types.some(t=>t.id==="ot1"), hasOt2=types.some(t=>t.id==="ot2");
      if(!hasOt1||!hasOt2) return [...BUILT_INS.filter(bi=>!types.some(t=>t.id===bi.id)),...types.map(t=>(t.id==="ot1"||t.id==="ot2")?{...t,locked:true}:t)];
      return types;
    })(),
    orderSources:orderSettings.orderSources||[],
    orderNumPrefix: orderSettings.orderNumPrefix||"ORD",
    orderNumFormat: orderSettings.orderNumFormat||"prefix-datetime",
  });
  const [skuForm,setSkuForm]=useState({
    prefix: skuSettings.prefix||"SW",
    suffix: skuSettings.suffix||"",
    counter:skuSettings.counter||0,
  });
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState("");
  const [err,setErr]=useState("");

  const saveTheme=async()=>{
    setSaving(true);setErr("");
    const newTheme={...theme,...themeForm};
    const ok=await saveField("theme",newTheme);
    // Also update store name in stores table
    if(themeForm.storeName!==store?.store_name){
      await supa.update("stores",{id:session.storeId},{store_name:themeForm.storeName});
      setStore(s=>({...s,store_name:themeForm.storeName}));
    }
    setSaving(false);
    if(ok){setSaved("appearance");setTimeout(()=>setSaved(""),2000);}else setErr("Failed to save. Check connection.");
  };

  const saveOrderSettings=async()=>{
    setSaving(true);setErr("");
    const ok=await saveField("order_settings",osForm);
    setSaving(false);
    if(ok){setSaved("orders");setTimeout(()=>setSaved(""),2000);}else setErr("Failed to save.");
  };

  const saveSku=async()=>{
    const p=skuForm.prefix.trim().toUpperCase();
    const s=skuForm.suffix.trim().toUpperCase();
    if(!p||p.length<2||p.length>5){setErr("Prefix must be 2–5 characters");return;}
    if(s&&(s.length<2||s.length>5)){setErr("Suffix must be 2–5 chars or empty");return;}
    setSaving(true);setErr("");
    const ok=await saveField("sku_settings",{...skuForm,prefix:p,suffix:s});
    setSaving(false);
    if(ok){setSaved("sku");setTimeout(()=>setSaved(""),2000);}else setErr("Failed to save.");
  };

  const addOrderType=()=>setOsForm(f=>({...f,orderTypes:[...f.orderTypes,{id:"ot"+uid(),label:"",enabled:true}]}));
  const updOrderType=(id,field,val)=>setOsForm(f=>({...f,orderTypes:f.orderTypes.map(t=>t.id===id?{...t,[field]:val}:t)}));
  const delOrderType=(id)=>setOsForm(f=>({...f,orderTypes:f.orderTypes.filter(t=>t.id!==id)}));
  const addOrderSource=()=>setOsForm(f=>({...f,orderSources:[...f.orderSources,{id:"os"+uid(),label:"",enabled:true}]}));
  const updOrderSource=(id,field,val)=>setOsForm(f=>({...f,orderSources:f.orderSources.map(s=>s.id===id?{...s,[field]:val}:s)}));
  const delOrderSource=(id)=>setOsForm(f=>({...f,orderSources:f.orderSources.filter(s=>s.id!==id)}));

  const FONTS=["sans-serif","Arial","Georgia","Courier New","Trebuchet MS","Verdana"];
  const TABS=[{k:"appearance",l:"Appearance"},{k:"orders",l:"Order Settings"},{k:"sku",l:"SKU"},{k:"devices",l:"Devices"}];
  const rBg=parseInt(themeForm.borderRadius);

  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
        {TABS.map(t=><button key={t.k} onClick={()=>{setSTab(t.k);setErr("");}} style={{padding:"6px 16px",borderRadius:8,border:"1px solid",cursor:"pointer",fontSize:13,fontWeight:700,borderColor:sTab===t.k?"#4f46e5":"#e5e7eb",background:sTab===t.k?"#4f46e5":"#fff",color:sTab===t.k?"#fff":"#6b7280"}}>{t.l}</button>)}
      </div>

      {/* ── APPEARANCE ── */}
      {sTab==="appearance"&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:14}}>
          <Card style={{gridColumn:"1/-1"}}>
            <SectionTitle>Branding</SectionTitle>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12,marginBottom:12}}>
              <FRow label="Store Name"><input value={themeForm.storeName} onChange={e=>setThemeForm(f=>({...f,storeName:e.target.value}))} style={INP}/></FRow>
              <FRow label="Logo Initials"><input value={themeForm.logoText} onChange={e=>setThemeForm(f=>({...f,logoText:e.target.value}))} maxLength={4} style={INP}/></FRow>
              <FRow label="Font"><select value={themeForm.fontFamily} onChange={e=>setThemeForm(f=>({...f,fontFamily:e.target.value}))} style={INP}>{FONTS.map(ff=><option key={ff} value={ff}>{ff}</option>)}</select></FRow>
            </div>
            <div>
              <label style={LBL}>Corner Radius: {themeForm.borderRadius}px</label>
              <input type="range" min={0} max={24} step={1} value={themeForm.borderRadius} onChange={e=>setThemeForm(f=>({...f,borderRadius:e.target.value}))} style={{width:"100%",marginTop:6}}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#9ca3af"}}><span>Sharp</span><span>Rounded</span></div>
            </div>
          </Card>
          <Card>
            <SectionTitle>Colors</SectionTitle>
            {[{k:"primary",l:"Primary Color"},{k:"sidebar",l:"Sidebar Background"},{k:"bgColor",l:"Page Background"}].map(({k,l})=>(
              <div key={k} style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
                <input type="color" value={themeForm[k]} onChange={e=>setThemeForm(f=>({...f,[k]:e.target.value}))} style={{width:40,height:40,border:"none",borderRadius:8,cursor:"pointer",padding:2}}/>
                <div><div style={{fontSize:12,fontWeight:700}}>{l}</div><div style={{fontSize:11,color:"#9ca3af",fontFamily:"monospace"}}>{themeForm[k]}</div></div>
              </div>
            ))}
          </Card>
          {/* Live preview */}
          <Card style={{background:themeForm.bgColor,fontFamily:themeForm.fontFamily+",sans-serif"}}>
            <div style={{fontSize:11,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:0.5,marginBottom:12}}>Live Preview</div>
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
              <div style={{width:42,height:42,borderRadius:rBg+4+"px",background:themeForm.primary,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{color:"#fff",fontWeight:800,fontSize:14}}>{(themeForm.logoText||"P").slice(0,2).toUpperCase()}</span></div>
              <button style={{padding:"8px 16px",background:themeForm.primary,color:"#fff",border:"none",borderRadius:rBg+"px",cursor:"pointer",fontWeight:800,fontFamily:themeForm.fontFamily+",sans-serif",fontSize:13}}>Charge ₱120.00</button>
              <div style={{padding:"6px 12px",background:"#fff",border:`2px solid ${themeForm.primary}`,borderRadius:rBg+"px",fontSize:13,fontWeight:700,color:themeForm.primary}}>{themeForm.storeName}</div>
            </div>
            <div style={{padding:10,background:themeForm.sidebar,borderRadius:rBg+"px",display:"flex",gap:6}}>
              {["ti-shopping-cart","ti-receipt","ti-box","ti-chart-bar","ti-settings"].map(ic=>(
                <div key={ic} style={{width:36,height:36,borderRadius:7,background:"rgba(255,255,255,0.08)",display:"flex",alignItems:"center",justifyContent:"center"}}><i className={`ti ${ic}`} style={{fontSize:16,color:"rgba(255,255,255,0.5)"}}/></div>
              ))}
            </div>
          </Card>
          {err&&<div style={{gridColumn:"1/-1"}}><Err msg={err}/></div>}
          <div style={{gridColumn:"1/-1"}}>
            <button onClick={saveTheme} disabled={saving} style={{padding:"12px 32px",background:saving?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,cursor:"pointer",fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:8}}>
              {saving?<><i className="ti ti-loader-2"/>Saving…</>:saved==="appearance"?<><i className="ti ti-check"/>Saved!</>:<><i className="ti ti-device-floppy"/>Apply & Save</>}
            </button>
          </div>
        </div>
      )}

      {/* ── ORDER SETTINGS ── */}
      {sTab==="orders"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <Card>
            <SectionTitle>VAT / Tax</SectionTitle>
            <div style={{marginBottom:12}}><Toggle checked={osForm.vatEnabled} onChange={v=>setOsForm(f=>({...f,vatEnabled:v}))} label="Enable VAT by default on new orders"/></div>
            <FRow label="VAT Percentage (%)"><input type="number" value={osForm.vatPercent} onChange={e=>setOsForm(f=>({...f,vatPercent:parseFloat(e.target.value)||0}))} min={0} max={100} style={{...INP,maxWidth:120}}/></FRow>
          </Card>
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div><SectionTitle>Order Types</SectionTitle><div style={{fontSize:11,color:"#9ca3af",marginTop:-10,marginBottom:8}}>Shown above discount section in cart</div></div>
              <button onClick={addOrderType} style={{padding:"5px 12px",background:"#4f46e5",color:"#fff",border:"none",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:4}}><i className="ti ti-plus"/>Add</button>
            </div>
            {osForm.orderTypes.filter(t=>!t.locked).length===0&&osForm.orderTypes.filter(t=>t.locked).length===0&&<div style={{fontSize:12,color:"#9ca3af"}}>No order types yet. Add one above.</div>}
            {osForm.orderTypes.map(t=>(
              t.locked ? (
                <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,padding:"9px 12px",background:"#f9fafb",borderRadius:8,border:"1px solid #e5e7eb"}}>
                  <Toggle checked={t.enabled||false} onChange={v=>updOrderType(t.id,"enabled",v)} label=""/>
                  <span style={{flex:1,fontSize:13,fontWeight:700,color:"#374151"}}>{t.label}</span>
                  <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:8,background:"#fef3c7",color:"#92400e"}}>Built-in</span>
                </div>
              ) : (
                <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,padding:"7px 10px",background:"#f9fafb",borderRadius:8}}>
                  <input type="checkbox" checked={t.enabled} onChange={e=>updOrderType(t.id,"enabled",e.target.checked)} style={{width:16,height:16,accentColor:"#4f46e5",cursor:"pointer",flexShrink:0}}/>
                  <input value={t.label} onChange={e=>updOrderType(t.id,"label",e.target.value)} placeholder="e.g. Delivery" style={{...INP,flex:1,padding:"6px 10px"}}/>
                  <button onClick={()=>delOrderType(t.id)} style={{background:"none",border:"1px solid #fecaca",borderRadius:6,padding:"5px 7px",cursor:"pointer",color:"#ef4444",flexShrink:0}}><i className="ti ti-trash" style={{fontSize:13}}/></button>
                </div>
              )
            ))}
          </Card>
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div><SectionTitle>Order Sources</SectionTitle><div style={{fontSize:11,color:"#9ca3af",marginTop:-10,marginBottom:8}}>Shown in the payment screen</div></div>
              <button onClick={addOrderSource} style={{padding:"5px 12px",background:"#4f46e5",color:"#fff",border:"none",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:4}}><i className="ti ti-plus"/>Add</button>
            </div>
            {osForm.orderSources.length===0&&<div style={{fontSize:12,color:"#9ca3af"}}>No order sources yet. Add one above.</div>}
            {osForm.orderSources.map(s=>(
              <div key={s.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,padding:"7px 10px",background:"#f9fafb",borderRadius:8}}>
                <input type="checkbox" checked={s.enabled} onChange={e=>updOrderSource(s.id,"enabled",e.target.checked)} style={{width:16,height:16,accentColor:"#4f46e5",cursor:"pointer",flexShrink:0}}/>
                <input value={s.label} onChange={e=>updOrderSource(s.id,"label",e.target.value)} placeholder="e.g. Walk-in" style={{...INP,flex:1,padding:"6px 10px"}}/>
                <button onClick={()=>delOrderSource(s.id)} style={{background:"none",border:"1px solid #fecaca",borderRadius:6,padding:"5px 7px",cursor:"pointer",color:"#ef4444",flexShrink:0}}><i className="ti ti-trash" style={{fontSize:13}}/></button>
              </div>
            ))}
          </Card>
          <Card>
            <SectionTitle>Order Number Format</SectionTitle>
            <FRow label="Prefix" hint="max 8 chars"><input value={osForm.orderNumPrefix} onChange={e=>setOsForm(f=>({...f,orderNumPrefix:e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8)}))} placeholder="ORD" style={{...INP,maxWidth:160,fontFamily:"monospace",fontWeight:700}}/></FRow>
            <div style={{marginTop:12}}>
              <label style={LBL}>Format</label>
              <div style={{display:"flex",flexDirection:"column",gap:7,marginTop:7}}>
                {[
                  {val:"prefix-datetime",  ex:`${osForm.orderNumPrefix}20260613032943`, desc:"Prefix + Date & Time (unique per second)"},
                  {val:"prefix-seq",       ex:`${osForm.orderNumPrefix}00001`,          desc:"Prefix + Sequential Number"},
                  {val:"prefix-date-seq",  ex:`${osForm.orderNumPrefix}20260613-0001`,  desc:"Prefix + Date + Daily Sequence"},
                ].map(f=>(
                  <label key={f.val} onClick={()=>setOsForm(x=>({...x,orderNumFormat:f.val}))} style={{display:"flex",alignItems:"flex-start",gap:9,cursor:"pointer",padding:"9px 12px",borderRadius:8,background:(osForm.orderNumFormat||"prefix-datetime")===f.val?"#f5f3ff":"#f9fafb",border:`1.5px solid ${(osForm.orderNumFormat||"prefix-datetime")===f.val?"#4f46e5":"#e5e7eb"}`}}>
                    <div style={{width:14,height:14,borderRadius:"50%",border:`2px solid ${(osForm.orderNumFormat||"prefix-datetime")===f.val?"#4f46e5":"#d1d5db"}`,background:(osForm.orderNumFormat||"prefix-datetime")===f.val?"#4f46e5":"#fff",flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {(osForm.orderNumFormat||"prefix-datetime")===f.val&&<div style={{width:5,height:5,borderRadius:"50%",background:"#fff"}}/>}
                    </div>
                    <div><div style={{fontWeight:700,fontSize:12,color:(osForm.orderNumFormat||"prefix-datetime")===f.val?"#4f46e5":"#374151"}}>{f.desc}</div><div style={{fontFamily:"monospace",fontSize:12,fontWeight:800,color:(osForm.orderNumFormat||"prefix-datetime")===f.val?"#4f46e5":"#6b7280",marginTop:3}}>{f.ex}</div></div>
                  </label>
                ))}
              </div>
            </div>
          </Card>
          {err&&<Err msg={err}/>}
          <button onClick={saveOrderSettings} disabled={saving} style={{padding:"12px 32px",background:saving?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,cursor:"pointer",fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:8,width:"fit-content"}}>
            {saving?<><i className="ti ti-loader-2"/>Saving…</>:saved==="orders"?<><i className="ti ti-check"/>Saved!</>:<><i className="ti ti-device-floppy"/>Save Order Settings</>}
          </button>
        </div>
      )}

      {/* ── SKU ── */}
      {sTab==="sku"&&(
        <Card>
          <SectionTitle>SKU / Product Code Format</SectionTitle>
          <div style={{fontSize:12,color:"#9ca3af",marginBottom:16}}>Auto-generated when adding products. Format: PREFIX + 5 digits + SUFFIX (optional)</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
            <FRow label="Prefix" hint="2–5 chars, required"><input value={skuForm.prefix} onChange={e=>setSkuForm(f=>({...f,prefix:e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5)}))} placeholder="SW" style={INP} maxLength={5}/></FRow>
            <FRow label="Suffix" hint="2–5 chars, optional"><input value={skuForm.suffix} onChange={e=>setSkuForm(f=>({...f,suffix:e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,5)}))} placeholder="PH" style={INP} maxLength={5}/></FRow>
          </div>
          <div style={{background:"#f5f3ff",borderRadius:10,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10}}>
            <i className="ti ti-tag" style={{fontSize:18,color:"#4f46e5"}}/>
            <div><div style={{fontSize:10,fontWeight:800,color:"#5b21b6",textTransform:"uppercase",letterSpacing:0.5,marginBottom:2}}>Next SKU Preview</div><div style={{fontFamily:"monospace",fontWeight:800,fontSize:20,color:"#4f46e5",letterSpacing:2}}>{skuForm.prefix.toUpperCase()}{String(skuForm.counter+1).padStart(5,"0")}{skuForm.suffix.toUpperCase()}</div></div>
          </div>
          {err&&<Err msg={err}/>}
          <button onClick={saveSku} disabled={saving} style={{padding:"11px 24px",background:saving?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,cursor:"pointer",fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:8}}>
            {saving?<><i className="ti ti-loader-2"/>Saving…</>:saved==="sku"?<><i className="ti ti-check"/>Saved!</>:<><i className="ti ti-device-floppy"/>Save SKU Settings</>}
          </button>
        </Card>
      )}

      {/* ── DEVICES ── */}
      {sTab==="devices"&&(
        <DevicesTab store={store} session={session} onRefresh={onRefresh}/>
      )}
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
