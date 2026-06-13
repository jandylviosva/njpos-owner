import { useState, useEffect, useRef, useCallback } from "react";

// ════════════════════════════════════════════════════════
// SUPABASE CONFIG — same project as the POS app
// ════════════════════════════════════════════════════════
const SUPA_URL  = "https://dwmnrvhlddzynhtkjjqq.supabase.co";
const SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3bW5ydmhsZGR6eW5odGtqanFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNDMzNDcsImV4cCI6MjA5NjkxOTM0N30.feRbP4Zog74FI4r85OaJdoLc8Dmcytykc0mdrgpweHs";

const H = { "Content-Type":"application/json", "apikey":SUPA_ANON, "Authorization":`Bearer ${SUPA_ANON}` };

const supa = {
  async get(table, match) {
    try {
      const q = Object.entries(match).map(([k,v])=>`${k}=eq.${encodeURIComponent(v)}`).join("&");
      const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${q}&limit=1`,{headers:H});
      const d = await r.json(); return d[0]||null;
    } catch { return null; }
  },
  async update(table, match, data) {
    try {
      const q = Object.entries(match).map(([k,v])=>`${k}=eq.${encodeURIComponent(v)}`).join("&");
      await fetch(`${SUPA_URL}/rest/v1/${table}?${q}`,{method:"PATCH",headers:H,body:JSON.stringify(data)});
    } catch {}
  },
  // Supabase Auth — send OTP to email
  async sendOTP(email) {
    try {
      const r = await fetch(`${SUPA_URL}/auth/v1/otp`,{
        method:"POST", headers:H,
        body: JSON.stringify({ email, create_user: false })
      });
      return r.ok;
    } catch { return false; }
  },
  // Verify OTP token
  async verifyOTP(email, token) {
    try {
      const r = await fetch(`${SUPA_URL}/auth/v1/verify`,{
        method:"POST", headers:H,
        body: JSON.stringify({ type:"email", email, token })
      });
      if(!r.ok) return null;
      return await r.json();
    } catch { return null; }
  },
};

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════
const fmt       = (n) => `₱${Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const todayKey  = () => new Date().toISOString().slice(0,10);
const weekStart = () => { const d=new Date(); d.setDate(d.getDate()-d.getDay()); return d.toISOString().slice(0,10); };

const SESSION_KEY = "portal_session";
const getSession  = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } };
const saveSession = (s) => sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
const clearSession= () => sessionStorage.removeItem(SESSION_KEY);

const LBL = {fontSize:11,fontWeight:800,color:"#6b7280",textTransform:"uppercase",letterSpacing:0.5,display:"block",marginBottom:5};
const INP = {width:"100%",padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:14,background:"#f9fafb",color:"#111",outline:"none",boxSizing:"border-box"};

// ════════════════════════════════════════════════════════
// PRINT REPORT HELPER
// ════════════════════════════════════════════════════════
function printReport(html, title) {
  const win = window.open("","_blank","width=900,height=700");
  if(!win) return;
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:12px;padding:20px;color:#111}h1{font-size:18px;font-weight:800;margin-bottom:4px}h2{font-size:13px;font-weight:700;margin:16px 0 8px;color:#4f46e5;border-bottom:2px solid #4f46e5;padding-bottom:4px}.meta{font-size:11px;color:#6b7280;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin-bottom:16px}th{background:#f3f4f6;padding:6px 8px;text-align:left;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;border-bottom:2px solid #e5e7eb}td{padding:6px 8px;border-bottom:1px solid #f3f4f6}.right{text-align:right}.bold{font-weight:800}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}.card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px}.card-label{font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px}.card-val{font-size:20px;font-weight:800;color:#4f46e5;margin-top:4px}.green{color:#166534}.red{color:#991b1b}@media print{button{display:none!important}}</style>
  </head><body>${html}
  <div style="margin-top:24px;text-align:right">
    <button onclick="window.print()" style="padding:10px 22px;background:#4f46e5;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:800">🖨️ Print</button>
    <button onclick="window.close()" style="padding:10px 22px;background:#f3f4f6;color:#374151;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700;margin-left:8px">Close</button>
  </div></body></html>`);
  win.document.close();
}

// ════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════
export default function App() {
  const [session, setSession] = useState(() => getSession());
  const [store, setStore]     = useState(null);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [view, setView]       = useState("dashboard");
  const refreshRef = useRef(null);

  // Load store data after login
  const loadData = useCallback(async (storeId) => {
    setLoading(true);
    const [s, d] = await Promise.all([
      supa.get("stores", { id: storeId }),
      supa.get("store_data", { store_id: storeId }),
    ]);
    setStore(s);
    setData(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    if(session?.storeId) {
      loadData(session.storeId);
      // Auto-refresh every 60 seconds
      refreshRef.current = setInterval(() => loadData(session.storeId), 60000);
    }
    return () => clearInterval(refreshRef.current);
  }, [session, loadData]);

  const handleLogin = (sess) => { saveSession(sess); setSession(sess); };
  const handleLogout = () => { clearSession(); setSession(null); setStore(null); setData(null); setView("dashboard"); };

  if(!session) return <LoginScreen onLogin={handleLogin}/>;

  return (
    <div style={{minHeight:"100vh",background:"#f0f0f8",fontFamily:"sans-serif"}}>
      <Header store={store} view={view} setView={setView} onLogout={handleLogout} onRefresh={()=>loadData(session.storeId)} loading={loading}/>
      <div style={{maxWidth:1100,margin:"0 auto",padding:"24px 16px"}}>
        {loading && !data && <LoadingScreen/>}
        {data && view==="dashboard" && <Dashboard store={store} data={data}/>}
        {data && view==="reports"   && <Reports   store={store} data={data}/>}
        {data && view==="inventory" && <Inventory store={store} data={data} session={session} onRefresh={()=>loadData(session.storeId)}/>}
        {data && view==="settings"  && <Settings  store={store} data={data} session={session} onRefresh={()=>loadData(session.storeId)}/>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// LOGIN SCREEN — Email then OTP
// ════════════════════════════════════════════════════════
function LoginScreen({ onLogin }) {
  const [step, setStep]       = useState("email"); // email | otp
  const [email, setEmail]     = useState("");
  const [otp, setOtp]         = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [status, setStatus]   = useState("");
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef(null);

  const startCountdown = () => {
    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown(c => { if(c<=1){ clearInterval(timerRef.current); return 0; } return c-1; });
    }, 1000);
  };

  const sendOTP = async () => {
    if(!email.trim() || !/\S+@\S+\.\S+/.test(email)) { setError("Enter a valid email address"); return; }
    setLoading(true); setError(""); setStatus("Sending code to your email…");
    // First check if this email is a registered store owner
    const store = await supa.get("stores", { owner_email: email.trim().toLowerCase() });
    if(!store) { setError("No store found with this email. Contact your POS Pro provider."); setLoading(false); setStatus(""); return; }
    // Send OTP via Supabase Auth
    const ok = await supa.sendOTP(email.trim().toLowerCase());
    if(!ok) {
      // Supabase Auth OTP might need setup — fallback: use simple 6-digit code stored in DB
      // For now show instructions
      setError("OTP email failed. Make sure Supabase Auth is enabled (see setup instructions).");
      setLoading(false); setStatus(""); return;
    }
    setStep("otp"); setStatus(""); startCountdown();
    setLoading(false);
  };

  const verifyOTP = async () => {
    if(!otp.trim() || otp.length < 6) { setError("Enter the 6-digit code from your email"); return; }
    setLoading(true); setError(""); setStatus("Verifying…");
    const result = await supa.verifyOTP(email.trim().toLowerCase(), otp.trim());
    if(!result?.access_token) { setError("Invalid or expired code. Try again."); setLoading(false); setStatus(""); return; }
    // Get store info
    const store = await supa.get("stores", { owner_email: email.trim().toLowerCase() });
    if(!store) { setError("Store not found."); setLoading(false); setStatus(""); return; }
    onLogin({ storeId: store.id, email: store.owner_email, storeName: store.store_name, ownerName: store.owner_name });
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif",padding:20}}>
      <div style={{width:"100%",maxWidth:400}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{width:68,height:68,borderRadius:18,background:"#4f46e5",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",boxShadow:"0 8px 32px rgba(79,70,229,0.5)"}}>
            <i className="ti ti-shopping-cart" style={{fontSize:30,color:"#fff"}}/>
          </div>
          <div style={{fontSize:24,fontWeight:800,color:"#fff"}}>POS Pro</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginTop:3}}>Owner Portal</div>
        </div>

        <div style={{background:"#fff",borderRadius:20,padding:"28px 28px 24px",boxShadow:"0 24px 60px rgba(0,0,0,0.4)"}}>
          {step==="email" && (
            <>
              <div style={{fontWeight:800,fontSize:17,marginBottom:4}}>Sign In</div>
              <div style={{fontSize:13,color:"#9ca3af",marginBottom:22}}>Enter your owner email to receive a sign-in code</div>
              <div style={{marginBottom:16}}>
                <label style={LBL}>Owner Email</label>
                <input type="email" value={email} onChange={e=>{setEmail(e.target.value);setError("");}} placeholder="owner@youremail.com" style={INP} autoFocus onKeyDown={e=>e.key==="Enter"&&sendOTP()}/>
              </div>
              {error&&<div style={{marginBottom:12,padding:"9px 12px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,fontSize:13,color:"#991b1b"}}>{error}</div>}
              {status&&<div style={{marginBottom:12,padding:"9px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:13,color:"#166534"}}>{status}</div>}
              <button onClick={sendOTP} disabled={loading} style={{width:"100%",padding:"12px 0",background:loading?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {loading?<><i className="ti ti-loader-2" style={{fontSize:17}}/>Sending…</>:<><i className="ti ti-mail" style={{fontSize:17}}/>Send Sign-In Code</>}
              </button>
            </>
          )}

          {step==="otp" && (
            <>
              <button onClick={()=>{setStep("email");setOtp("");setError("");clearInterval(timerRef.current);}} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",color:"#6b7280",fontSize:12,fontWeight:600,marginBottom:14,padding:0}}>
                <i className="ti ti-arrow-left" style={{fontSize:15}}/> Back
              </button>
              <div style={{fontWeight:800,fontSize:17,marginBottom:4}}>Enter Your Code</div>
              <div style={{fontSize:13,color:"#9ca3af",marginBottom:6}}>We sent a 6-digit code to:</div>
              <div style={{fontSize:14,fontWeight:700,color:"#4f46e5",marginBottom:20}}>{email}</div>
              <div style={{marginBottom:16}}>
                <label style={LBL}>6-Digit Code</label>
                <input type="text" inputMode="numeric" value={otp} onChange={e=>{setOtp(e.target.value.replace(/\D/g,"").slice(0,6));setError("");}} placeholder="000000" style={{...INP,fontSize:28,fontWeight:800,letterSpacing:8,textAlign:"center"}} autoFocus onKeyDown={e=>e.key==="Enter"&&verifyOTP()}/>
              </div>
              {error&&<div style={{marginBottom:12,padding:"9px 12px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,fontSize:13,color:"#991b1b"}}>{error}</div>}
              <button onClick={verifyOTP} disabled={loading||otp.length<6} style={{width:"100%",padding:"12px 0",background:loading||otp.length<6?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {loading?<><i className="ti ti-loader-2" style={{fontSize:17}}/>Verifying…</>:<><i className="ti ti-check" style={{fontSize:17}}/>Verify & Sign In</>}
              </button>
              <div style={{marginTop:14,textAlign:"center",fontSize:12,color:"#9ca3af"}}>
                {countdown>0
                  ? `Resend code in ${countdown}s`
                  : <button onClick={()=>{setOtp("");sendOTP();}} style={{background:"none",border:"none",cursor:"pointer",color:"#4f46e5",fontSize:12,fontWeight:700}}>Resend Code</button>
                }
              </div>
            </>
          )}
        </div>
        <div style={{marginTop:16,textAlign:"center",fontSize:11,color:"rgba(255,255,255,0.3)"}}>POS Pro Owner Portal v1.0</div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// HEADER
// ════════════════════════════════════════════════════════
function Header({ store, view, setView, onLogout, onRefresh, loading }) {
  const NAV = [
    { id:"dashboard", icon:"ti-layout-dashboard", label:"Dashboard" },
    { id:"reports",   icon:"ti-chart-bar",         label:"Reports"   },
    { id:"inventory", icon:"ti-box",               label:"Inventory" },
    { id:"settings",  icon:"ti-settings",          label:"Settings"  },
  ];
  return (
    <div style={{background:"#1a1a2e",color:"#fff",padding:"0 24px",display:"flex",alignItems:"center",gap:16,height:56,position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 8px rgba(0,0,0,0.3)"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginRight:8}}>
        <div style={{width:32,height:32,borderRadius:8,background:"#4f46e5",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <i className="ti ti-shopping-cart" style={{fontSize:16,color:"#fff"}}/>
        </div>
        <div>
          <div style={{fontWeight:800,fontSize:13,lineHeight:1}}>{store?.store_name||"POS Pro"}</div>
          <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:1}}>Owner Portal</div>
        </div>
      </div>
      <div style={{display:"flex",gap:2,flex:1}}>
        {NAV.map(n=>(
          <button key={n.id} onClick={()=>setView(n.id)} style={{padding:"6px 12px",borderRadius:8,border:"none",cursor:"pointer",background:view===n.id?"rgba(79,70,229,0.8)":"transparent",color:view===n.id?"#fff":"rgba(255,255,255,0.55)",fontSize:13,fontWeight:600,display:"flex",alignItems:"center",gap:6}}>
            <i className={`ti ${n.icon}`} style={{fontSize:16}}/> <span style={{display:window.innerWidth>640?"inline":"none"}}>{n.label}</span>
          </button>
        ))}
      </div>
      <button onClick={onRefresh} title="Refresh data" style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",color:"rgba(255,255,255,0.7)",fontSize:18}}>
        <i className={`ti ti-refresh${loading?" ti-spin":""}`}/>
      </button>
      <button onClick={onLogout} title="Sign out" style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",color:"rgba(255,255,255,0.7)",fontSize:18}}>
        <i className="ti ti-logout"/>
      </button>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div style={{textAlign:"center",padding:80,color:"#9ca3af"}}>
      <i className="ti ti-loader-2" style={{fontSize:40,display:"block",marginBottom:12}}/>
      <div style={{fontSize:14}}>Loading store data…</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════
function Dashboard({ store, data }) {
  const orders  = (data?.orders  || []).filter(o=>o.status==="paid");
  const shifts  = data?.shifts   || [];
  const products= data?.products || [];
  const accounts= data?.accounts || [];

  const todayOrders = orders.filter(o=>o.dateKey===todayKey());
  const todaySales  = todayOrders.reduce((s,o)=>s+o.total, 0);
  const weekOrders  = orders.filter(o=>o.dateKey>=weekStart());
  const weekSales   = weekOrders.reduce((s,o)=>s+o.total, 0);
  const activeShift = data?.active_shift;
  const lowStock    = products.filter(p=>p.active&&p.stock<=5&&p.stock>0);
  const outOfStock  = products.filter(p=>p.active&&p.stock<=0);

  const CARDS = [
    { label:"Today's Sales",   value:fmt(todaySales),     sub:`${todayOrders.length} orders`,      color:"#4f46e5", icon:"ti-currency-peso" },
    { label:"This Week",       value:fmt(weekSales),      sub:`${weekOrders.length} orders`,       color:"#0891b2", icon:"ti-chart-line"    },
    { label:"Total Products",  value:products.filter(p=>p.active).length, sub:`${outOfStock.length} out of stock`, color:"#059669", icon:"ti-box" },
    { label:"Staff Accounts",  value:accounts.length,     sub:`${accounts.filter(a=>a.active).length} active`,    color:"#d97706", icon:"ti-users" },
  ];

  return (
    <div>
      {/* Alert if shift is active */}
      {activeShift&&(
        <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:"12px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:10,height:10,borderRadius:"50%",background:"#16a34a",boxShadow:"0 0 8px #16a34a",flexShrink:0}}/>
          <div style={{fontSize:13}}><b style={{color:"#166534"}}>Shift in progress</b> — {activeShift.cashier} started at {activeShift.startTime} · Opening cash: {fmt(activeShift.openCash)}</div>
        </div>
      )}

      {/* KPI Cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:14,marginBottom:24}}>
        {CARDS.map(c=>(
          <div key={c.label} style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
              <div style={{fontSize:12,color:"#9ca3af",fontWeight:600}}>{c.label}</div>
              <div style={{width:36,height:36,borderRadius:10,background:c.color+"18",display:"flex",alignItems:"center",justifyContent:"center"}}>
                <i className={`ti ${c.icon}`} style={{fontSize:18,color:c.color}}/>
              </div>
            </div>
            <div style={{fontSize:26,fontWeight:800,color:c.color}}>{c.value}</div>
            <div style={{fontSize:12,color:"#9ca3af",marginTop:4}}>{c.sub}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16}}>
        {/* Recent Orders */}
        <div style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>Today's Orders</div>
          {todayOrders.length===0&&<div style={{fontSize:13,color:"#9ca3af",padding:"16px 0",textAlign:"center"}}>No orders today yet</div>}
          {todayOrders.slice(0,8).map(o=>(
            <div key={o.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #f3f4f6"}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,fontFamily:"monospace"}}>{o.id}</div>
                <div style={{fontSize:11,color:"#9ca3af"}}>{o.cashier} · {o.payMethod?.toUpperCase()}{o.orderType?` · ${o.orderType}`:""}</div>
              </div>
              <div style={{fontWeight:800,fontSize:13,color:"#4f46e5"}}>{fmt(o.total)}</div>
            </div>
          ))}
          {todayOrders.length>8&&<div style={{fontSize:12,color:"#9ca3af",marginTop:8,textAlign:"center"}}>+{todayOrders.length-8} more orders</div>}
        </div>

        {/* Stock Alerts */}
        <div style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>Stock Alerts</div>
          {outOfStock.length===0&&lowStock.length===0&&<div style={{fontSize:13,color:"#9ca3af",padding:"16px 0",textAlign:"center"}}>✅ All products are well stocked</div>}
          {outOfStock.map(p=>(
            <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:"#fef2f2",borderRadius:8,marginBottom:6}}>
              <span style={{fontSize:13,fontWeight:600}}>{p.name}</span>
              <span style={{fontSize:11,fontWeight:800,color:"#991b1b",background:"#fee2e2",padding:"2px 8px",borderRadius:10}}>OUT OF STOCK</span>
            </div>
          ))}
          {lowStock.map(p=>(
            <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:"#fffbeb",borderRadius:8,marginBottom:6}}>
              <span style={{fontSize:13,fontWeight:600}}>{p.name}</span>
              <span style={{fontSize:11,fontWeight:800,color:"#92400e",background:"#fef3c7",padding:"2px 8px",borderRadius:10}}>{p.stock} left</span>
            </div>
          ))}
        </div>

        {/* Recent Shifts */}
        {shifts.length>0&&(
          <div style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
            <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>Recent Shifts</div>
            {shifts.slice(0,5).map(s=>(
              <div key={s.id} style={{padding:"8px 0",borderBottom:"1px solid #f3f4f6"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:13,fontWeight:700}}>{s.cashier}</div>
                  <div style={{fontSize:13,fontWeight:800,color:s.overShort>=0?"#166534":"#991b1b"}}>{s.overShort>=0?"+":""}{fmt(s.overShort)}</div>
                </div>
                <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>{s.startTime} · Sales: {fmt(s.totalSales)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════
function Reports({ store, data }) {
  const [period, setPeriod]   = useState("today");
  const [dateFrom, setFrom]   = useState("");
  const [dateTo, setTo]       = useState("");

  const allOrders = (data?.orders||[]).filter(o=>o.status==="paid");
  const inPeriod  = o => {
    if(period==="today") return o.dateKey===todayKey();
    if(period==="week")  return o.dateKey>=weekStart();
    if(period==="month") return o.dateKey>=new Date().toISOString().slice(0,7)+"-01";
    if(period==="all")   return true;
    if(period==="custom") return (!dateFrom||o.dateKey>=dateFrom)&&(!dateTo||o.dateKey<=dateTo);
    return true;
  };
  const orders    = allOrders.filter(inPeriod);
  const total     = orders.reduce((s,o)=>s+o.total, 0);
  const avg       = orders.length?total/orders.length:0;

  const prodSales = {};
  orders.forEach(o=>o.items?.forEach(i=>{
    prodSales[i.name]=(prodSales[i.name]||{qty:0,rev:0});
    prodSales[i.name].qty+=i.qty; prodSales[i.name].rev+=i.price*i.qty;
  }));
  const topProds = Object.entries(prodSales).sort((a,b)=>b[1].rev-a[1].rev).slice(0,10);

  const cashierSales = {};
  orders.forEach(o=>{cashierSales[o.cashier]=(cashierSales[o.cashier]||{n:0,rev:0});cashierSales[o.cashier].n++;cashierSales[o.cashier].rev+=o.total;});

  const PERIODS = [{k:"today",l:"Today"},{k:"week",l:"This Week"},{k:"month",l:"This Month"},{k:"all",l:"All Time"},{k:"custom",l:"Custom"}];
  const periodLabel = PERIODS.find(p=>p.k===period)?.l || period;

  const doPrint = () => {
    const prodRows = topProds.map(([name,d],i)=>`<tr><td>#${i+1} ${name}</td><td class="right">${d.qty}</td><td class="right bold">${fmt(d.rev)}</td></tr>`).join("");
    const cashRows = Object.entries(cashierSales).map(([n,d])=>`<tr><td>${n}</td><td class="right">${d.n}</td><td class="right bold">${fmt(d.rev)}</td></tr>`).join("");
    const ordRows  = orders.slice(0,100).map(o=>`<tr><td style="font-family:monospace;font-size:11px">${o.id}</td><td>${o.date}</td><td>${o.cashier}</td><td>${o.payMethod?.toUpperCase()}</td><td class="right bold">${fmt(o.total)}</td></tr>`).join("");
    printReport(`
      <h1>Sales Report — ${periodLabel}</h1>
      <p class="meta">Store: ${store?.store_name} &nbsp;|&nbsp; Generated: ${new Date().toLocaleString("en-PH")} &nbsp;|&nbsp; ${orders.length} orders</p>
      <div class="summary">
        <div class="card"><div class="card-label">Total Sales</div><div class="card-val">${fmt(total)}</div></div>
        <div class="card"><div class="card-label">Orders</div><div class="card-val">${orders.length}</div></div>
        <div class="card"><div class="card-label">Average Order</div><div class="card-val">${fmt(avg)}</div></div>
      </div>
      ${topProds.length?`<h2>Top Products</h2><table><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Revenue</th></tr></thead><tbody>${prodRows}</tbody></table>`:""}
      ${Object.keys(cashierSales).length?`<h2>By Cashier</h2><table><thead><tr><th>Cashier</th><th class="right">Orders</th><th class="right">Revenue</th></tr></thead><tbody>${cashRows}</tbody></table>`:""}
      <h2>Orders ${orders.length>100?"(first 100)":""}</h2>
      <table><thead><tr><th>Order ID</th><th>Date/Time</th><th>Cashier</th><th>Payment</th><th class="right">Total</th></tr></thead><tbody>${ordRows}</tbody></table>
    `, `Sales Report — ${store?.store_name}`);
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div style={{fontWeight:800,fontSize:18}}>Sales Reports</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {PERIODS.map(p=>(
              <button key={p.k} onClick={()=>setPeriod(p.k)} style={{padding:"5px 12px",borderRadius:7,border:"1px solid",cursor:"pointer",fontSize:12,fontWeight:700,borderColor:period===p.k?"#4f46e5":"#e5e7eb",background:period===p.k?"#4f46e5":"#fff",color:period===p.k?"#fff":"#6b7280"}}>{p.l}</button>
            ))}
          </div>
          <button onClick={doPrint} style={{padding:"6px 14px",background:"#374151",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
            <i className="ti ti-printer" style={{fontSize:15}}/> Print
          </button>
        </div>
      </div>

      {period==="custom"&&(
        <div style={{background:"#fff",borderRadius:12,padding:"12px 16px",marginBottom:16,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}><label style={{...LBL,margin:0}}>From</label><input type="date" value={dateFrom} onChange={e=>setFrom(e.target.value)} style={{...INP,width:"auto",padding:"6px 10px"}}/></div>
          <div style={{display:"flex",alignItems:"center",gap:8}}><label style={{...LBL,margin:0}}>To</label><input type="date" value={dateTo} onChange={e=>setTo(e.target.value)} style={{...INP,width:"auto",padding:"6px 10px"}}/></div>
          <button onClick={()=>{setFrom("");setTo("");}} style={{padding:"6px 10px",border:"1px solid #e5e7eb",borderRadius:6,cursor:"pointer",fontSize:12,background:"#f9fafb",color:"#6b7280"}}>Clear</button>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12,marginBottom:20}}>
        {[{l:"Total Sales",v:fmt(total),c:"#4f46e5"},{l:"Orders",v:orders.length,c:"#0891b2"},{l:"Average Order",v:fmt(avg),c:"#059669"}].map(m=>(
          <div key={m.l} style={{background:"#fff",borderRadius:12,padding:16,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
            <div style={{fontSize:11,color:"#9ca3af",marginBottom:6}}>{m.l}</div>
            <div style={{fontSize:22,fontWeight:800,color:m.c}}>{m.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16}}>
        <div style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>Top Products</div>
          {topProds.length===0&&<div style={{fontSize:13,color:"#9ca3af",textAlign:"center",padding:"16px 0"}}>No data for this period</div>}
          {topProds.map(([name,d],i)=>(
            <div key={name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid #f3f4f6"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:11,fontWeight:800,color:"#d1d5db",minWidth:20}}>#{i+1}</span>
                <div><div style={{fontSize:13,fontWeight:700}}>{name}</div><div style={{fontSize:11,color:"#9ca3af"}}>{d.qty} sold</div></div>
              </div>
              <span style={{fontWeight:800,fontSize:13,color:"#4f46e5"}}>{fmt(d.rev)}</span>
            </div>
          ))}
        </div>
        <div style={{background:"#fff",borderRadius:14,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>By Cashier</div>
          {Object.keys(cashierSales).length===0&&<div style={{fontSize:13,color:"#9ca3af",textAlign:"center",padding:"16px 0"}}>No data for this period</div>}
          {Object.entries(cashierSales).sort((a,b)=>b[1].rev-a[1].rev).map(([name,d])=>(
            <div key={name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",background:"#f9fafb",borderRadius:8,marginBottom:6}}>
              <div><div style={{fontSize:13,fontWeight:700}}>{name}</div><div style={{fontSize:11,color:"#9ca3af"}}>{d.n} orders</div></div>
              <span style={{fontWeight:800,fontSize:13,color:"#4f46e5"}}>{fmt(d.rev)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// INVENTORY VIEW
// ════════════════════════════════════════════════════════
function Inventory({ store, data, session, onRefresh }) {
  const products   = data?.products || [];
  const categories = data?.categories || [];
  const [search, setSearch]     = useState("");
  const [catFilter, setCat]     = useState("All");
  const [editModal, setEditModal] = useState(null);
  const [editForm, setEditForm]   = useState({});
  const [saving, setSaving]       = useState(false);

  const filtered = products.filter(p =>
    (catFilter==="All"||p.category===catFilter) &&
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  const saveProduct = async () => {
    setSaving(true);
    const updated = products.map(p => p.id===editForm.id ? {...editForm, price:parseFloat(editForm.price), stock:parseInt(editForm.stock)||0} : p);
    await supa.update("store_data", { store_id: session.storeId }, { products: updated, updated_at: new Date().toISOString() });
    setSaving(false); setEditModal(null); onRefresh();
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div style={{fontWeight:800,fontSize:18}}>Inventory</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search products…" style={{...INP,width:200,padding:"7px 12px"}}/>
        </div>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
        {["All",...categories].map(c=>(
          <button key={c} onClick={()=>setCat(c)} style={{padding:"4px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:700,borderColor:catFilter===c?"#4f46e5":"#e5e7eb",background:catFilter===c?"#4f46e5":"#fff",color:catFilter===c?"#fff":"#6b7280"}}>{c}</button>
        ))}
      </div>
      <div style={{background:"#fff",borderRadius:14,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{background:"#f9fafb"}}>{["Product","Category","Price","Stock","SKU","Status",""].map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",fontWeight:700,fontSize:11,color:"#6b7280",borderBottom:"1px solid #e5e7eb"}}>{h}</th>)}</tr></thead>
          <tbody>
            {filtered.map(p=>(
              <tr key={p.id} style={{borderBottom:"1px solid #f3f4f6",opacity:p.active?1:0.5}}>
                <td style={{padding:"10px 14px",fontWeight:700}}>{p.name}</td>
                <td style={{padding:"10px 14px",color:"#6b7280"}}>{p.category}</td>
                <td style={{padding:"10px 14px",fontWeight:800,color:"#4f46e5"}}>{fmt(p.price)}</td>
                <td style={{padding:"10px 14px"}}><span style={{fontWeight:800,color:p.stock<=0?"#ef4444":p.stock<=5?"#f59e0b":"#111"}}>{p.stock}</span></td>
                <td style={{padding:"10px 14px",fontFamily:"monospace",fontSize:11,color:"#9ca3af"}}>{p.sku||"—"}</td>
                <td style={{padding:"10px 14px"}}><span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:p.active?"#f0fdf4":"#fef2f2",color:p.active?"#166534":"#991b1b"}}>{p.active?"Active":"Hidden"}</span></td>
                <td style={{padding:"10px 14px"}}><button onClick={()=>{setEditForm({...p});setEditModal(true);}} style={{background:"none",border:"1px solid #e5e7eb",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12,color:"#6b7280"}}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:16}} onClick={e=>e.target===e.currentTarget&&setEditModal(null)}>
          <div style={{background:"#fff",borderRadius:14,padding:24,width:"100%",maxWidth:380}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:16}}>Edit Product</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div><label style={LBL}>Name</label><input value={editForm.name} onChange={e=>setEditForm(f=>({...f,name:e.target.value}))} style={INP}/></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div><label style={LBL}>Price (₱)</label><input type="number" value={editForm.price} onChange={e=>setEditForm(f=>({...f,price:e.target.value}))} style={INP}/></div>
                <div><label style={LBL}>Stock</label><input type="number" value={editForm.stock} onChange={e=>setEditForm(f=>({...f,stock:e.target.value}))} style={INP}/></div>
              </div>
              <div><label style={LBL}>Status</label>
                <select value={editForm.active?"active":"hidden"} onChange={e=>setEditForm(f=>({...f,active:e.target.value==="active"}))} style={INP}>
                  <option value="active">Active</option><option value="hidden">Hidden</option>
                </select>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>setEditModal(null)} style={{flex:1,padding:"10px 0",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,background:"#fff"}}>Cancel</button>
              <button onClick={saveProduct} disabled={saving} style={{flex:2,padding:"10px 0",background:"#4f46e5",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:800}}>{saving?"Saving…":"Save Changes"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// SETTINGS VIEW
// ════════════════════════════════════════════════════════
function Settings({ store, data, session, onRefresh }) {
  const theme = data?.theme || {};
  const [form, setForm]     = useState({ storeName: store?.store_name||"", primary: theme.primary||"#4f46e5", bgColor: theme.bgColor||"#f0f0f8", sidebar: theme.sidebar||"#1a1a2e" });
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  const save = async () => {
    setSaving(true);
    const newTheme = { ...theme, storeName: form.storeName, primary: form.primary, bgColor: form.bgColor, sidebar: form.sidebar };
    await supa.update("store_data", { store_id: session.storeId }, { theme: newTheme, updated_at: new Date().toISOString() });
    await supa.update("stores",     { id: session.storeId },       { store_name: form.storeName });
    setSaving(false); setSaved(true); setTimeout(()=>setSaved(false), 2000); onRefresh();
  };

  return (
    <div style={{maxWidth:560}}>
      <div style={{fontWeight:800,fontSize:18,marginBottom:20}}>Store Settings</div>
      <div style={{background:"#fff",borderRadius:14,padding:24,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",marginBottom:16}}>
        <div style={{fontWeight:800,fontSize:14,marginBottom:16}}>Branding</div>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div><label style={LBL}>Store Name</label><input value={form.storeName} onChange={e=>setForm(f=>({...f,storeName:e.target.value}))} style={INP}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
            {[{k:"primary",l:"Primary Color"},{k:"bgColor",l:"Background"},{k:"sidebar",l:"Sidebar"}].map(({k,l})=>(
              <div key={k}>
                <label style={LBL}>{l}</label>
                <div style={{display:"flex",alignItems:"center",gap:8,marginTop:5}}>
                  <input type="color" value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} style={{width:36,height:36,border:"none",borderRadius:6,cursor:"pointer",padding:2}}/>
                  <span style={{fontSize:11,fontFamily:"monospace",color:"#6b7280"}}>{form[k]}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <button onClick={save} disabled={saving} style={{marginTop:20,padding:"11px 24px",background:saving?"#a5b4fc":"#4f46e5",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:8}}>
          {saving?<><i className="ti ti-loader-2"/>Saving…</>:saved?<><i className="ti ti-check"/>Saved!</>:<><i className="ti ti-device-floppy"/>Save Settings</>}
        </button>
      </div>
      <div style={{background:"#fff",borderRadius:14,padding:24,boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
        <div style={{fontWeight:800,fontSize:14,marginBottom:10}}>Store Info</div>
        {[{l:"Store Name",v:store?.store_name},{l:"Owner Name",v:store?.owner_name},{l:"Owner Email",v:store?.owner_email},{l:"Plan",v:store?.plan},{l:"Member Since",v:store?.created_at?new Date(store.created_at).toLocaleDateString("en-PH"):"—"}].map(r=>(
          <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #f3f4f6",fontSize:13}}>
            <span style={{color:"#6b7280"}}>{r.l}</span><span style={{fontWeight:700}}>{r.v||"—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
