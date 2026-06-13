import { useState, useEffect, useRef, useCallback } from "react";

const SUPA_URL  = "https://dwmnrvhlddzynhtkjjqq.supabase.co";
const SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3bW5ydmhsZGR6eW5odGtqanFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNDMzNDcsImV4cCI6MjA5NjkxOTM0N30.feRbP4Zog74FI4r85OaJdoLc8Dmcytykc0mdrgpweHs";
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
};

const fmt        = (n) => `₱${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const todayKey   = () => new Date().toISOString().slice(0,10);
const weekStart  = () => { const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };
const monthStart = () => new Date().toISOString().slice(0,7)+"-01";
const uid        = () => Math.random().toString(36).slice(2,10);

const SESSION_KEY = "portal_session";
const getSession  = () => { try{return JSON.parse(sessionStorage.getItem(SESSION_KEY));}catch{return null;} };
const saveSession = (s) => sessionStorage.setItem(SESSION_KEY,JSON.stringify(s));
const clearSession= () => sessionStorage.removeItem(SESSION_KEY);

const LBL={fontSize:11,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:0.5,display:"block",marginBottom:5};
const INP={width:"100%",padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,background:"#f9fafb",color:"#111",outline:"none",boxSizing:"border-box"};
function Card({children,style={}}){return<div style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",marginBottom:16,...style}}>{children}</div>;}
function SectionTitle({children}){return<div style={{fontWeight:800,fontSize:14,marginBottom:14}}>{children}</div>;}
function FRow({label,children,hint}){return<div><label style={LBL}>{label}{hint&&<span style={{fontSize:10,color:"#9ca3af",marginLeft:6,textTransform:"none",letterSpacing:0}}>{hint}</span>}</label><div style={{marginTop:5}}>{children}</div></div>;}
function Err({msg}){if(!msg)return null;return<div style={{marginTop:10,padding:"9px 12px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,fontSize:13,color:"#991b1b",display:"flex",alignItems:"center",gap:7}}><i className="ti ti-alert-circle" style={{fontSize:15,flexShrink:0}}/>{msg}</div>;}
function Ok({msg}){if(!msg)return null;return<div style={{marginTop:10,padding:"9px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:13,color:"#166534",display:"flex",alignItems:"center",gap:7}}><i className="ti ti-check" style={{fontSize:15,flexShrink:0}}/>{msg}</div>;}
function Toggle({checked,onChange,label}){return<label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}><div onClick={()=>onChange(!checked)} style={{width:40,height:22,borderRadius:11,background:checked?"#4f46e5":"#d1d5db",position:"relative",transition:"background 0.2s",flexShrink:0,cursor:"pointer"}}><div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:checked?20:2,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/></div>{label&&<span style={{fontSize:13,fontWeight:600,color:"#374151"}}>{label}</span>}</label>;}

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
  const [loading,setLoading]=useState(false);
  const [view,setView]=useState("dashboard");
  const [saveStatus,setSaveStatus]=useState(""); // "" | "saving" | "saved" | "error"
  const refreshRef=useRef(null);

  const loadData=useCallback(async(storeId)=>{
    setLoading(true);
    const [s,d]=await Promise.all([
      supa.get("stores",{id:storeId}),
      supa.get("store_data",{store_id:storeId}),
    ]);
    setStore(s); setData(d); setLoading(false);
  },[]);

  useEffect(()=>{
    if(session?.storeId){
      loadData(session.storeId);
      refreshRef.current=setInterval(()=>loadData(session.storeId),60000);
    }
    return()=>clearInterval(refreshRef.current);
  },[session,loadData]);

  // Save any field to store_data
  const saveField=useCallback(async(field,value)=>{
    if(!session?.storeId)return false;
    setSaveStatus("saving");
    const ok=await supa.update("store_data",{store_id:session.storeId},{[field]:value,updated_at:new Date().toISOString()});
    setSaveStatus(ok?"saved":"error");
    setTimeout(()=>setSaveStatus(""),2500);
    if(ok) setData(prev=>({...prev,[field]:value}));
    return ok;
  },[session]);

  const handleLogin=(sess)=>{saveSession(sess);setSession(sess);};
  const handleLogout=()=>{clearSession();setSession(null);setStore(null);setData(null);setView("dashboard");};

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

  // Sync dot
  const SyncBadge=()=>(
    <div title={saveStatus==="saving"?"Saving…":saveStatus==="saved"?"Saved to cloud":saveStatus==="error"?"Save failed":""} style={{width:8,height:8,borderRadius:"50%",background:saveStatus==="saving"?"#f59e0b":saveStatus==="saved"?"#16a34a":saveStatus==="error"?"#dc2626":"transparent",boxShadow:saveStatus==="saved"?"0 0 6px #16a34a":saveStatus==="saving"?"0 0 6px #f59e0b":"none",flexShrink:0,transition:"background 0.3s"}}/>
  );

  return(
    <div style={{minHeight:"100vh",background:BG,fontFamily:"sans-serif"}}>
      {/* HEADER */}
      <div style={{background:SIDEBAR,color:"#fff",padding:"0 20px",display:"flex",alignItems:"center",gap:12,height:54,position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 8px rgba(0,0,0,0.3)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginRight:8}}>
          <div style={{width:30,height:30,borderRadius:8,background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <i className="ti ti-shopping-cart" style={{fontSize:15,color:"#fff"}}/>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:12,lineHeight:1}}>{store?.store_name||"POS Pro"}</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:1}}>Owner Portal</div>
          </div>
        </div>
        <div style={{display:"flex",gap:1,flex:1,overflowX:"auto",scrollbarWidth:"none"}}>
          {NAV.map(n=>(
            <button key={n.id} onClick={()=>setView(n.id)} style={{padding:"6px 10px",borderRadius:7,border:"none",cursor:"pointer",background:view===n.id?PRIMARY:"transparent",color:view===n.id?"#fff":"rgba(255,255,255,0.55)",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",flexShrink:0}}>
              <i className={`ti ${n.icon}`} style={{fontSize:15}}/><span>{n.label}</span>
            </button>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <SyncBadge/>
          <button onClick={()=>loadData(session.storeId)} title="Refresh" style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:7,padding:"5px 9px",cursor:"pointer",color:"rgba(255,255,255,0.7)",fontSize:17}}><i className={`ti ti-refresh${loading?" ti-spin":""}`}/></button>
          <button onClick={handleLogout} title="Sign out" style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:7,padding:"5px 9px",cursor:"pointer",color:"rgba(255,255,255,0.7)",fontSize:17}}><i className="ti ti-logout"/></button>
        </div>
      </div>

      <div style={{maxWidth:1100,margin:"0 auto",padding:"20px 16px"}}>
        {loading&&!data&&<div style={{textAlign:"center",padding:80,color:"#9ca3af"}}><i className="ti ti-loader-2" style={{fontSize:40,display:"block",marginBottom:10}}/>Loading store data…</div>}
        {data&&view==="dashboard"&&<Dashboard store={store} data={data} primary={PRIMARY}/>}
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
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const login=async()=>{
    if(!email.trim()){setError("Enter your email address");return;}
    if(!password.trim()){setError("Enter your password");return;}
    setLoading(true);setError("");
    const store=await supa.get("stores",{owner_email:email.trim().toLowerCase()});
    if(!store){setError("No account found with this email.");setLoading(false);return;}
    if(store.owner_password!==password){setError("Incorrect password.");setLoading(false);return;}
    onLogin({storeId:store.id,email:store.owner_email,storeName:store.store_name,ownerName:store.owner_name});
    setLoading(false);
  };
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif",padding:20}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:66,height:66,borderRadius:18,background:"#4f46e5",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px",boxShadow:"0 8px 32px rgba(79,70,229,0.5)"}}><i className="ti ti-shopping-cart" style={{fontSize:30,color:"#fff"}}/></div>
          <div style={{fontSize:24,fontWeight:800,color:"#fff"}}>POS Pro</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginTop:3}}>Owner Portal</div>
        </div>
        <div style={{background:"#fff",borderRadius:20,padding:"28px 28px 24px",boxShadow:"0 24px 60px rgba(0,0,0,0.4)"}}>
          <div style={{fontWeight:800,fontSize:17,marginBottom:4}}>Sign In</div>
          <div style={{fontSize:13,color:"#9ca3af",marginBottom:20}}>Use your owner email and POS password</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <FRow label="Owner Email"><input type="email" value={email} onChange={e=>{setEmail(e.target.value);setError("");}} onKeyDown={e=>e.key==="Enter"&&login()} placeholder="owner@email.com" style={INP} autoFocus/></FRow>
            <FRow label="Password">
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} value={password} onChange={e=>{setPassword(e.target.value);setError("");}} onKeyDown={e=>e.key==="Enter"&&login()} placeholder="Your POS password" style={{...INP,paddingRight:42}}/>
                <button type="button" onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"#9ca3af",fontSize:18}}><i className={`ti ${showPw?"ti-eye-off":"ti-eye"}`}/></button>
              </div>
            </FRow>
          </div>
          <Err msg={error}/>
          <button onClick={login} disabled={loading} style={{width:"100%",marginTop:18,padding:"12px 0",background:loading?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {loading?<><i className="ti ti-loader-2" style={{fontSize:17}}/>Signing in…</>:<><i className="ti ti-login" style={{fontSize:17}}/>Sign In</>}
          </button>
          <div style={{marginTop:14,padding:"9px 12px",background:"#f5f3ff",borderRadius:8,fontSize:12,color:"#5b21b6"}}><i className="ti ti-info-circle" style={{fontSize:13,marginRight:5}}/>Same password you set when activating the POS app.</div>
        </div>
      </div>
    </div>
  );
}
// ════════════ DASHBOARD ════════════
function Dashboard({store,data,primary}){
  const orders=(data?.orders||[]).filter(o=>o.status==="paid");
  const products=data?.products||[];
  const shifts=data?.shifts||[];
  const activeShift=data?.active_shift;
  const todayOrders=orders.filter(o=>o.dateKey===todayKey());
  const todaySales=todayOrders.reduce((s,o)=>s+o.total,0);
  const weekOrders=orders.filter(o=>o.dateKey>=weekStart());
  const weekSales=weekOrders.reduce((s,o)=>s+o.total,0);
  const lowStock=products.filter(p=>p.active&&p.stock>0&&p.stock<=5);
  const outOfStock=products.filter(p=>p.active&&p.stock<=0);
  const CARDS=[
    {label:"Today's Sales",  value:fmt(todaySales), sub:`${todayOrders.length} orders`,    color:primary,    icon:"ti-currency-peso"},
    {label:"This Week",      value:fmt(weekSales),  sub:`${weekOrders.length} orders`,     color:"#0891b2",  icon:"ti-chart-line"},
    {label:"Total Products", value:products.filter(p=>p.active).length, sub:`${outOfStock.length} out of stock`, color:"#059669", icon:"ti-box"},
    {label:"All Orders",     value:orders.length,   sub:`${shifts.length} shifts recorded`,color:"#d97706",  icon:"ti-receipt"},
  ];
  return(
    <div>
      {activeShift&&<div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:"11px 16px",marginBottom:18,display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:10,height:10,borderRadius:"50%",background:"#16a34a",boxShadow:"0 0 8px #16a34a",flexShrink:0}}/>
        <div style={{fontSize:13}}><b style={{color:"#166534"}}>Shift in progress</b> — {activeShift.cashier} · Started: {activeShift.startTime} · Opening cash: {fmt(activeShift.openCash)}</div>
      </div>}
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
function Reports({store,data,primary}){
  const [period,setPeriod]=useState("today");
  const [tab,setTab]=useState("sales");
  const [from,setFrom]=useState("");const [to,setTo]=useState("");
  const allOrders=(data?.orders||[]).filter(o=>o.status==="paid");
  const shifts=data?.shifts||[];
  const products=data?.products||[];
  const inPeriod=o=>{
    if(period==="today")  return o.dateKey===todayKey();
    if(period==="week")   return o.dateKey>=weekStart();
    if(period==="month")  return o.dateKey>=monthStart();
    if(period==="all")    return true;
    if(period==="custom") return(!from||o.dateKey>=from)&&(!to||o.dateKey<=to);
    return true;
  };
  const orders=allOrders.filter(inPeriod);
  const totalSales=orders.reduce((s,o)=>s+o.total,0);
  const avg=orders.length?totalSales/orders.length:0;
  const prodSales={};orders.forEach(o=>o.items?.forEach(i=>{prodSales[i.name]=(prodSales[i.name]||{qty:0,rev:0});prodSales[i.name].qty+=i.qty;prodSales[i.name].rev+=i.price*i.qty;}));
  const topProds=Object.entries(prodSales).sort((a,b)=>b[1].rev-a[1].rev).slice(0,10);
  const cashierS={};orders.forEach(o=>{cashierS[o.cashier]=(cashierS[o.cashier]||{n:0,rev:0});cashierS[o.cashier].n++;cashierS[o.cashier].rev+=o.total;});
  const typeS={};orders.forEach(o=>{if(o.orderType){typeS[o.orderType]=(typeS[o.orderType]||0)+o.total;}});
  const PERIODS=[{k:"today",l:"Today"},{k:"week",l:"Week"},{k:"month",l:"Month"},{k:"all",l:"All"},{k:"custom",l:"Custom"}];
  const periodLabel=PERIODS.find(p=>p.k===period)?.l||period;
  const doPrintSales=()=>{
    const pRows=topProds.map(([n,d],i)=>`<tr><td>#${i+1} ${n}</td><td class="right">${d.qty}</td><td class="right bold">${fmt(d.rev)}</td></tr>`).join("");
    const cRows=Object.entries(cashierS).map(([n,d])=>`<tr><td>${n}</td><td class="right">${d.n}</td><td class="right bold">${fmt(d.rev)}</td></tr>`).join("");
    const oRows=orders.slice(0,100).map(o=>`<tr><td style="font-family:monospace;font-size:11px">${o.id}</td><td>${o.date}</td><td>${o.cashier}</td><td>${o.payMethod?.toUpperCase()}</td><td class="right bold">${fmt(o.total)}</td></tr>`).join("");
    printReport(`<h1>Sales Report — ${periodLabel}</h1><p class="meta">Store: ${store?.store_name} | Generated: ${new Date().toLocaleString("en-PH")} | ${orders.length} orders</p><div class="summary"><div class="card"><div class="card-label">Total Sales</div><div class="card-val">${fmt(totalSales)}</div></div><div class="card"><div class="card-label">Orders</div><div class="card-val">${orders.length}</div></div><div class="card"><div class="card-label">Avg Order</div><div class="card-val">${fmt(avg)}</div></div></div>${topProds.length?`<h2>Top Products</h2><table><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Revenue</th></tr></thead><tbody>${pRows}</tbody></table>`:""}${Object.keys(cashierS).length?`<h2>By Cashier</h2><table><thead><tr><th>Cashier</th><th class="right">Orders</th><th class="right">Revenue</th></tr></thead><tbody>${cRows}</tbody></table>`:""}${orders.length?`<h2>Orders</h2><table><thead><tr><th>Order ID</th><th>Date</th><th>Cashier</th><th>Payment</th><th class="right">Total</th></tr></thead><tbody>${oRows}</tbody></table>`:""}`,`Sales Report — ${store?.store_name}`);
  };
  const doPrintShifts=()=>{
    const rows=shifts.map(s=>`<tr><td>${s.cashier}</td><td style="font-size:10px">${s.startTime}<br/>${s.endTime}</td><td class="right">${s.shiftOrders}</td><td class="right">${fmt(s.openCash)}</td><td class="right">${fmt(s.totalSales)}</td><td class="right">${fmt(s.totalExpenses||0)}</td><td class="right">${fmt(s.closeCash)}</td><td class="right ${s.overShort>=0?"green":"red"}">${s.overShort>=0?"+":""}${fmt(s.overShort)}</td></tr>`).join("");
    printReport(`<h1>Shift Report</h1><p class="meta">Store: ${store?.store_name} | ${shifts.length} shifts</p><table><thead><tr><th>Cashier</th><th>Period</th><th class="right">Orders</th><th class="right">Opening</th><th class="right">Sales</th><th class="right">Expenses</th><th class="right">Closing</th><th class="right">Over/Short</th></tr></thead><tbody>${rows}</tbody></table>`,`Shift Report — ${store?.store_name}`);
  };
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div style={{display:"flex",gap:5}}>
          {[{k:"sales",l:"Sales"},{k:"shifts",l:"Shifts"}].map(t=><button key={t.k} onClick={()=>setTab(t.k)} style={{padding:"5px 14px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:12,fontWeight:700,borderColor:tab===t.k?primary:"#e5e7eb",background:tab===t.k?primary:"#fff",color:tab===t.k?"#fff":"#6b7280"}}>{t.l}</button>)}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          {tab==="sales"&&PERIODS.map(p=><button key={p.k} onClick={()=>setPeriod(p.k)} style={{padding:"4px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:700,borderColor:period===p.k?primary:"#e5e7eb",background:period===p.k?primary:"#fff",color:period===p.k?"#fff":"#6b7280"}}>{p.l}</button>)}
          <button onClick={tab==="sales"?doPrintSales:doPrintShifts} style={{padding:"5px 12px",background:"#374151",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:5}}><i className="ti ti-printer" style={{fontSize:14}}/>Print</button>
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
      {tab==="shifts"&&<div style={{display:"flex",flexDirection:"column",gap:10}}>
        {shifts.length===0&&<Card><div style={{textAlign:"center",color:"#9ca3af",padding:"24px 0",fontSize:13}}>No completed shifts yet</div></Card>}
        {shifts.map(s=>(
          <Card key={s.id}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,flexWrap:"wrap",gap:6}}>
              <div><div style={{fontWeight:800,fontSize:13}}>{s.cashier}</div><div style={{fontSize:11,color:"#9ca3af"}}>{s.startTime} → {s.endTime}</div></div>
              <span style={{fontSize:13,fontWeight:800,padding:"3px 10px",borderRadius:10,background:s.overShort>=0?"#f0fdf4":"#fef2f2",color:s.overShort>=0?"#166534":"#991b1b"}}>{s.overShort>=0?"+":""}{fmt(s.overShort)}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(90px,1fr))",gap:7}}>
              {[{l:"Sales",v:fmt(s.totalSales)},{l:"Opening",v:fmt(s.openCash)},{l:"Closing",v:fmt(s.closeCash)},{l:"Expenses",v:fmt(s.totalExpenses||0)},{l:"Orders",v:s.shiftOrders}].map(m=>(
                <div key={m.l} style={{background:"#f9fafb",borderRadius:8,padding:"6px 10px"}}><div style={{fontSize:10,color:"#9ca3af"}}>{m.l}</div><div style={{fontSize:13,fontWeight:800}}>{m.v}</div></div>
              ))}
            </div>
          </Card>
        ))}
      </div>}
    </div>
  );
}
// ════════════ INVENTORY ════════════
function Inventory({store,data,session,saveField,primary}){
  const products=data?.products||[];
  const categories=data?.categories||[];
  const [search,setSearch]=useState("");
  const [catFilter,setCat]=useState("All");
  const [editModal,setEditModal]=useState(null);
  const [form,setForm]=useState({});
  const [saving,setSaving]=useState(false);
  const [msg,setMsg]=useState("");

  const filtered=products.filter(p=>(catFilter==="All"||p.category===catFilter)&&(p.name.toLowerCase().includes(search.toLowerCase())||p.sku?.includes(search)));

  const openEdit=(p)=>{setForm({...p,price:String(p.price),stock:String(p.stock)});setEditModal(true);setMsg("");};

  const save=async()=>{
    setSaving(true);
    const updated=products.map(p=>p.id===form.id?{...form,price:parseFloat(form.price)||0,stock:parseInt(form.stock)||0}:p);
    const ok=await saveField("products",updated);
    setSaving(false);setMsg(ok?"Saved!":"Failed to save.");
    if(ok)setTimeout(()=>{setEditModal(null);setMsg("");},800);
  };

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div style={{fontWeight:800,fontSize:18}}>Inventory <span style={{fontSize:13,fontWeight:600,color:"#9ca3af"}}>({products.filter(p=>p.active).length} active)</span></div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search products…" style={{...INP,width:220,padding:"7px 12px"}}/>
      </div>
      {/* Category filters */}
      <div style={{display:"flex",gap:5,marginBottom:14,flexWrap:"wrap"}}>
        {["All",...categories].map(c=><button key={c} onClick={()=>setCat(c)} style={{padding:"3px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:700,borderColor:catFilter===c?primary:"#e5e7eb",background:catFilter===c?primary:"#fff",color:catFilter===c?"#fff":"#6b7280"}}>{c}</button>)}
      </div>
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:520}}>
            <thead><tr style={{background:"#f9fafb"}}>{["Product","Category","Price","Stock","SKU","Status",""].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",fontWeight:700,fontSize:11,color:"#6b7280",borderBottom:"1px solid #e5e7eb",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
            <tbody>
              {filtered.map(p=>(
                <tr key={p.id} style={{borderBottom:"1px solid #f3f4f6",opacity:p.active?1:0.5}}>
                  <td style={{padding:"10px 14px",fontWeight:700}}>{p.name}</td>
                  <td style={{padding:"10px 14px",color:"#6b7280"}}>{p.category}</td>
                  <td style={{padding:"10px 14px",fontWeight:800,color:primary}}>{fmt(p.price)}</td>
                  <td style={{padding:"10px 14px"}}><span style={{fontWeight:800,color:p.stock<=0?"#ef4444":p.stock<=5?"#f59e0b":"#111"}}>{p.stock}</span></td>
                  <td style={{padding:"10px 14px",fontFamily:"monospace",fontSize:11,color:"#9ca3af"}}>{p.sku||"—"}</td>
                  <td style={{padding:"10px 14px"}}><span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:p.active?"#f0fdf4":"#fef2f2",color:p.active?"#166534":"#991b1b"}}>{p.active?"Active":"Hidden"}</span></td>
                  <td style={{padding:"10px 14px"}}><button onClick={()=>openEdit(p)} style={{background:"none",border:"1px solid #e5e7eb",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12,color:"#6b7280"}}>Edit</button></td>
                </tr>
              ))}
              {filtered.length===0&&<tr><td colSpan={7} style={{padding:"32px",textAlign:"center",color:"#9ca3af",fontSize:13}}>No products found</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {editModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:16}} onClick={e=>e.target===e.currentTarget&&setEditModal(null)}>
          <div style={{background:"#fff",borderRadius:14,padding:24,width:"100%",maxWidth:380}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:16}}>Edit Product</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <FRow label="Name"><input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} style={INP}/></FRow>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <FRow label="Price (₱)"><input type="number" value={form.price} onChange={e=>setForm(f=>({...f,price:e.target.value}))} style={INP}/></FRow>
                <FRow label="Stock"><input type="number" value={form.stock} onChange={e=>setForm(f=>({...f,stock:e.target.value}))} style={INP}/></FRow>
              </div>
              <FRow label="Category"><input value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} style={INP}/></FRow>
              <FRow label="Status"><select value={form.active?"active":"hidden"} onChange={e=>setForm(f=>({...f,active:e.target.value==="active"}))} style={INP}><option value="active">Active</option><option value="hidden">Hidden</option></select></FRow>
            </div>
            {msg&&<div style={{marginTop:10,fontSize:13,color:msg==="Saved!"?"#166534":"#991b1b",fontWeight:700}}>{msg}</div>}
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>setEditModal(null)} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,background:"#fff"}}>Cancel</button>
              <button onClick={save} disabled={saving} style={{flex:2,padding:"10px 0",background:saving?"#a5b4fc":primary,color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>{saving?"Saving…":"Save Changes"}</button>
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

  const voidOrder=async(id)=>{
    const updated=orders.map(o=>o.id===id?{...o,status:"void"}:o);
    await saveField("orders",updated);
    setDetail(null);
  };

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
              {detail.status==="paid"&&<button onClick={()=>voidOrder(detail.id)} style={{flex:1,padding:"9px 0",background:"#fef2f2",border:"1px solid #fecaca",color:"#991b1b",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700}}>Void Order</button>}
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
  const openEdit=(a)=>{setForm({...a});setModal("edit");setMsg("");setShowPw(false);};

  const save=async()=>{
    if(!form.name||!form.username||!form.password){setMsg("Name, username and password required");return;}
    setSaving(true);
    let updated;
    if(modal==="add"){
      if(accounts.find(a=>a.username===form.username)){setMsg("Username already taken");setSaving(false);return;}
      updated=[...accounts,form];
    } else {
      updated=accounts.map(a=>a.id===form.id?form:a);
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
                  <input type={showPw?"text":"password"} value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} style={{...INP,paddingRight:38}}/>
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
    orderTypes:  orderSettings.orderTypes||[],
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
  const TABS=[{k:"appearance",l:"Appearance"},{k:"orders",l:"Order Settings"},{k:"sku",l:"SKU"}];
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
            {osForm.orderTypes.length===0&&<div style={{fontSize:12,color:"#9ca3af"}}>No order types yet. Add one above.</div>}
            {osForm.orderTypes.map(t=>(
              <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,padding:"7px 10px",background:"#f9fafb",borderRadius:8}}>
                <input type="checkbox" checked={t.enabled} onChange={e=>updOrderType(t.id,"enabled",e.target.checked)} style={{width:16,height:16,accentColor:"#4f46e5",cursor:"pointer",flexShrink:0}}/>
                <input value={t.label} onChange={e=>updOrderType(t.id,"label",e.target.value)} placeholder="e.g. Dine-in" style={{...INP,flex:1,padding:"6px 10px"}}/>
                <button onClick={()=>delOrderType(t.id)} style={{background:"none",border:"1px solid #fecaca",borderRadius:6,padding:"5px 7px",cursor:"pointer",color:"#ef4444",flexShrink:0}}><i className="ti ti-trash" style={{fontSize:13}}/></button>
              </div>
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
    </div>
  );
}
