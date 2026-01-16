const $ = (id) => document.getElementById(id);

const screenAuth = $("screenAuth");
const screenWeeks = $("screenWeeks");
const screenWeekDetail = $("screenWeekDetail");

const authMsg = $("authMsg");
const weekMsg = $("weekMsg");
const entryMsg = $("entryMsg");

let currentUser = null;
let currentWeek = null;

// ---------- Remember Me (store only names, NEVER password) ----------
const LS_REM = {
  enabled: "wh_remember_enabled",
  fn: "wh_remember_fn",
  ln: "wh_remember_ln"
};

function loadRemember(){
  const cb = $("rememberMe");
  if(!cb) return;

  const enabled = localStorage.getItem(LS_REM.enabled) === "1";
  cb.checked = enabled;

  if(enabled){
    const fn = localStorage.getItem(LS_REM.fn) || "";
    const ln = localStorage.getItem(LS_REM.ln) || "";
    if($("fn")) $("fn").value = fn;
    if($("ln")) $("ln").value = ln;
  }
}

function saveRemember(enabled){
  const cb = $("rememberMe");
  if(!cb) return;

  if(enabled){
    localStorage.setItem(LS_REM.enabled, "1");
    localStorage.setItem(LS_REM.fn, ($("fn")?.value || "").trim());
    localStorage.setItem(LS_REM.ln, ($("ln")?.value || "").trim());
  }else{
    localStorage.setItem(LS_REM.enabled, "0");
    localStorage.removeItem(LS_REM.fn);
    localStorage.removeItem(LS_REM.ln);
  }
}

// ---------- LOGO (guaranteed, but safe if element missing) ----------
(function loadLogo(){
  const img = $("appLogo");
  if(!img) return;

  const candidates = ["/static/logo.png", "/static/tesco.png"];
  let idx = 0;

  function tryNext(){
    if(idx >= candidates.length){
      img.style.display = "none";
      return;
    }
    img.src = candidates[idx++];
  }
  img.onerror = tryNext;
  tryNext();
})();

// ---------- API ----------
async function api(path, options={}){
  const res = await fetch(path, {
    headers: { "Content-Type":"application/json" },
    credentials: "include",
    ...options
  });

  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json")
    ? await res.json().catch(()=>null)
    : await res.text().catch(()=>null);

  if(!res.ok){
    if(res.status === 401){
      throw new Error("Password incorreto seu Burro :)");
    }
    const msg = (data && data.detail) ? data.detail : (typeof data === "string" ? data : `Error ${res.status}`);
    throw new Error(msg);
  }
  return data;
}

function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }

function setMsg(el, text, ok=false){
  if(!el) return;
  el.style.color = ok ? "#15803d" : "#b91c1c";
  el.textContent = text || "";
}

function money(x){
  return "€" + Number(x || 0).toFixed(2);
}

async function boot(){
  try{
    currentUser = await api("/api/me");
    $("btnLogout")?.classList.remove("hidden");
    await openWeeks();
  }catch(_){
    $("btnLogout")?.classList.add("hidden");
    openAuth();
  }
}

function openAuth(){
  currentWeek = null;
  show(screenAuth); hide(screenWeeks); hide(screenWeekDetail);
  setMsg(authMsg, "");
  loadRemember();
}

async function openWeeks(){
  hide(screenAuth); show(screenWeeks); hide(screenWeekDetail);
  hide($("newWeekBox"));
  setMsg(weekMsg, "");
  await refreshWeeks();
}

async function openWeekDetail(weekId){
  hide(screenAuth); hide(screenWeeks); show(screenWeekDetail);
  hide($("bhBox"));
  await loadWeek(weekId);
}

// ---------- AUTH actions ----------
$("btnSignIn").onclick = async () => {
  try{
    setMsg(authMsg, "");

    const remember = $("rememberMe") ? $("rememberMe").checked : false;

    await api("/api/login", {
      method:"POST",
      body: JSON.stringify({
        first_name: $("fn").value.trim(),
        last_name: $("ln").value.trim(),
        password: $("pw").value,
        remember
      })
    });

    saveRemember(remember);

    $("btnLogout").classList.remove("hidden");
    await openWeeks();
  }catch(e){
    setMsg(authMsg, e.message);
  }
};

$("btnSignUp").onclick = async () => {
  try{
    setMsg(authMsg, "");
    await api("/api/signup", {
      method:"POST",
      body: JSON.stringify({
        first_name: $("fn").value.trim(),
        last_name: $("ln").value.trim(),
        password: $("pw").value
      })
    });
    $("btnLogout").classList.remove("hidden");
    await openWeeks();
  }catch(e){
    setMsg(authMsg, e.message);
  }
};

$("btnForgot").onclick = async () => {
  try{
    const np = prompt("New password:");
    if(!np) return;
    await api("/api/forgot", {
      method:"POST",
      body: JSON.stringify({
        first_name: $("fn").value.trim(),
        last_name: $("ln").value.trim(),
        new_password: np
      })
    });
    setMsg(authMsg, "Password updated. Now sign in.", true);
  }catch(e){
    setMsg(authMsg, e.message);
  }
};

$("btnLogout").onclick = async () => {
  await api("/api/logout", { method:"POST" }).catch(()=>{});
  $("btnLogout").classList.add("hidden");
  openAuth();
};

// ---------- WEEKS ----------
$("btnNewWeek").onclick = () => {
  show($("newWeekBox"));
  setMsg(weekMsg, "");
};

$("btnCancelWeek").onclick = () => {
  hide($("newWeekBox"));
};

$("btnCreateWeek").onclick = async () => {
  try{
    setMsg(weekMsg, "");
    const week_number = Number($("newWeekNumber").value);
    const start_date = $("newStartDate").value;
    const hourly_rate = Number($("newRate").value);

    if(!week_number || !start_date || isNaN(hourly_rate)){
      throw new Error("Fill week number, start date and hourly rate.");
    }

    await api("/api/weeks", {
      method:"POST",
      body: JSON.stringify({ week_number, start_date, hourly_rate })
    });

    $("newWeekNumber").value = "";
    $("newRate").value = "";
    hide($("newWeekBox"));
    await refreshWeeks();
    setMsg(weekMsg, "Week created.", true);
  }catch(e){
    setMsg(weekMsg, e.message);
  }
};

async function refreshWeeks(){
  const list = $("weeksList");
  list.innerHTML = "";
  const weeks = await api("/api/weeks");

  if(!weeks.length){
    list.innerHTML = `<div class="muted">No weeks yet. Create one.</div>`;
    return;
  }

  for(const w of weeks){
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div>
        <div class="item-title">Week ${w.week_number}</div>
        <div class="item-sub">Start: ${w.start_date} • Rate: ${money(w.hourly_rate)}</div>
      </div>
      <div style="text-align:right">
        <div class="item-title">${w.total_hhmm}</div>
        <div class="item-sub">${money(w.total_pay)}</div>
      </div>
    `;
    div.onclick = () => openWeekDetail(w.id);
    list.appendChild(div);
  }
}

// ---------- WEEK DETAIL ----------
$("btnBack").onclick = () => openWeeks();

$("btnReport").onclick = () => {
  if(!currentWeek) return;
  window.open(`/report?week_id=${encodeURIComponent(currentWeek.id)}`, "_blank");
};

$("btnDeleteWeek").onclick = async () => {
  if(!currentWeek) return;
  if(!confirm("Delete this week (all days)?")) return;
  await api(`/api/weeks/${currentWeek.id}`, { method:"DELETE" });
  currentWeek = null;
  await openWeeks();
};

$("btnSaveRate").onclick = async () => {
  try{
    if(!currentWeek) return;
    const hourly_rate = Number($("rateEdit").value);
    await api(`/api/weeks/${currentWeek.id}`, {
      method:"PATCH",
      body: JSON.stringify({ hourly_rate })
    });
    await loadWeek(currentWeek.id);
  }catch(e){
    alert(e.message);
  }
};

$("btnSaveDay").onclick = async () => {
  try{
    if(!currentWeek) return;

    const bhPaidVal = $("bhPaid").value;
    const bh_paid = bhPaidVal === "" ? null : (bhPaidVal === "true");

    await api(`/api/weeks/${currentWeek.id}/entry`, {
      method:"PUT",
      body: JSON.stringify({
        work_date: $("workDate").value,
        time_in: $("timeIn").value || null,
        time_out: $("timeOut").value || null,
        break_minutes: Number($("breakMin").value || 0),
        note: $("note").value || null,
        bh_paid
      })
    });

    setMsg(entryMsg, "Saved.", true);
    $("timeIn").value = "";
    $("timeOut").value = "";
    $("breakMin").value = "0";
    $("note").value = "";
    $("bhPaid").value = "";

    await loadWeek(currentWeek.id);
  }catch(e){
    setMsg(entryMsg, e.message);
  }
};

async function loadWeek(weekId){
  const w = await api(`/api/weeks/${weekId}`);
  currentWeek = w;

  $("weekTitle").textContent = `Week ${w.week_number}`;
  $("weekMeta").textContent = `Start: ${w.start_date} • Sunday/Bank Holiday = 1.5x`;
  $("weekTotals").textContent = `Total ${w.totals.total_hhmm} • ${money(w.totals.total_pay)}`;
  $("rateEdit").value = w.hourly_rate;

  renderEntries(w.entries);
  setMsg(entryMsg, "");
}

function renderEntries(entries){
  const tb = $("entriesBody");
  tb.innerHTML = "";

  if(!entries.length){
    tb.innerHTML = `<tr><td colspan="9" class="muted">No days yet.</td></tr>`;
    return;
  }

  for(const e of entries){
    const tr = document.createElement("tr");
    const is15 = (e.multiplier === 1.5);
    tr.innerHTML = `
      <td><b>${e.weekday}</b></td>
      <td>${e.date_ddmmyyyy}</td>
      <td>${e.time_in || ""}</td>
      <td>${e.time_out || ""}</td>
      <td>${e.break_minutes}m</td>
      <td><b>${e.worked_hhmm}</b></td>
      <td>${is15 ? "YES" : ""}</td>
      <td>${e.note || ""}</td>
      <td><button class="btn danger" style="padding:8px 10px;border-radius:10px" data-id="${e.id}">X</button></td>
    `;
    tr.querySelector("button").onclick = async () => {
      if(!confirm("Delete this day?")) return;
      await api(`/api/entries/${e.id}`, { method:"DELETE" });
      await loadWeek(currentWeek.id);
    };
    tb.appendChild(tr);
  }
}

// ---------- Bank Holidays ----------
$("btnOpenBH").onclick = async () => {
  $("bhYear").value = String(new Date().getFullYear());
  show($("bhBox"));
  await loadBH();
};

$("btnCloseBH").onclick = () => hide($("bhBox"));

$("btnLoadBH").onclick = async () => loadBH();

async function loadBH(){
  const year = Number($("bhYear").value);
  const list = $("bhList");
  list.innerHTML = "";

  const items = await api(`/api/bank-holidays/${year}`);
  for(const bh of items){
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div>
        <div class="item-title">${bh.name}</div>
        <div class="item-sub">${bh.weekday} • ${bh.date_ddmmyyyy}</div>
      </div>
      <div style="text-align:right">
        <div class="item-sub">Paid:</div>
        <select data-id="${bh.id}">
          <option value="true" ${bh.paid ? "selected":""}>Yes</option>
          <option value="false" ${!bh.paid ? "selected":""}>No</option>
        </select>
      </div>
    `;
    const sel = div.querySelector("select");
    sel.onchange = async () => {
      const paid = sel.value === "true";
      await api(`/api/bank-holidays/${bh.id}`, {
        method:"PATCH",
        body: JSON.stringify({ paid })
      });
    };
    list.appendChild(div);
  }
}

// ---------- PWA ----------
if("serviceWorker" in navigator){
  navigator.serviceWorker.register("/static/sw.js").catch(()=>{});
}

// ---------- INTRO VIDEO (SÓ ESSE BLOCO) ----------
(function introVideo(){
  const introEl = document.getElementById("introContainer");
  const videoEl = document.getElementById("introVideo");

  function hideIntro(){
    if(introEl) introEl.style.display = "none";
  }

  if(introEl && videoEl){
    videoEl.addEventListener("ended", hideIntro);
    videoEl.addEventListener("error", hideIntro);

    // segurança: se autoplay falhar, some em 4s
    setTimeout(hideIntro, 4000);
  }
})();

// start
boot();
