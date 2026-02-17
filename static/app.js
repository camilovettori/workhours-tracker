/* =========================
   Work Hours Tracker - app.js (v17)
   FIX PACK:
   - refreshCurrentWeekTotals global (works with type="module")
   - fmtEUR added
   - Remove CURRENT_WEEK_ID bug (use DASH_WEEK_ID)
   - One secondsToHHMMSS() only
   - Today earnings shows HH:MM:SS
   - Current week totals use /api/report/week/current
========================= */

console.log("app.js loaded ✅ v17");

/* =========================
   Small DOM helpers
========================= */
const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");
function go(path) { window.location.href = path; }
function pathIs(p) { return window.location.pathname === p; }
// ===== ME cache =====
// ===== ME cache (declare ONCE) =====
const LS_ME = "wh_me";
let ME = null;


function readCachedMe(){
  try { return JSON.parse(localStorage.getItem(LS_ME) || "null"); }
  catch { return null; }
}

async function refreshMe(force = false) {
  if (!force) {
    const cached = readCachedMe();
    if (cached && cached.ok) {
      ME = cached;
      if (typeof applyMeToUI === "function") applyMeToUI(ME);
    }
  }

  const me = await api("/api/me");
  ME = me;

  // cache
  try { localStorage.setItem(LS_ME, JSON.stringify(me)); } catch {}

  // aplica na UI se existir
  if (typeof applyMeToUI === "function") applyMeToUI(ME);

  // mostra/esconde botão Admin se existir na página
  const adminBtn = document.getElementById("openAdmin");
  if (adminBtn) {
    const isAdmin = Number(ME?.is_admin || 0) === 1;
    adminBtn.classList.toggle("hidden", !isAdmin);
    adminBtn.onclick = () => (window.location.href = "/admin");
  }

  return ME;
}

// garante global (se algum HTML chama refreshMe direto)
window.refreshMe = refreshMe;



async function initAdminPage() {
  const btnBack = document.getElementById("btnAdminBack");
  const btnHome = document.getElementById("btnAdminHome");
  const btnReload = document.getElementById("btnAdminReload");

  if (btnBack) btnBack.onclick = () => history.back();
  if (btnHome) btnHome.onclick = () => (window.location.href = "/");
  if (btnReload) btnReload.onclick = () => loadAdminUsers();

  await loadAdminUsers();
}

async function loadAdminUsers(){
  const msg  = document.getElementById("adminMsg");
  const list = document.getElementById("adminUsersList");
  if (msg) msg.textContent = "";
  if (list) list.innerHTML = "";

  try{
    const res = await api("/api/admin/users");
    const users = res?.users || [];

    if (!users.length){
      if (list) list.innerHTML = `<div class="muted">No users found.</div>`;
      return;
    }

    if (list){
      list.innerHTML = users.map(u => {
        const name = `${(u.first_name||"").trim()} ${(u.last_name||"").trim()}`.trim() || "—";
        const badge = u.is_admin ? `<span class="todayPill" style="margin-left:0;">ADMIN</span>` : "";
        return `
          <div class="rpRow">
            <div class="left">
              <div class="d1">${name} ${badge}</div>
              <div class="d2">${u.email}</div>
            </div>
            <div class="right">#${u.id}</div>
          </div>
        `;
      }).join("");
    }
  }catch(e){
    if (msg) msg.textContent = e?.message || "Failed to load users";
  }
}





/* =========================
   Format helpers
========================= */
function fmtEUR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "€0.00";
  return `€${n.toFixed(2)}`;
}

function fmtHHMMFromMinutes(mins){
  const m = Math.max(0, Math.floor(Number(mins || 0)));
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function ymdTodayLocal(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function ymdToDateLocal(ymd){
  // "2026-02-15" -> Date local (00:00 local)
  const [y,m,d] = ymd.split("-").map(Number);
  return new Date(y, m-1, d);
}

function inWeekRange(todayYmd, weekStartYmd){
  const t = ymdToDateLocal(todayYmd);
  const s = ymdToDateLocal(weekStartYmd);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  return t >= s && t <= e;
}
function ymd(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function sundayOfThisWeek(d=new Date()){
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay()); // Sunday
  return ymd(x);
}


function secondsToHHMMSS(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec || 0)));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtMMSS(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec || 0)));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

/* =========================
   API helper
========================= */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
    credentials: "include",
  });

  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    const msg =
      (data && data.detail) ? data.detail :
      (typeof data === "string" ? data : "Request failed");
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtHHMM(t) {
  // aceita "09:45", "09:45:00"
  if (!t) return "";
  return String(t).slice(0, 5);
}

/* =========================
   Date helpers
========================= */

function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtHHMM(t) {
  if (!t) return "";
  return String(t).slice(0, 5); // "09:45:00" -> "09:45"
}

function todayYMD() {
  const t = new Date();
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function ymdFromDate(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function ymdToDateObj(ymd) {
  const [y, m, d] = String(ymd || "").split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}
function isSunday(dt) { return dt.getDay() === 0; }

function isoWeekNumber(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}
function mondayOfThisWeek(d = new Date()) {
  const x = new Date(d);
  const day = x.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day; // back to Monday
  x.setDate(x.getDate() + diff);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function weekStartMondayISO(d = new Date()) { return mondayOfThisWeek(d); }

/* ===== roster date helpers ===== */
function ymdAddDays(ymd, add) {
  if (!ymd) return "";
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(y || 1970, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + Number(add || 0));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function applyTodayHighlight() {
  const today = ymdTodayLocal();
  const cards = document.querySelectorAll("[data-day-date]");

  // debug rápido: se der 0, teu HTML não tem data-day-date
  // console.log("applyTodayHighlight cards:", cards.length, "today:", today);

  cards.forEach(card => {
    const d = card.getAttribute("data-day-date");
    const isToday = (d === today);

    card.classList.toggle("is-today", isToday);

    // Cria/Remove pill "Today" sem depender de .day-title
    let pill = card.querySelector(".today-pill");
    if (isToday) {
      if (!pill) {
        pill = document.createElement("span");
        pill.className = "today-pill";
        pill.textContent = "Today";

        // tenta colocar no topo do card
        // prioridade: header -> h4/h3/strong -> primeiro elemento
        const header =
          card.querySelector(".day-title") ||
          card.querySelector(".day-header") ||
          card.querySelector("h4, h3, strong") ||
          card.firstElementChild;

        if (header) {
          header.appendChild(pill);
        } else {
          card.prepend(pill);
        }
      }
    } else {
      if (pill) pill.remove();
    }
  });
}



function weekdayShort(dt) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
}

/* =========================
   FIX: ME + Avatar (single source of truth)
========================= */

const LS_AVATAR = "wh_avatar_url";

function cacheBust(url) {
  if (!url) return "";
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${Date.now()}`;
}

function applyMeToUI(me) {
  if (!me) return;

  // Name
  const nameEl = $("welcomeName");
  if (nameEl) {
    const fn = (me.first_name || "").trim();
    const ln = (me.last_name || "").trim();
    nameEl.textContent = (fn + " " + ln).trim() || "User";
  }

  // Avatar URL priority: explicit saved -> me.avatar_url
  const rawUrl = (localStorage.getItem(LS_AVATAR) || me.avatar_url || "").trim();
  const finalUrl = rawUrl ? cacheBust(rawUrl) : "";

  const avatarIds = [
    "topAvatarImg",
    "dashAvatar",
    "dashAvatarImg",
    "dashboardAvatar",
    "avatarImg",
    "profileAvatar",
    "profileAvatarImg",
  ];

  avatarIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;

    if (el.tagName && el.tagName.toLowerCase() === "img") {
      if (finalUrl) {
        el.src = finalUrl;
        el.style.display = "";
      } else {
        el.src = "/static/logo.png";
      }
    }
  });

  // Bind profile click once (if your header uses button)
  const btn = $("btnProfileAvatar");
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => go("/profile"));
  }
}
function initProfileAdminButton(){
  const btn = document.getElementById("openAdmin");
  if (!btn) return;

  const isAdmin = !!(ME && Number(ME.is_admin || 0) === 1);

  btn.classList.toggle("hidden", !isAdmin);

  if (isAdmin){
    btn.onclick = () => (window.location.href = "/admin");
  }
}



function readCachedMe() {
  try {
    const raw = localStorage.getItem(LS_ME);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const adminBtn = document.getElementById("openAdmin");
if (adminBtn) {
  const isAdmin = Number(me?.is_admin || 0) === 1;
  adminBtn.classList.toggle("hidden", !isAdmin);
  adminBtn.onclick = () => (location.href = "/admin");
}

function applyAdminUI(){
  const b = document.getElementById("btnAdminPanel");
  if (!b) return;

  const isAdmin = !!(ME && Number(ME.is_admin || 0) === 1);

  if (isAdmin) b.classList.remove("hidden");
  else b.classList.add("hidden");

  b.onclick = () => (window.location.href = "/admin");
}

/* =========================
   Bank Holiday lookup (cached)
========================= */
const bhCache = new Map();
async function bhLookup(dateYmd) {
  if (!dateYmd) return null;
  if (bhCache.has(dateYmd)) return bhCache.get(dateYmd);
  const r = await api(`/api/bank-holidays/lookup?date_ymd=${encodeURIComponent(dateYmd)}`);
  bhCache.set(dateYmd, r);
  return r;
}
function isBhTrue(bh) {
  if (!bh) return false;
  return bh.is_bh === true || bh.is_bank_holiday === true || bh.isBH === true;
}

/* =========================
   Rate storage + auto-week
========================= */
function getSavedRate() {
  const v = Number(localStorage.getItem("hourly_rate") || 0);
  return v > 0 ? v : 18.24;
}
function saveRate(rate) {
  const v = Number(rate || 0);
  if (v > 0) localStorage.setItem("hourly_rate", String(v));
}

async function ensureWeekExistsForClock() {
  const c = await api("/api/clock/today");
  if (c?.has_week) return c;

  const payload = {
    week_number: isoWeekNumber(new Date()),
    start_date: weekStartMondayISO(new Date()),
    hourly_rate: getSavedRate(),
  };

  await api("/api/weeks", { method: "POST", body: JSON.stringify(payload) });
  return await api("/api/clock/today");
}

/* =========================
   Premium rules (Sunday/BH)
========================= */
window.SUN_MULTIPLIER = window.SUN_MULTIPLIER ?? 1.5;
window.BH_MULTIPLIER  = window.BH_MULTIPLIER  ?? 1.5;
window.TODAY_MULT     = window.TODAY_MULT     ?? 1;

let _todayMultCache = { ymd: null, value: 1 };

async function refreshTodayMultiplier() {
  const SUN_MULT = Number(window.SUN_MULTIPLIER ?? 1.5);
  const BH_MULT  = Number(window.BH_MULTIPLIER  ?? 1.5);

  const now = new Date();
  const ymd = ymdFromDate(now);

  if (_todayMultCache.ymd === ymd) {
    window.TODAY_MULT = _todayMultCache.value || 1;
    return window.TODAY_MULT;
  }

  let mult = 1;
  if (isSunday(now)) mult = Math.max(mult, SUN_MULT);

  try {
    const bh = await bhLookup(ymd);
    if (isBhTrue(bh)) mult = Math.max(mult, BH_MULT);
  } catch {}

  _todayMultCache = { ymd, value: mult };
  window.TODAY_MULT = mult;
  return mult;
}

async function premiumMultiplierForYmd(ymd) {
  const SUN_MULT = Number(window.SUN_MULTIPLIER ?? 1.5);
  const BH_MULT  = Number(window.BH_MULTIPLIER  ?? 1.5);

  const dt = ymdToDateObj(ymd);
  let mult = 1;

  if (dt.getDay() === 0) mult = Math.max(mult, SUN_MULT);

  try {
    const bh = await bhLookup(ymd);
    if (isBhTrue(bh)) mult = Math.max(mult, BH_MULT);
  } catch {}

  return mult;
}

/* =========================
   Views (index.html only)
========================= */
const viewLogin   = $("viewLogin");
const viewHome    = $("viewHome");
const viewAddWeek = $("viewAddWeek");

function hasIndexViews() { return !!(viewLogin || viewHome || viewAddWeek); }
function hideAllViews() { hide(viewLogin); hide(viewHome); hide(viewAddWeek); }

/* =========================
   Login UI
========================= */
const loginForm     = $("loginForm");
const loginEmail    = $("loginEmail");
const loginPassword = $("loginPassword");
const loginRemember = $("loginRemember");
const loginMsg      = $("loginMsg");

const signupForm = $("signupForm");
const suFirst    = $("suFirst");
const suLast     = $("suLast");
const suEmail    = $("suEmail");
const suPassword = $("suPassword");
const signupMsg  = $("signupMsg");

const btnForgot     = $("btnForgot");
const forgotPanel   = $("forgotPanel");
const forgotEmail   = $("forgotEmail");
const btnSendReset  = $("btnSendReset");
const forgotMsg     = $("forgotMsg");

const btnShowSignup = $("btnShowSignup");
const btnShowLogin  = $("btnShowLogin");

/* =========================
   Home UI
========================= */
const btnLogout = $("btnLogout");
const btnOpenProfile = $("btnOpenProfile");
const btnAddWeek = $("btnAddWeek");

const cwWeekNo = $("cwWeekNo");
const cwHHMM = $("cwHHMM") || $("cwHours");
const cwPay  = $("cwPay")  || $("cwGross");


const btnIn    = $("btnIn");
const btnOut   = $("btnOut");
const btnBreak = $("btnBreak");

const cwIn = $("cwIn");
const cwOut = $("cwOut");
const cwBreak = $("cwBreak");
const cwStatusText = $("cwStatusText");

const bhPaid = $("bhPaid");
const bhRemain = $("bhRemain");

const cardHolidays = $("cardHolidays");
const cardReports  = $("cardReports");

const navHome    = $("navHome");
const navHistory = $("navHistory");
const navHolidays= $("navHolidays");
const navReports = $("navReports");
const navProfile = $("navProfile");

/* =========================
   Add Week UI (page)
========================= */
const btnBackAddWeek = $("btnBackAddWeek");
const addWeekForm = $("addWeekForm");
const awWeekNumber = $("awWeekNumber");
const awStartDate  = $("awStartDate");
const awHourlyRate = $("awHourlyRate");
const addWeekMsg = $("addWeekMsg");

/* =========================
   State
========================= */
let UI_DAY = todayYMD();

let TODAY_WEEK_ID = null;
let DASH_WEEK_ID  = null;

let CLOCK = null;
let LAST_DASH = null;


/* =========================
   Break countdown (UI) — FIXED
   - Resume does NOT overwrite endEpoch
   - resetTodayVisual will NOT kill an active break
========================= */
let breakTick = null;
let breakRemaining = 0;
let breakRunningUI = false;

const BREAK_DEFAULT_SEC = 60 * 60;
const LS_BREAK_END = "wh_break_end_epoch";
const LS_BREAK_DAY = "wh_break_day";
const LS_BREAK_WARN5 = "wh_break_warn5_sent";
const LS_BREAK_DONE  = "wh_break_done_sent";


function setBreakButtonRunning(running) {
  if (!btnBreak) return;
  btnBreak.innerHTML = running
    ? `<span class="pillIcon">⏱</span> BREAK (stop)`
    : `<span class="pillIcon">⏱</span> BREAK`;
}

function saveBreakEnd(endEpochMs) {
  localStorage.setItem(LS_BREAK_END, String(endEpochMs));
  localStorage.setItem(LS_BREAK_DAY, UI_DAY);
}

function clearBreakStorage() {
  localStorage.removeItem(LS_BREAK_END);
  localStorage.removeItem(LS_BREAK_DAY);
  localStorage.removeItem(LS_BREAK_WARN5);
  localStorage.removeItem(LS_BREAK_DONE);
}


function stopBreakCountdown(vibrate = false) {
  if (breakTick) clearInterval(breakTick);
  breakTick = null;
  breakRunningUI = false;
  breakRemaining = 0;

  clearBreakStorage();
  setBreakButtonRunning(false);

  if (cwBreak && CLOCK) cwBreak.textContent = `${Number(CLOCK.break_minutes || 0)}m`;
  if (vibrate && "vibrate" in navigator) navigator.vibrate([200, 100, 200]);
}

function tickBreakCountdown() {
  const endEpoch = Number(localStorage.getItem(LS_BREAK_END) || "0");
  if (!endEpoch) {
    stopBreakCountdown(false);
    return;
  }

  const leftSec = Math.ceil((endEpoch - Date.now()) / 1000);
  breakRemaining = leftSec;

  if (cwBreak) cwBreak.textContent = fmtMMSS(Math.max(0, leftSec));

  // ---- 5-minute warning (only once) ----
  if (leftSec <= 300 && leftSec > 0) {
    const warned = localStorage.getItem(LS_BREAK_WARN5) === "1";
    if (!warned) {
      localStorage.setItem(LS_BREAK_WARN5, "1");
      sendBreakNotification("⏳ 5 minutes left", "Your break is almost over.");
    }
  }

  // ---- finished (only once) ----
  if (leftSec <= 0) {
    const done = localStorage.getItem(LS_BREAK_DONE) === "1";
    if (!done) {
      localStorage.setItem(LS_BREAK_DONE, "1");
      sendBreakNotification("✅ Break finished", "Time to go back to work!");
    }

    stopBreakCountdown(true);
    api("/api/clock/break", { method: "POST" })
      .then(() => refreshAll())
      .catch(() => {});
  }
}


function startBreakCountdown(seconds = BREAK_DEFAULT_SEC) {
  breakRunningUI = true;

  const endEpoch = Date.now() + seconds * 1000;
  saveBreakEnd(endEpoch);

  setBreakButtonRunning(true);
  tickBreakCountdown();

  if (breakTick) clearInterval(breakTick);
  breakTick = setInterval(tickBreakCountdown, 250);
}

/** Resume break WITHOUT changing endEpoch */
function resumeBreakCountdownIfAny() {
  const savedDay = localStorage.getItem(LS_BREAK_DAY);
  const endEpoch = Number(localStorage.getItem(LS_BREAK_END) || "0");

  // if no saved break or wrong day, clear leftovers
  if (!savedDay || savedDay !== UI_DAY || !endEpoch) {
    clearBreakStorage();
    return;
  }

  const leftSec = Math.ceil((endEpoch - Date.now()) / 1000);

  if (leftSec > 0) {
    breakRunningUI = true;
    setBreakButtonRunning(true);
    tickBreakCountdown();

    if (breakTick) clearInterval(breakTick);
    breakTick = setInterval(tickBreakCountdown, 250);
  } else {
    clearBreakStorage();
  }
}

/** Reset UI, but DO NOT kill an active break */
function resetTodayVisual() {
  if (cwIn) cwIn.textContent = "00:00";
  if (cwOut) cwOut.textContent = "00:00";

  const endEpoch = Number(localStorage.getItem(LS_BREAK_END) || "0");
  const leftSec = endEpoch ? Math.ceil((endEpoch - Date.now()) / 1000) : 0;

  if (leftSec > 0) {
    // break active: keep it running
    setBreakButtonRunning(true);
    resumeBreakCountdownIfAny();
  } else {
    // no break active: safe to reset visuals
    if (cwBreak) cwBreak.textContent = "0m";
    setBreakButtonRunning(false);
    stopBreakCountdown(false);
  }
}

/* =========================
   Day change watcher
========================= */
function watchDayChange() {
  const now = todayYMD();
  if (now !== UI_DAY) {
    UI_DAY = now;
    resetTodayVisual();
    _todayMultCache = { ymd: null, value: 1 };
    refreshAll().catch(() => {});
  }
}
/*==================================
   Notification
   ============================*/

function sendBreakNotification(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  new Notification(title, {
    body,
    icon: "/static/logo.png",
    vibrate: [200, 100, 200]
  });
}


/* =========================
   Auth / routing (index only)
========================= */
function clearAuthMsgs() {
  if (loginMsg) loginMsg.textContent = "";
  if (signupMsg) signupMsg.textContent = "";
  if (forgotMsg) forgotMsg.textContent = "";
  if (forgotMsg) forgotMsg.style.color = "";
}
function showLogin() {
  show(loginForm);
  hide(signupForm);
  hide(forgotPanel);
  clearAuthMsgs();
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function showSignup() {
  hide(loginForm);
  show(signupForm);
  hide(forgotPanel);
  clearAuthMsgs();
}
function toggleForgot() {
  if (!forgotPanel) return;
  forgotPanel.classList.toggle("hidden");
  clearAuthMsgs();
  if (forgotEmail) forgotEmail.value = (loginEmail?.value || "").trim();
}

async function enterLogin() {
  if (!hasIndexViews()) return;
  hideAllViews();
  show(viewLogin);
  showLogin();
}

async function enterHome() {
  if (!hasIndexViews()) return;

  hideAllViews();
  show(viewHome);

  ME = await refreshMe(true);
initProfileAdminButton();
applyAdminUI(); // opcional, mas bom
await refreshAll();

}

/* =========================
   Login actions
========================= */
async function doLogin(ev) {
  ev.preventDefault();
  clearAuthMsgs();

  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: (loginEmail?.value || "").trim(),
        password: loginPassword?.value || "",
        remember: !!loginRemember?.checked,
      }),
    });

    ME = await refreshMe(true);
    await routeAfterAuth();
  } catch (e) {
    if (loginMsg) loginMsg.textContent = e.message || "Login failed";
  }
}

async function doSignup(ev) {
  ev.preventDefault();
  clearAuthMsgs();

  try {
    await api("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        first_name: (suFirst?.value || "").trim(),
        last_name: (suLast?.value || "").trim(),
        email: (suEmail?.value || "").trim(),
        password: suPassword?.value || "",
      }),
    });

    ME = await refreshMe(true);
    await routeAfterAuth();
  } catch (e) {
    if (signupMsg) signupMsg.textContent = e.message || "Sign up failed";
  }
}

async function doLogout() {
  try { await api("/api/logout", { method: "POST" }); } catch {}

  try { localStorage.removeItem(LS_ME); } catch {}
  try { localStorage.removeItem(LS_AVATAR); } catch {}

  ME = null;
  LAST_DASH = null;
  CLOCK = null;
  TODAY_WEEK_ID = null;
  DASH_WEEK_ID = null;

  stopLiveTicker();
  stopBreakCountdown(false);
  clearBreakStorage();

  window.location.href = "/";
}

async function sendReset() {
  clearAuthMsgs();

  const email = (forgotEmail?.value || "").trim();
  if (!email) {
    if (forgotMsg) forgotMsg.textContent = "Type your email.";
    return;
  }

  try {
    await api("/api/forgot", { method: "POST", body: JSON.stringify({ email }) });
    if (forgotMsg) {
      forgotMsg.style.color = "#0f172a";
      forgotMsg.textContent = "If the email exists, you’ll receive a reset link.";
    }
  } catch (e) {
    if (forgotMsg) forgotMsg.textContent = e.message || "Failed";
  }
}

function updateTodayEarningsUI() {
  const tHHMM  = $("todayEarnHHMM");
  const tPAY   = $("todayEarnPay");
  const tSTATE = $("todayEarnState");
  const tCard  = document.getElementById("todayEarnCard");

  // calcula LIVE primeiro (pra não depender do resto)
  const isLive =
    !!CLOCK?.has_week &&
    !!CLOCK?.in_time &&
    !CLOCK?.out_time &&
    !CLOCK?.break_running;

  // aplica/remove a classe SEMPRE, mesmo se faltar algum elemento
  if (tCard) tCard.classList.toggle("is-live", isLive);

  // se não tem os campos, não tem o que renderizar
  if (!tHHMM || !tPAY) return;

  // OFF (sem semana ou sem IN)
  if (!CLOCK?.has_week || !CLOCK?.in_time) {
    tHHMM.textContent = "--:--:--";
    tPAY.textContent  = "€-.--";
    if (tSTATE) tSTATE.textContent = "OFF";
    stopLiveTicker();
    return;
  }

  // rate
  const rate =
    Number(ME?.hourly_rate ?? 0) ||
    Number(LAST_DASH?.this_week?.hourly_rate ?? 0) ||
    Number(getSavedRate() ?? 0);

  if (!Number.isFinite(rate) || rate <= 0) {
    tHHMM.textContent = "--:--:--";
    tPAY.textContent  = "€-.--";
    if (tSTATE) tSTATE.textContent = "RATE?";
    stopLiveTicker();
    return;
  }

  // label do estado (e evita recalcular em break)
  if (CLOCK.break_running) {
    if (tSTATE) tSTATE.textContent = "BREAK";
    return;
  }

  if (CLOCK.out_time) {
    if (tSTATE) tSTATE.textContent = "DONE";
    stopLiveTicker();
  } else {
    if (tSTATE) tSTATE.textContent = "LIVE";
  }

  // calcula segundos trabalhados hoje
  const now = new Date();

  const [ih, im] = String(CLOCK.in_time).split(":").map(Number);
  const inDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ih || 0, im || 0, 0);

  let endDt = now;
  if (CLOCK.out_time) {
    const [oh, om] = String(CLOCK.out_time).split(":").map(Number);
    endDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), oh || 0, om || 0, 0);
  }

  let workedSec = Math.max(0, Math.floor((endDt - inDt) / 1000));

  const brMin = Number(CLOCK.break_minutes || 0);
  workedSec = Math.max(0, workedSec - brMin * 60);

  const eur = (workedSec / 3600) * rate * Number(window.TODAY_MULT || 1);

  tHHMM.textContent = secondsToHHMMSS(workedSec);
  tPAY.textContent  = fmtEUR(eur);
}

// =========================
// Live ticker (Today earnings) - GLOBAL
// =========================
let LIVE_TIMER = null;

function stopLiveTicker() {
  if (LIVE_TIMER) clearInterval(LIVE_TIMER);
  LIVE_TIMER = null;
}

function startLiveTicker() {
  if (LIVE_TIMER) return;

  LIVE_TIMER = setInterval(() => {
    const shouldLive =
      !!CLOCK?.has_week &&
      !!CLOCK?.in_time &&
      !CLOCK?.out_time &&
      !CLOCK?.break_running;

    if (!shouldLive) {
      stopLiveTicker();
      if (typeof updateTodayEarningsUI === "function") updateTodayEarningsUI();
      return;
    }

    if (typeof updateTodayEarningsUI === "function") updateTodayEarningsUI();
  }, 1000);
}

// expõe no global (pra qualquer lugar que chame)
window.startLiveTicker = startLiveTicker;
window.stopLiveTicker = stopLiveTicker;

/* =========================
   Clock refresh
========================= */
async function refreshClock() {
  try {
    const c = await api("/api/clock/today");
    CLOCK = c;

    TODAY_WEEK_ID = c?.has_week ? (c.week_id ?? null) : null;

    if (!c.has_week) {
      if (cwIn) cwIn.textContent = "--:--";
      if (cwOut) cwOut.textContent = "--:--";
      if (cwBreak) cwBreak.textContent = "0m";
      if (cwStatusText) cwStatusText.textContent = "Create a week first.";

      setBreakButtonRunning(false);
      stopLiveTicker();
      return;
    }

    if (cwIn) cwIn.textContent = c.in_time || "--:--";
    if (cwOut) cwOut.textContent = c.out_time || "--:--";
    if (cwBreak) cwBreak.textContent = `${Number(c.break_minutes || 0)}m`;

    setBreakButtonRunning(!!c.break_running);

    if (cwStatusText) {
      if (!c.in_time) cwStatusText.textContent = "Tap IN to start.";
      else if (c.break_running) cwStatusText.textContent = "Break running…";
      else if (!c.out_time) cwStatusText.textContent = "Tracking live…";
      else {
        // ✅ terminou hoje -> mostrar info de amanhã puxando do roster
        cwStatusText.textContent = "Done for today ✅"; // fallback rápido

        try {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const date_ymd = ymdLocal(tomorrow);

          const r = await api(`/api/roster/day?date_ymd=${encodeURIComponent(date_ymd)}`);

          if (!r || r.day_off === true || !r.shift_in || !r.shift_out) {
            cwStatusText.textContent = "You are off tomorrow — enjoy your day! 😎";
          } else {
            const s = fmtHHMM(r.shift_in);
            const e = fmtHHMM(r.shift_out);
            cwStatusText.textContent = `You work tomorrow ${s}–${e} 💪`;
          }
        } catch (err) {
          // se falhar, mantém fallback
        }
      }
    }
  } catch (e) {
    if (e.status === 401) await enterLogin();
    stopLiveTicker();
  }
}


/* =========================
   Current week totals (SAFE)
   Uses /api/report/week/current (source of truth)
========================= */
async function refreshCurrentWeekTotalsSafe() {
  try {
    const rep = await api("/api/report/week/current");

    // se não tem semana
    if (rep?.has_week === false || rep?.ok === false) {
      if (cwHHMM) cwHHMM.textContent = "00:00";
      if (cwPay)  cwPay.textContent  = fmtEUR(0);
      return;
    }

    // pega hhmm de vários formatos possíveis
    const hhmm =
      rep?.totals?.hhmm ??
      rep?.totals?.hours_hhmm ??
      rep?.hhmm ??
      rep?.hours_hhmm ??
      "00:00";

    // pega pay de vários formatos possíveis
    const pay =
      rep?.totals?.pay_eur ??
      rep?.totals?.gross_pay ??
      rep?.pay_eur ??
      rep?.gross_pay ??
      rep?.pay ??
      0;

    if (cwHHMM) cwHHMM.textContent = String(hhmm || "00:00");
    if (cwPay)  cwPay.textContent  = fmtEUR(pay);
  } catch {
    if (cwHHMM) cwHHMM.textContent = cwHHMM.textContent || "00:00";
    if (cwPay)  cwPay.textContent  = cwPay.textContent  || fmtEUR(0);
  }
}


/* =========================
   Refresh all (dashboard + clock)
========================= */
async function refreshAll() {
  try {
    const dash = await api("/api/dashboard");
    LAST_DASH = dash;

    DASH_WEEK_ID =
      LAST_DASH?.this_week?.id ||
      LAST_DASH?.this_week?.week_id ||
      null;

  } catch (e) {
    if (e?.status === 401) { await enterLogin(); return; }
  }

  await refreshTodayMultiplier();

  if (cwWeekNo) {
    cwWeekNo.textContent =
      LAST_DASH?.this_week?.week_number ? String(LAST_DASH.this_week.week_number) : "--";
  }

  const paid = Number(LAST_DASH?.bank_holidays?.paid ?? 0);
  const remaining = Number(LAST_DASH?.bank_holidays?.remaining ?? 0);
  if (bhPaid)   bhPaid.textContent   = String(paid);
  if (bhRemain) bhRemain.textContent = String(remaining);

  await refreshClock();
  await refreshCurrentWeekTotalsSafe();

  updateTodayEarningsUI();

  if (CLOCK?.has_week && CLOCK?.in_time && !CLOCK?.out_time && !CLOCK?.break_running) startLiveTicker();
  else stopLiveTicker();
}


/* =========================
   Custom Yes/No Modal (Promise)
========================= */
let __whModalEl = null;

function ensureYesNoModal() {
  if (__whModalEl) return __whModalEl;

  const overlay = document.createElement("div");
  overlay.className = "whModalOverlay hidden";
  overlay.id = "whYesNoOverlay";

  overlay.innerHTML = `
    <div class="whModal" role="dialog" aria-modal="true" aria-labelledby="whYesNoTitle">
      <div class="whModalHeader">
        <div class="whModalIcon" id="whYesNoIcon">⏱</div>
        <div class="whModalTitle" id="whYesNoTitle">Confirm</div>
      </div>
      <div class="whModalBody" id="whYesNoMsg"></div>
      <div class="whModalHint" id="whYesNoHint"></div>
      <div class="whModalFooter">
        <button type="button" class="btnX btnGhost" id="whYesNoNo">No</button>
        <button type="button" class="btnX btnBlue" id="whYesNoYes">Yes</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  __whModalEl = overlay;
  return overlay;
}

function showYesNoModal({ title, message, icon = "⏱", yesText = "Yes", noText = "No", hint = "" }) {
  const overlay = ensureYesNoModal();

  const titleEl = overlay.querySelector("#whYesNoTitle");
  const msgEl   = overlay.querySelector("#whYesNoMsg");
  const iconEl  = overlay.querySelector("#whYesNoIcon");
  const yesBtn  = overlay.querySelector("#whYesNoYes");
  const noBtn   = overlay.querySelector("#whYesNoNo");
  const hintEl  = overlay.querySelector("#whYesNoHint");

  titleEl.textContent = title || "Confirm";
  msgEl.textContent   = message || "";
  iconEl.textContent  = icon || "⏱";
  yesBtn.textContent  = yesText || "Yes";
  noBtn.textContent   = noText || "No";
  // Se for modal informativo (mesmo texto ou só um botão)
if (!noText || yesText === noText) {
  noBtn.style.display = "none";
  yesBtn.style.marginLeft = "auto";
} else {
  noBtn.style.display = "";
  yesBtn.style.marginLeft = "";
}

  hintEl.textContent  = hint || "";

  overlay.classList.remove("hidden");
  yesBtn.focus();

  return new Promise((resolve) => {
    let done = false;

    const cleanup = (val) => {
      if (done) return;
      done = true;

      overlay.classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      overlay.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);

      resolve(val);
    };

    const onYes = () => cleanup(true);
    const onNo  = () => cleanup(false);

    const onOverlay = (e) => {
      if (e.target === overlay) cleanup(false);
    };

    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter") cleanup(true);
    };

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    overlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

async function handleOvertimePrompt(resObj) {
  const reason = resObj.reason || "";
  const work_date = resObj.work_date || todayYMD();

  const text =
    reason === "DAY_OFF"
      ? "You are OFF today.\nAuthorize overtime for this shift?"
      : "Authorize overtime?";

  const yes = await showYesNoModal({
    title: "Overtime",
    message: text,
    icon: "⏱",
    yesText: "Yes",
    noText: "No",
    hint: "Tip: Enter = Yes • Esc = No"
  });

  await api("/api/clock/extra-confirm", {
    method: "POST",
    body: JSON.stringify({ work_date, authorized: !!yes }),
  });

  if (yes) return { proceed: true, authorized: true, reason };

  if (reason === "DAY_OFF") {
    await showYesNoModal({
      title: "Not authorized",
      message: "Overtime not authorized. Nothing will be recorded.",
      icon: "⛔",
      yesText: "OK",
      noText: "OK",
      hint: ""
    });
    return { proceed: false, authorized: false, reason };
  }

  await showYesNoModal({
    title: "Info",
    message: "Not authorized.\nExtra time outside roster will not be paid.",
    icon: "ℹ️",
    yesText: "OK",
    noText: "OK",
    hint: ""
  });

  return { proceed: true, authorized: false, reason };
}

/* =========================
   Clock actions
========================= */
async function doClockIn() {
  try {
    await ensureWeekExistsForClock();
    const r = await api("/api/clock/in", { method: "POST" });

    if (r?.needs_extra_confirm) {
      const decision = await handleOvertimePrompt(r);
      if (!decision.proceed) return;
      await api("/api/clock/in", { method: "POST" });
    }

    await refreshAll();
  } catch (e) {
    alert(e.message || "IN failed");
  }
}

async function doClockOut() {
  try {
    const r = await api("/api/clock/out", { method: "POST" });

    if (r?.needs_extra_confirm) {
      const decision = await handleOvertimePrompt(r);
      if (!decision.proceed) return;
      await api("/api/clock/out", { method: "POST" });
    }

    await refreshAll();
  } catch (e) {
    alert(e.message || "OUT failed");
  }
}

async function doClockBreak() 
{
  requestNotificationPermission();

  try {
    const r = await api("/api/clock/break", { method: "POST" });

    if (r && r.break_running === true) {
      startBreakCountdown(BREAK_DEFAULT_SEC);
    } else {
      stopBreakCountdown(false);
      await refreshAll();
    }

    await refreshAll();
  } catch (e) {
    alert(e.message || "BREAK failed");
  }
}

/* =========================
   Add week page
========================= */
function openAddWeekPage(defaultRate = 0) {
  if (!hasIndexViews()) return;

  hideAllViews();
  show(viewAddWeek);

  if (addWeekMsg) addWeekMsg.textContent = "";

  if (awWeekNumber) awWeekNumber.value = String(isoWeekNumber(new Date()));
  if (awStartDate) awStartDate.value = mondayOfThisWeek(new Date());

  const r = Number(defaultRate || ME?.hourly_rate || getSavedRate() || 0);
  if (awHourlyRate) awHourlyRate.value = String(r.toFixed(2));
}
function backFromAddWeek() {
  if (window.history.length > 1) window.history.back();
  else go("/");
}
async function createWeekFromPage(ev) {
  ev.preventDefault();
  if (addWeekMsg) addWeekMsg.textContent = "";

  try {
    const week_number = Number(awWeekNumber?.value || 0);
    const start_date = (awStartDate?.value || "").trim();
    const hourly_rate = Number(awHourlyRate?.value || 0);

    if (hourly_rate > 0) saveRate(hourly_rate);

    await api("/api/weeks", {
      method: "POST",
      body: JSON.stringify({ week_number, start_date, hourly_rate }),
    });

    go("/");
  } catch (e) {
    if (addWeekMsg) addWeekMsg.textContent = e.message || "Failed to create week";
  }
}

/* =========================
   ROSTER (/roster)
========================= */
const R = (id) => document.getElementById(id);
const SHIFT_PAID_MIN = 495; // 8h15 paid

function codeToLabel(code) {
  if (code === "A") return "09:45 → 19:00";
  if (code === "B") return "10:45 → 20:00";
  return "OFF";
}
function rosterExpectedMinutesFromCodes(codes) {
  return (codes || []).reduce((acc, code) => {
    if (code === "A" || code === "B") return acc + SHIFT_PAID_MIN;
    return acc;
  }, 0);
}
async function rosterCalcExpectedPay(codes, startYmd, rate) {
  let total = 0;
  const r = Number(rate || 0);

  for (let i = 0; i < (codes || []).length; i++) {
    const code = codes[i];
    if (code !== "A" && code !== "B") continue;

    const ymd = ymdAddDays(startYmd, i);
    const mult = await premiumMultiplierForYmd(ymd);
    total += (SHIFT_PAID_MIN / 60) * r * mult;
  }
  return total;
}

window.__WH_ROSTER = window.__WH_ROSTER || {
  hourlyRate: 0,
  picked: [],
  startDate: "",
  activeDayIndex: 0,
};
const ROSTER = window.__WH_ROSTER;

async function rosterRenderPreview() {
  const box = R("rosterPreview");
  const list = R("rpList");
  const totals = R("rpTotals");
  if (!box || !list || !totals) return;

  if (!ROSTER.picked.length || !ROSTER.startDate) {
    box.classList.add("hidden");
    return;
  }

  box.classList.remove("hidden");
  list.innerHTML = "";

  const mins = rosterExpectedMinutesFromCodes(ROSTER.picked);
  const hhmm = `${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;

  const pay = await rosterCalcExpectedPay(ROSTER.picked, ROSTER.startDate, ROSTER.hourlyRate);
totals.textContent = `Expected: ${hhmm} • ${fmtEUR(Number.isFinite(pay) ? pay : 0)}`;


  for (let i = 0; i < ROSTER.picked.length; i++) {
    const code = ROSTER.picked[i];
    const ymd = ymdAddDays(ROSTER.startDate, i);
    const dt = ymdToDateObj(ymd);

    const row = document.createElement("div");
    row.className = "rpRow";
    row.innerHTML = `
      <div class="left">
        <div class="d1">${weekdayShort(dt)} • ${ymd}</div>
        <div class="d2">${code === "OFF" ? "Day off" : "Shift"}</div>
      </div>
      <div class="right">${codeToLabel(code)}</div>
    `;
    list.appendChild(row);
  }
}

function rosterRenderWizardDay() {
  const dayTitle = R("rwDayTitle");
  const dayDate = R("rwDayDate");
  const saveBtn = R("btnRwSave");
  const weekInput = R("rwWeekNumber");
  const startInput = R("rwStartDate");

  if (!startInput) return;

  ROSTER.startDate = (startInput.value || "").trim();
  if (saveBtn) saveBtn.disabled = ROSTER.picked.length !== 7;

  if (!ROSTER.startDate) {
    if (dayTitle) dayTitle.textContent = "Pick start date";
    if (dayDate) dayDate.textContent = "";
    rosterRenderPreview().catch(() => {});
    return;
  }

  const ymd = ymdAddDays(ROSTER.startDate, ROSTER.activeDayIndex);
  const dt = ymdToDateObj(ymd);

  if (dayTitle) dayTitle.textContent = `${weekdayShort(dt)}`;
  if (dayDate) dayDate.textContent = `${ymd}`;

  if (weekInput && !String(weekInput.value || "").trim()) {
    weekInput.value = String(isoWeekNumber(new Date()));
  }

  rosterRenderPreview().catch(() => {});
}

function rosterWizardReset() {
  ROSTER.picked = [];
  ROSTER.activeDayIndex = 0;

  const weekInput = R("rwWeekNumber");
  const startInput = R("rwStartDate");

  if (weekInput) weekInput.value = String(isoWeekNumber(new Date()));
  if (startInput) startInput.value = todayYMD();

  ROSTER.startDate = (startInput?.value || "").trim();
  rosterRenderWizardDay();
}

function rosterPick(code) {
  const startInput = R("rwStartDate");
  ROSTER.startDate = (startInput?.value || "").trim();

  if (!ROSTER.startDate) {
    alert("Select start date first.");
    return;
  }

  if (ROSTER.picked.length >= 7) return;

  ROSTER.picked.push(code);
  ROSTER.activeDayIndex = Math.min(6, ROSTER.picked.length);
  rosterRenderWizardDay();
}

function rosterOpenWizard() {
  const wizard = R("rosterWizard");
  if (wizard) wizard.classList.remove("hidden");
  rosterWizardReset();
}
function rosterCloseWizard() {
  const wizard = R("rosterWizard");
  if (wizard) wizard.classList.add("hidden");
}

async function rosterShowDetail(roster) {
  const detail = R("rosterDetail");
  const title = R("rosterDetailTitle");
  const totals = R("rosterDetailTotals");
  const grid = R("rosterDetailGrid");

  if (detail) detail.classList.remove("hidden");
  if (title) title.textContent = `Week ${roster.week_number} (start ${roster.start_date})`;

  const codes = (roster.days || []).map((d) =>
    d.day_off ? "OFF" : d.shift_in === "09:45" ? "A" : "B"
  );

  const mins = rosterExpectedMinutesFromCodes(codes);
  const hhmm = `${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;

  const pay = await rosterCalcExpectedPay(codes, roster.start_date, ROSTER.hourlyRate);
  if (totals) totals.textContent = `Expected: ${hhmm} • ${fmtEUR(pay)}`;

  if (grid) {
    grid.innerHTML = "";
    for (const d of roster.days || []) {
      const dt = ymdToDateObj(d.work_date);
      const code = d.day_off ? "OFF" : d.shift_in === "09:45" ? "A" : "B";

      const cell = document.createElement("div");
      cell.className = "rosterCell";
      cell.innerHTML = `
        <div class="rcTop">${weekdayShort(dt)}</div>
        <div class="rcDate">${d.work_date}</div>
        <div class="rcShift">${codeToLabel(code)}</div>
      `;
      grid.appendChild(cell);
    }
  }
}

async function rosterLoadDetail(rosterId) {
  try {
    window.__WH_ACTIVE_ROSTER_ID = rosterId;
    const r = await api(`/api/roster/${rosterId}`);
    window.__WH_ACTIVE_ROSTER_WEEKNO = r?.week_number ?? null;
    await rosterShowDetail(r);
  } catch (e) {
    alert(e.message || "Failed to load roster");
  }
}

async function rosterLoadList() {
  const list = R("rosterWeeksList");
  const msg = R("rosterListMsg");
  if (!list) return;

  list.innerHTML = "";
  if (msg) msg.textContent = "Loading...";

  try {
    const items = await api("/api/roster");
    if (!items || !items.length) {
      if (msg) msg.textContent = "No roster weeks yet. Click “Add week”.";
      return;
    }
    if (msg) msg.textContent = "";

    for (const it of items) {
      const card = document.createElement("div");
      card.className = "weekItem";
      card.innerHTML = `
        <div class="weekLeft">
          <div class="t1">Week ${it.week_number}</div>
          <div class="t2">Start: ${it.start_date}</div>
        </div>
        <div class="weekRight"></div>
      `;
      card.addEventListener("click", () => rosterLoadDetail(it.id));
      list.appendChild(card);
    }

    await rosterLoadDetail(items[0].id);
  } catch (e) {
    if (msg) msg.textContent = "";
    alert(e.message || "Failed to load rosters");
    if (e.status === 401) go("/");
  }
}

async function rosterSaveWeek() {
  const weekInput = R("rwWeekNumber");
  const startInput = R("rwStartDate");

  const week_number = Number(weekInput?.value || 0);
  const start_date = (startInput?.value || "").trim();

  if (!week_number || week_number < 1) { alert("Week number invalid."); return; }
  if (!start_date) { alert("Start date required."); return; }
  if (ROSTER.picked.length !== 7) { alert("Select all days (Sun..Sat) before saving."); return; }

  try {
    await api("/api/roster", {
      method: "POST",
      body: JSON.stringify({
        week_number,
        start_date,
        days: ROSTER.picked,
      }),
    });

    rosterCloseWizard();
    await rosterLoadList();
  } catch (e) {
    alert(e.message || "Failed to save roster");
  }
}

async function enterRoster() {
  try { ME = await refreshMe(false); } catch {}

  ROSTER.hourlyRate =
  Number(ME?.hourly_rate ?? 0) ||
  Number(getSavedRate() ?? 0) ||
  18.24;


  try {
    const weeks = await api("/api/weeks");
    if (weeks && weeks.length) ROSTER.hourlyRate = Number(weeks[0].hourly_rate || ROSTER.hourlyRate || 0);
  } catch {}

  const addBtn = R("btnRosterAddWeek");
  const cancelBtn = R("btnRwCancel");
  const backBtn = R("btnRwBack");
  const saveBtn = R("btnRwSave");
  const startInput = R("rwStartDate");

  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = "1";
    addBtn.addEventListener("click", rosterOpenWizard);
  }
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = "1";
    cancelBtn.addEventListener("click", rosterCloseWizard);
  }
  if (backBtn && !backBtn.dataset.bound) {
    backBtn.dataset.bound = "1";
    backBtn.addEventListener("click", rosterCloseWizard);
  }

  const bA = R("btnRwA");
  const bB = R("btnRwB");
  const bOFF = R("btnRwOFF");

  if (bA && !bA.dataset.bound) {
    bA.dataset.bound = "1";
    bA.addEventListener("click", () => rosterPick("A"));
  }
  if (bB && !bB.dataset.bound) {
    bB.dataset.bound = "1";
    bB.addEventListener("click", () => rosterPick("B"));
  }
  if (bOFF && !bOFF.dataset.bound) {
    bOFF.dataset.bound = "1";
    bOFF.addEventListener("click", () => rosterPick("OFF"));
  }

  if (startInput && !startInput.dataset.bound) {
    startInput.dataset.bound = "1";
    startInput.addEventListener("change", () => {
      ROSTER.startDate = (R("rwStartDate")?.value || "").trim();
      ROSTER.picked = [];
      ROSTER.activeDayIndex = 0;
      rosterRenderWizardDay();
    });
  }

  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = "1";
    saveBtn.addEventListener("click", rosterSaveWeek);
  }

  await rosterLoadList();
}

async function routeAfterAuth() {
  if (!ME) {
    try { ME = await refreshMe(false); } catch {}
  }
  if (ME) applyMeToUI(ME);

  if (pathIs("/admin")) { 
    await initAdminPage(); 
    return; 
  }

  if (pathIs("/roster")) { 
    await enterRoster(); 
    return; 
  }

  if (pathIs("/holidays") || pathIs("/report") || pathIs("/profile")) return;

  if (!hasIndexViews()) return;

  if (pathIs("/add-week")) {
    let defaultRate = Number(ME?.hourly_rate || 0) || Number(getSavedRate() || 0);
    try {
      const weeks = await api("/api/weeks");
      if (weeks && weeks.length) defaultRate = Number(weeks[0].hourly_rate || defaultRate || 0);
    } catch {}
    openAddWeekPage(defaultRate);
    return;
  }

  await enterHome();
}



/* =========================
   Navigation (data-route)
========================= */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-route]").forEach((el) => {
    el.addEventListener("click", () => {
      const r = el.getAttribute("data-route");
      if (r) go(r);
    });
  });

  const btnHolidays = $("btnHolidays");
  if (btnHolidays) btnHolidays.addEventListener("click", () => go("/holidays"));
});

/* =========================
   Bind (common)
========================= */
function bind() {
  loginForm?.addEventListener("submit", doLogin);
  signupForm?.addEventListener("submit", doSignup);

  btnShowSignup?.addEventListener("click", showSignup);
  btnShowLogin?.addEventListener("click", showLogin);

  btnForgot?.addEventListener("click", toggleForgot);
  btnSendReset?.addEventListener("click", sendReset);

  btnLogout?.addEventListener("click", doLogout);

  const openProfile = () => go("/profile");
  btnOpenProfile?.addEventListener("click", openProfile);
  navProfile?.addEventListener("click", openProfile);

  btnIn?.addEventListener("click", doClockIn);
  btnOut?.addEventListener("click", doClockOut);
  btnBreak?.addEventListener("click", doClockBreak);

  cardHolidays?.addEventListener("click", () => go("/holidays"));
  cardReports?.addEventListener("click", () => go("/report"));

  btnAddWeek?.addEventListener("click", () => go("/add-week"));

  btnBackAddWeek?.addEventListener("click", backFromAddWeek);
  addWeekForm?.addEventListener("submit", createWeekFromPage);

  navHome?.addEventListener("click", () => go("/"));
  navHistory?.addEventListener("click", () => go("/roster"));
  navHolidays?.addEventListener("click", () => go("/holidays"));
  navReports?.addEventListener("click", () => go("/report"));
}

/* =========================
   Init
========================= */
let dayWatcherStarted = false;
requestNotificationPermission();

(async function init() {
  bind();

  if (!dayWatcherStarted) {
    dayWatcherStarted = true;
    setInterval(watchDayChange, 5000);
  }

  const cached = readCachedMe();
  if (cached?.ok) applyMeToUI(cached);

  window.addEventListener("pageshow", () => {
    refreshMe(false).catch(() => {});
  });

  try {
    ME = await refreshMe(false);
    await routeAfterAuth();
  } catch (e) {
    if (hasIndexViews()) await enterLogin();
  }
})();

