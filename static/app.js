/* =========================
   Work Hours Tracker - app.js (v18)
   FULL REBUILD (bugfix + cleanup)

   FIXED:
   - ✅ me undefined -> uses ME everywhere
   - ✅ removed duplicate functions (ymdLocal, fmtHHMM)
   - ✅ removed recursive listener add inside doClockOut()
   - ✅ break countdown no longer dies if backend briefly returns break_running=false
   - ✅ refreshClock reconciles backend/local break state safely
   - ✅ safer navigation fetch handling preserved
========================= */

console.log("app.js loaded ✅ v18");

// ---- navigation guard (prevents "Failed to fetch" alerts on page change)
window.__WH_NAVIGATING__ = false;
window.addEventListener("beforeunload", () => { window.__WH_NAVIGATING__ = true; });

/* =========================
   Small DOM helpers
========================= */
const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");
function go(path) { window.location.href = path; }
function pathIs(p) { return window.location.pathname === p; }

/* =========================
   Local caches
========================= */
const LS_ME = "wh_me";
const LS_AVATAR = "wh_avatar_url";
let ME = null;

/* =========================
   Format helpers
========================= */
function fmtEUR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "€0.00";
  return `€${n.toFixed(2)}`;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function secondsToHHMMSS(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec || 0)));
  const hh = pad2(Math.floor(s / 3600));
  const mm = pad2(Math.floor((s % 3600) / 60));
  const ss = pad2(s % 60);
  return `${hh}:${mm}:${ss}`;
}
function fmtMMSS(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec || 0)));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}
function fmtHHMM(t) {
  if (!t) return "";
  return String(t).slice(0, 5); // "09:45:00" -> "09:45"
}

/* =========================
   Date helpers (single source)
========================= */
const APP_TIMEZONE = "Europe/Dublin";

function datePartsInDublin(dt = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(dt);
  const out = {};
  parts.forEach((part) => {
    if (part.type !== "literal") out[part.type] = part.value;
  });
  return out;
}

function todayYMD() {
  const p = datePartsInDublin(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}
function ymdFromDate(dt) {
  const p = datePartsInDublin(dt);
  return `${p.year}-${p.month}-${p.day}`;
}
function ymdToDateObj(ymd) {
  const [y, m, d] = String(ymd || "").split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}
function isSunday(dt) { return datePartsInDublin(dt).weekday === "Sun"; }
function tescoFiscalYearStart(fiscalYear) {
  const march1 = new Date(Number(fiscalYear) || 1970, 2, 1);
  const day = march1.getDay(); // Sun=0..Sat=6
  if (day === 0) return march1;
  if (day <= 4) {
    march1.setDate(march1.getDate() - day);
    return march1;
  }
  march1.setDate(march1.getDate() + (7 - day));
  return march1;
}
function tescoFiscalWeek(d = new Date()) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let fiscalYear = dt.getFullYear();
  let start = tescoFiscalYearStart(fiscalYear);
  if (dt < start) {
    fiscalYear -= 1;
    start = tescoFiscalYearStart(fiscalYear);
  } else {
    const nextStart = tescoFiscalYearStart(fiscalYear + 1);
    if (dt >= nextStart) {
      fiscalYear += 1;
      start = nextStart;
    }
  }
  const weekNumber = Math.floor((dt - start) / 86400000 / 7) + 1;
  return { fiscalYear, weekNumber };
}
function mondayOfThisWeek(d = new Date()) {
  const x = new Date(d);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(datePartsInDublin(d).weekday);
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return ymdFromDate(x);
}
function sundayOfThisWeek(d = new Date()) {
  const x = new Date(d);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(datePartsInDublin(d).weekday);
  x.setDate(x.getDate() - day);
  return ymdFromDate(x);
}
function tescoWeekNumber(d = new Date()) {
  return tescoFiscalWeek(d).weekNumber;
}
function ymdAddDays(ymd, add) {
  if (!ymd) return "";
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(y || 1970, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + Number(add || 0));
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function weekdayShort(dt) {
  return datePartsInDublin(dt).weekday || "";
}
function hhmmToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}
function minutesToHHMM(mins) {
  const total = Math.max(0, Math.floor(Number(mins || 0)));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
function safeText(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/* =========================
   API helper
========================= */
async function api(path, opts = {}) {
  try {
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

  } catch (e) {
    if (window.__WH_NAVIGATING__ || e?.name === "AbortError") {
      console.log("Fetch aborted (navigation) ✅", path);
      return null;
    }
    throw e;
  }
}

/* =========================
   ME cache
========================= */
function readCachedMe(){
  try { return JSON.parse(localStorage.getItem(LS_ME) || "null"); }
  catch { return null; }
}

async function refreshMe(force = false) {
  if (!force) {
    const cached = readCachedMe();
    if (cached && cached.ok) {
      ME = cached;
      applyMeToUI(ME);
    }
  }

  const me = await api("/api/me");
  ME = me;

  try { localStorage.setItem(LS_ME, JSON.stringify(me)); } catch {}
  applyMeToUI(ME);

  return ME;
}
window.refreshMe = refreshMe;

/* =========================
   Avatar + Name (single source of truth)
========================= */
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

  // Avatar
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
      el.src = finalUrl || "/static/logo.png";
      el.style.display = "";
    }
  });

  const btn = $("btnProfileAvatar");
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => go("/profile"));
  }
}

/* =========================
   Admin UI (fixed)
========================= */
function applyAdminUI() {
  const adminBtn = document.getElementById("openAdmin");
  const panelBtn = document.getElementById("btnAdminPanel");

  const isAdmin = !!(ME && Number(ME.is_admin || 0) === 1);

  if (adminBtn) {
    adminBtn.classList.toggle("hidden", !isAdmin);
    adminBtn.onclick = isAdmin ? () => (location.href = "/admin") : null;
  }

  if (panelBtn) {
    panelBtn.classList.toggle("hidden", !isAdmin);
    panelBtn.onclick = isAdmin ? () => (location.href = "/admin") : null;
  }
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

  const today = new Date();
  const startDate = sundayOfThisWeek(today);
  const payload = {
    week_number: tescoWeekNumber(today),
    start_date: startDate,
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
  if (datePartsInDublin(dt).weekday === "Sun") mult = Math.max(mult, SUN_MULT);

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
const bottomNav   = document.querySelector(".bottomNav");

function hasIndexViews() { return !!(viewLogin || viewHome || viewAddWeek); }
function hideAllViews() { hide(viewLogin); hide(viewHome); hide(viewAddWeek); }
function setBottomNavVisible(visible) {
  bottomNav?.classList.toggle("hidden", !visible);
}
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

const cwWeekBtn = $("cwWeekBtn");
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
const cardDeliveries = $("cardDeliveries");
const cardSettings = $("cardSettings");
const deliveriesWeekInline = $("deliveriesWeekInline");
const deliveriesInsightText = $("deliveriesInsightText");

const navHome    = $("navHome");
const navHistory = $("navHistory");
const navHolidays= $("navHolidays");
const navReports = $("navReports");
const navProfile = $("navProfile");

/* =========================
   Add Week UI
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
let DELIVERY_STATE = { items: [], week: null, month: null, location_breakdown: [] };
let REMINDER_STATE = { reminders: null, schedule: null, ready: false };
let DELIVERY_HOME_INSIGHT_TIMER = null;
let DELIVERY_HOME_INSIGHT_INDEX = 0;

/* =========================
   Break countdown (robust)
   - local countdown survives brief backend desync
========================= */
let breakTick = null;
let breakRemaining = 0;
let breakRunningUI = false;

const BREAK_DEFAULT_SEC = 60 * 60;
const LS_BREAK_START = "wh_break_start_epoch";
const LS_BREAK_LENGTH = "wh_break_length_sec";
const LS_BREAK_END  = "wh_break_end_epoch";
const LS_BREAK_DAY  = "wh_break_day";
const LS_BREAK_WARN5= "wh_break_warn5_sent";
const LS_BREAK_DONE = "wh_break_done_sent";
const LS_BREAK_LEFT = "wh_break_left_sec";
const LS_BREAK_LAST_START = "wh_break_last_start_epoch";
const LS_BREAK_LAST_END = "wh_break_last_end_epoch";
const LS_BREAK_LAST_DAY = "wh_break_last_day";

function getLocalBreakEnd() {
  return Number(localStorage.getItem(LS_BREAK_END) || "0");
}
function getLocalBreakStart() {
  return Number(localStorage.getItem(LS_BREAK_START) || "0");
}
function getLocalBreakLengthSec() {
  const raw = Number(localStorage.getItem(LS_BREAK_LENGTH) || "");
  return Number.isFinite(raw) && raw > 0 ? raw : BREAK_DEFAULT_SEC;
}
function getLocalBreakLeftSec() {
  const endEpoch = getLocalBreakEnd();
  if (!endEpoch) return 0;
  return Math.ceil((endEpoch - Date.now()) / 1000);
}
function hasActiveLocalBreak() {
  const savedDay = localStorage.getItem(LS_BREAK_DAY);
  if (!savedDay || savedDay !== UI_DAY) return false;
  return getLocalBreakLeftSec() > 0;
}

function fmtHHMMFromEpoch(epochMs) {
  if (!epochMs) return "--:--";
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtBreakDurationFromSeconds(totalSec) {
  const safe = Math.max(0, Math.round(Number(totalSec || 0)));
  const totalMin = Math.max(1, Math.round(safe / 60));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function saveBreakStart(startEpochMs, lengthSec = BREAK_DEFAULT_SEC) {
  localStorage.setItem(LS_BREAK_START, String(startEpochMs));
  localStorage.setItem(LS_BREAK_LENGTH, String(Math.max(1, Math.round(lengthSec))));
  localStorage.setItem(LS_BREAK_DAY, UI_DAY);
}
function saveBreakSummary(startEpochMs, endEpochMs) {
  localStorage.setItem(LS_BREAK_LAST_START, String(startEpochMs));
  localStorage.setItem(LS_BREAK_LAST_END, String(endEpochMs));
  localStorage.setItem(LS_BREAK_LAST_DAY, UI_DAY);
}
function getBreakSummaryForToday() {
  if (localStorage.getItem(LS_BREAK_LAST_DAY) !== UI_DAY) return null;
  const start = Number(localStorage.getItem(LS_BREAK_LAST_START) || "0");
  const end = Number(localStorage.getItem(LS_BREAK_LAST_END) || "0");
  if (!start || !end || end < start) return null;
  return { start, end, durationSec: Math.max(0, Math.round((end - start) / 1000)) };
}
function clearBreakStorage() {
  localStorage.removeItem(LS_BREAK_END);
  localStorage.removeItem(LS_BREAK_START);
  localStorage.removeItem(LS_BREAK_LENGTH);
  localStorage.removeItem(LS_BREAK_DAY);
  localStorage.removeItem(LS_BREAK_WARN5);
  localStorage.removeItem(LS_BREAK_DONE);
  localStorage.removeItem(LS_BREAK_LEFT);
}
function clearBreakSummaryStorage() {
  localStorage.removeItem(LS_BREAK_LAST_START);
  localStorage.removeItem(LS_BREAK_LAST_END);
  localStorage.removeItem(LS_BREAK_LAST_DAY);
}

function renderBreakInfoLine(running = false, remainingSec = null, forceNeutral = false) {
  if (!cwBreak) return;

  if (forceNeutral) {
    cwBreak.textContent = "0m";
    return;
  }

  if (running) {
    const startEpoch =
      getLocalBreakStart() ||
      (() => {
        const endEpoch = getLocalBreakEnd();
        const lengthSec = getLocalBreakLengthSec();
        return endEpoch ? endEpoch - lengthSec * 1000 : 0;
      })();
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startEpoch) / 1000));
    cwBreak.textContent = `BREAK started: ${fmtHHMMFromEpoch(startEpoch)} | ${fmtMMSS(elapsedSec)}`;
    return;
  }

  const summary = getBreakSummaryForToday();
  if (summary) {
    cwBreak.textContent = `BREAK ${fmtHHMMFromEpoch(summary.start)}\u2013${fmtHHMMFromEpoch(summary.end)} (${fmtBreakDurationFromSeconds(summary.durationSec)})`;
    return;
  }

  if (CLOCK) {
    cwBreak.textContent = `${Number(CLOCK.break_minutes || 0)}m`;
    return;
  }

  cwBreak.textContent = "0m";
}

function setBreakButtonRunning(running, remainingSec = null) {
  if (!btnBreak) return;
  const label = btnBreak.querySelector(".pillText");
  if (label) {
    label.textContent = running ? "STOP" : "BREAK";
  }
  btnBreak.classList.toggle("is-breakRunning", running);
}
function saveBreakEnd(endEpochMs) {
  localStorage.setItem(LS_BREAK_END, String(endEpochMs));
  localStorage.setItem(LS_BREAK_DAY, UI_DAY);
}

function stopBreakCountdown(vibrate = false) {
  const startEpoch = getLocalBreakStart() || (() => {
    const endEpoch = getLocalBreakEnd();
    const lengthSec = getLocalBreakLengthSec();
    return endEpoch ? endEpoch - lengthSec * 1000 : 0;
  })();
  const endEpoch = Date.now();

  if (breakTick) clearInterval(breakTick);
  breakTick = null;
  breakRunningUI = false;
  breakRemaining = 0;

  if (startEpoch) saveBreakSummary(startEpoch, endEpoch);
  clearBreakStorage();
  setBreakButtonRunning(false);
  renderBreakInfoLine(false);
  if (vibrate && "vibrate" in navigator) navigator.vibrate([200, 100, 200]);
}

function sendBreakNotification(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, icon: "/static/logo.png", vibrate: [200, 100, 200] });
}

function tickBreakCountdown() {
  const endEpoch = getLocalBreakEnd();
  if (!endEpoch) {
    // no local break tracked -> just stop UI timer
    if (breakTick) clearInterval(breakTick);
    breakTick = null;
    breakRunningUI = false;
    setBreakButtonRunning(false);
    renderBreakInfoLine(false);
    return;
  }

  const leftSec = Math.ceil((endEpoch - Date.now()) / 1000);
  breakRemaining = leftSec;

  setBreakButtonRunning(true, leftSec);
  renderBreakInfoLine(true, leftSec);

  // 5-min warning (once)
  if (leftSec <= 300 && leftSec > 0) {
    const warned = localStorage.getItem(LS_BREAK_WARN5) === "1";
    if (!warned) {
      localStorage.setItem(LS_BREAK_WARN5, "1");
      sendBreakNotification("⏳ 5 minutes left", "Your break is almost over.");
    }
  }

  // finished
  if (leftSec <= 0) {
    const done = localStorage.getItem(LS_BREAK_DONE) === "1";
    if (!done) {
      localStorage.setItem(LS_BREAK_DONE, "1");
      sendBreakNotification("✅ Break finished", "Time to go back to work!");
    }

    stopBreakCountdown(true);

    // tell backend break ended
    api("/api/clock/break", { method: "POST" })
      .then(() => refreshAll())
      .catch(() => {});
  }
}

function startBreakCountdown(seconds = BREAK_DEFAULT_SEC) {
  breakRunningUI = true;

  const startEpoch = Date.now();
  const endEpoch = startEpoch + seconds * 1000;
  clearBreakSummaryStorage();
  saveBreakStart(startEpoch, seconds);
  saveBreakEnd(endEpoch);

  setBreakButtonRunning(true, seconds);
  renderBreakInfoLine(true, seconds);
  tickBreakCountdown();

  if (breakTick) clearInterval(breakTick);
  breakTick = setInterval(tickBreakCountdown, 250);
}

function resumeBreakCountdownIfAny() {
  if (!hasActiveLocalBreak()) return;

  breakRunningUI = true;
  const leftSec = getLocalBreakLeftSec();
  if (!getLocalBreakStart()) {
    const lengthSec = getLocalBreakLengthSec();
    const endEpoch = getLocalBreakEnd();
    if (endEpoch) saveBreakStart(endEpoch - lengthSec * 1000, lengthSec);
  }
  setBreakButtonRunning(true, leftSec);
  renderBreakInfoLine(true, leftSec);
  tickBreakCountdown();

  if (breakTick) clearInterval(breakTick);
  breakTick = setInterval(tickBreakCountdown, 250);
}

function resetTodayVisual() {
  if (cwIn) cwIn.textContent = "00:00";
  if (cwOut) cwOut.textContent = "00:00";

  if (hasActiveLocalBreak()) {
    setBreakButtonRunning(true, getLocalBreakLeftSec());
    resumeBreakCountdownIfAny();
  } else {
    clearBreakStorage();
    clearBreakSummaryStorage();
    setBreakButtonRunning(false);
    renderBreakInfoLine(false);
    if (breakTick) clearInterval(breakTick);
    breakTick = null;
    breakRunningUI = false;
    breakRemaining = 0;
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

/* =========================
   Notifications permission
   NOTE: best practice is calling from user gesture;
   we still expose helper and also call on BREAK click.
========================= */
function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    try { Notification.requestPermission(); } catch {}
  }
}

function reminderStorageKey(type, ymd) {
  return `wh_reminder_${type}_${ymd}`;
}

function markReminderSent(type, ymd) {
  localStorage.setItem(reminderStorageKey(type, ymd), "1");
}

function reminderAlreadySent(type, ymd) {
  return localStorage.getItem(reminderStorageKey(type, ymd)) === "1";
}

function clearReminderFlagsForDay(ymd) {
  ["break", "missed_in", "missed_out"].forEach((type) => {
    localStorage.removeItem(reminderStorageKey(type, ymd));
  });
}

function notifyUser(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, icon: "/static/logo.png" });
  } catch {}
}

async function loadReminderConfig() {
  try {
    const [reminders, schedule] = await Promise.all([
      api("/api/settings/reminders"),
      api("/api/settings/schedule"),
    ]);
    if (reminders) REMINDER_STATE.reminders = reminders;
    if (schedule) REMINDER_STATE.schedule = schedule;
    REMINDER_STATE.ready = !!(REMINDER_STATE.reminders && REMINDER_STATE.schedule);
  } catch {
    REMINDER_STATE.ready = false;
  }
  return REMINDER_STATE;
}

async function maybeCheckReminders(clockOverride = null) {
  try {
    if (!ME) return;
    if (!REMINDER_STATE.ready) await loadReminderConfig();
    if (!REMINDER_STATE.ready) return;

    const clock = clockOverride || await api("/api/clock/today");
    if (!clock) return;

    const schedule = REMINDER_STATE.schedule || {};
    const reminders = REMINDER_STATE.reminders || {};
    const today = todayYMD();
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const activeDays = Array.isArray(schedule.active_days) ? schedule.active_days : [];
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(datePartsInDublin(new Date()).weekday);

    if (!activeDays.includes(dow)) return;

    const startMin = hhmmToMinutes(schedule.start_time);
    const endMin = hhmmToMinutes(schedule.end_time);
    const breakAfter = Number(schedule.break_after_min || reminders.break_reminder_after_min || 240);
    const inOffset = Number(reminders.missed_in_offset_min || 10);
    const outOffset = Number(reminders.missed_out_offset_min || 20);

    if (reminders.break_enabled && clock?.in_time && !clock?.out_time && !clock?.break_running) {
      const inMin = hhmmToMinutes(clock.in_time);
      if (inMin !== null && nowMin >= inMin + breakAfter && !reminderAlreadySent("break", today)) {
        markReminderSent("break", today);
        notifyUser("Break reminder", "It looks like break time is due.");
      }
    }

    if (reminders.missed_in_enabled && !clock?.in_time && startMin !== null && nowMin >= startMin + inOffset && !reminderAlreadySent("missed_in", today)) {
      markReminderSent("missed_in", today);
      notifyUser("Missed IN reminder", `You were scheduled to start around ${schedule.start_time}.`);
    }

    if (reminders.missed_out_enabled && clock?.in_time && !clock?.out_time && endMin !== null && nowMin >= endMin + outOffset && !reminderAlreadySent("missed_out", today)) {
      markReminderSent("missed_out", today);
      notifyUser("Missed OUT reminder", `You may have finished around ${schedule.end_time}.`);
    }
  } catch {}
}

let REMINDER_TIMER = null;
function startReminderEngine() {
  if (REMINDER_TIMER) return;
  REMINDER_TIMER = setInterval(() => {
    maybeCheckReminders().catch(() => {});
  }, 60000);
  maybeCheckReminders().catch(() => {});
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
  setBottomNavVisible(false);
  show(viewLogin);
  showLogin();
}

async function enterHome() {
  if (!hasIndexViews()) return;

  hideAllViews();
  setBottomNavVisible(true);
  show(viewHome);

  ME = await refreshMe(true);
  applyAdminUI();

  await loadReminderConfig();
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
  REMINDER_STATE = { reminders: null, schedule: null, ready: false };
  DELIVERY_STATE = { items: [], week: null, month: null, location_breakdown: [] };

  stopLiveTicker();
  stopBreakCountdown(false);

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

/* =========================
   Today Earnings (LIVE)
========================= */
function getTodayWorkedSeconds() {
  if (!CLOCK?.in_time) return 0;

  const now = new Date();
  const [ih, im] = String(CLOCK.in_time).split(":").map(Number);
  const inDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ih || 0, im || 0, 0);

  let endDt = now;
  if (CLOCK.out_time) {
    const [oh, om] = String(CLOCK.out_time).split(":").map(Number);
    endDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), oh || 0, om || 0, 0);
  }

  const rawWorkedSec = Math.max(0, Math.floor((endDt - inDt) / 1000));
  const breakMin = Number(CLOCK.break_minutes || 0);
  return Math.max(0, rawWorkedSec - breakMin * 60);
}

function getTodayDeliveriesDone() {
  const items = Array.isArray(DELIVERY_STATE?.items) ? DELIVERY_STATE.items : [];
  const today = todayYMD();
  return items
    .filter((item) => item?.work_date === today)
    .reduce((sum, item) => sum + Number(item?.delivery_count || 0), 0);
}

function formatCoachHours(mins) {
  const total = Math.max(0, Math.round(Number(mins || 0)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${pad2(m)}m`;
}

function formatCoachPayGap(expected, actual) {
  const exp = Number(expected || 0);
  const cur = Number(actual || 0);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  const diff = cur - exp;
  if (diff >= 0) return `${fmtEUR(diff)} above target`;
  return `${fmtEUR(Math.abs(diff))} left to expected weekly pay`;
}

function parseHHMMToMinutes(hhmm) {
  const text = String(hhmm || "00:00");
  const [hh, mm] = text.slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  return (hh * 60) + mm;
}

function selectCurrentRosterRow(rows) {
  const today = todayYMD();
  const todayRaw = parseFloat(today.replace(/-/g, ""));
  const list = Array.isArray(rows) ? rows : [];

  for (const row of list) {
    const start = safeText(row?.start_date || "");
    if (!start) continue;
    const end = ymdAddDays(start, 6);
    const startRaw = parseFloat(String(start).replace(/-/g, ""));
    const endRaw = parseFloat(String(end).replace(/-/g, ""));
    if (Number.isFinite(startRaw) && Number.isFinite(endRaw) && todayRaw >= startRaw && todayRaw <= endRaw) {
      return row;
    }
  }

  return list[0] || null;
}

function buildRosterWeekSummary(roster) {
  const days = Array.isArray(roster?.days) ? roster.days : [];
  const today = todayYMD();
  const todayRaw = parseFloat(today.replace(/-/g, ""));

  const normalisedDays = days.map((day) => {
    const hasShift = !!day?.shift_in && !!day?.shift_out && !day?.day_off;
    const minutes = hasShift ? Math.max(0, parseHHMMToMinutes(day.shift_out) - parseHHMMToMinutes(day.shift_in)) : 0;
    return { ...day, minutes };
  });

  const totalMinutes = normalisedDays.reduce((sum, day) => sum + Number(day.minutes || 0), 0);
  const scheduledSoFarMinutes = normalisedDays.reduce((sum, day) => {
    const raw = parseFloat(String(day?.work_date || "").replace(/-/g, ""));
    return sum + (Number.isFinite(raw) && raw <= todayRaw ? Number(day.minutes || 0) : 0);
  }, 0);

  return {
    id: roster?.id ?? null,
    weekNumber: roster?.week_number ?? null,
    startDate: roster?.start_date || null,
    days: normalisedDays,
    totalMinutes,
    scheduledSoFarMinutes,
    todayDay: normalisedDays.find((day) => day.work_date === today) || null,
  };
}

async function loadCurrentRosterWeekSummary() {
  const list = await api("/api/roster").catch(() => []);
  if (!Array.isArray(list) || !list.length) return null;

  const selected = selectCurrentRosterRow(list);
  if (!selected?.id) return null;

  const roster = await api(`/api/roster/${selected.id}`).catch(() => null);
  if (!roster) return null;

  return buildRosterWeekSummary(roster);
}

function loadTodayRosterHint() {
  return api("/api/roster/current")
    .then((r) => (r?.has_roster ? r : null))
    .catch(() => null);
}

function updateHomeCoachCard(dash, todayRoster, rosterWeek) {
  const title = $("homeCoachTitle");
  const line = $("homeCoachLine");
  const chip = $("homeCoachChip");
  const hero = document.querySelector(".homeHero");
  if (!title || !line || !chip || !hero) return;

  const earnedPay = Number(dash?.this_week?.pay_eur ?? 0);
  const workedMinutes = parseHHMMToMinutes(dash?.this_week?.hhmm || "00:00");
  const rate = Number(dash?.this_week?.hourly_rate ?? ME?.hourly_rate ?? getSavedRate() ?? 0);
  const rosterTotalMinutes = Number(rosterWeek?.totalMinutes ?? 0);
  const rosterPlannedSoFarMinutes = Number(rosterWeek?.scheduledSoFarMinutes ?? 0);
  const expectedWeeklyPay = rosterTotalMinutes > 0 && Number.isFinite(rate) && rate > 0
    ? (rosterTotalMinutes / 60) * rate
    : 0;
  const expectedSoFarPay = expectedWeeklyPay > 0 && rosterTotalMinutes > 0
    ? expectedWeeklyPay * (rosterPlannedSoFarMinutes / rosterTotalMinutes)
    : 0;
  const hoursLeftMinutes = Math.max(0, rosterTotalMinutes - workedMinutes);
  const payLeft = Math.max(0, expectedWeeklyPay - earnedPay);
  const todayShift = todayRoster || rosterWeek?.todayDay || null;
  const shiftIn = safeText(todayShift?.shift_in || "");
  const shiftOut = safeText(todayShift?.shift_out || "");
  const hasShift = !!shiftIn && !!shiftOut && !todayShift?.day_off;
  const shiftLabel = hasShift ? `Shift ${fmtHHMM(shiftIn)}–${fmtHHMM(shiftOut)}` : "Shift details unavailable";
  const hasWeek = !!CLOCK?.has_week;
  const live = !!CLOCK?.in_time && !CLOCK?.out_time;
  const finished = !!CLOCK?.out_time;
  const dayOff = !!todayShift?.day_off;

  const onTrack = rosterTotalMinutes > 0
    ? (earnedPay >= expectedSoFarPay && workedMinutes >= rosterPlannedSoFarMinutes)
    : false;

  hero.classList.remove("is-coach-neutral", "is-coach-good", "is-coach-warning", "is-coach-bad");

  if (!hasWeek || (!live && !finished)) {
    title.textContent = dayOff ? "Day off today" : "Ready to start your shift?";
    if (expectedWeeklyPay > 0) {
      line.textContent = dayOff
        ? `${fmtEUR(earnedPay)} earned so far • ${fmtEUR(payLeft)} left to expected weekly pay`
        : `${shiftLabel} today • Weekly target ${fmtEUR(expectedWeeklyPay)}`;
    } else {
      line.textContent = dayOff
        ? `${fmtEUR(earnedPay)} earned so far`
        : shiftLabel;
    }
    chip.textContent = dayOff ? "OFF" : "READY";
    hero.classList.add("is-coach-neutral");
    return;
  }

  if (live) {
    if (onTrack) {
      title.textContent = "You’re on track for your weekly pay";
      line.textContent = expectedWeeklyPay > 0
        ? `${fmtEUR(earnedPay)} earned • ${formatCoachHours(workedMinutes)} / ${formatCoachHours(rosterTotalMinutes)} rostered`
        : `${fmtEUR(earnedPay)} earned • ${formatCoachHours(workedMinutes)} worked`;
      chip.textContent = CLOCK?.break_running ? "BREAK" : "LIVE";
      hero.classList.add("is-coach-good");
    } else {
      if (expectedWeeklyPay > 0) {
        title.textContent = "You’re behind pace";
        line.textContent = hoursLeftMinutes > 0
          ? `${fmtEUR(earnedPay)} earned • ${formatCoachHours(hoursLeftMinutes)} left to finish your roster`
          : `${fmtEUR(earnedPay)} earned • ${fmtEUR(payLeft)} left to expected weekly pay`;
        hero.classList.add("is-coach-warning");
      } else {
        title.textContent = "You’re building momentum";
        line.textContent = `${fmtEUR(earnedPay)} earned so far`;
        hero.classList.add("is-coach-neutral");
      }
      chip.textContent = CLOCK?.break_running ? "BREAK" : "LIVE";
    }
    return;
  }

  if (finished) {
    if (expectedWeeklyPay > 0 && earnedPay >= expectedWeeklyPay) {
      title.textContent = "You already passed your scheduled pay";
      line.textContent = `${fmtEUR(earnedPay)} earned • ${formatCoachPayGap(expectedWeeklyPay, earnedPay)}`;
      hero.classList.add("is-coach-good");
    } else if (expectedWeeklyPay > 0) {
      title.textContent = "Weekly roster complete";
      line.textContent = `${fmtEUR(earnedPay)} earned • ${fmtEUR(payLeft)} left to expected weekly pay`;
      hero.classList.add("is-coach-warning");
    } else {
      title.textContent = earnedPay > 0 ? "Solid week 👊" : "Week complete";
      line.textContent = earnedPay > 0 ? `${fmtEUR(earnedPay)} earned this week` : "No earnings tracked this week";
      hero.classList.add("is-coach-neutral");
    }
    chip.textContent = "DONE";
    return;
  }

  title.textContent = "Weekly progress";
  line.textContent = expectedWeeklyPay > 0
    ? `${fmtEUR(earnedPay)} earned so far • ${fmtEUR(payLeft)} left to expected weekly pay`
    : `${fmtEUR(earnedPay)} earned so far`;
  chip.textContent = "LIVE";
  hero.classList.add("is-coach-neutral");
}

function getDeliveryItemsInRange(items, startYmd, endYmd) {
  const start = parseFloat(String(startYmd || "").replace(/-/g, ""));
  const end = parseFloat(String(endYmd || "").replace(/-/g, ""));
  return (items || []).filter((item) => {
    const raw = parseFloat(String(item?.work_date || "").replace(/-/g, ""));
    return Number.isFinite(raw) && raw >= start && raw <= end;
  });
}

function getDeliveryTopLocation(items) {
  const tally = new Map();
  (items || []).forEach((item) => {
    const loc = safeText(item?.location || "");
    if (!loc) return;
    tally.set(loc, (tally.get(loc) || 0) + Number(item?.delivery_count || 0));
  });
  let best = null;
  let bestCount = -1;
  tally.forEach((count, loc) => {
    if (count > bestCount) {
      best = loc;
      bestCount = count;
    }
  });
  return best || "-";
}

function getDeliveryRecordWeek(items) {
  const weekTotals = new Map();
  (items || []).forEach((item) => {
    const dt = ymdToDateObj(item?.work_date || todayYMD());
    const key = `${dt.getFullYear()}-${tescoWeekNumber(dt)}`;
    const current = weekTotals.get(key) || { total: 0, weekNumber: tescoWeekNumber(dt) };
    current.total += Number(item?.delivery_count || 0);
    weekTotals.set(key, current);
  });

  let best = { weekNumber: null, total: 0 };
  weekTotals.forEach((value) => {
    if (value.total > best.total) best = value;
  });
  return best;
}

function weekdayLong(dt) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    weekday: "long",
  }).format(dt || new Date());
}

function getDeliveryCountInRange(items, startYmd, endYmd) {
  return getDeliveryItemsInRange(items, startYmd, endYmd)
    .reduce((sum, item) => sum + Number(item?.delivery_count || 0), 0);
}

function getBestDeliveryDay(trend) {
  const rows = Array.isArray(trend) ? trend : [];
  let best = null;
  rows.forEach((row) => {
    const value = Number(row?.value || 0);
    if (!best || value > best.value) {
      best = row ? { ...row, value } : null;
    }
  });
  if (!best || best.value <= 0) return null;
  return {
    day: weekdayLong(ymdToDateObj(best.date || todayYMD())),
    total: best.value,
  };
}

function formatDeliveryWeekDelta(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);
  const diff = cur - prev;
  if (!Number.isFinite(diff) || (cur <= 0 && prev <= 0)) return "same as last week";
  if (diff === 0) return "same as last week";
  return `${diff > 0 ? "+" : ""}${diff} vs last week`;
}

function getHomeDeliveryInsights(stats) {
  const items = Array.isArray(stats?.items) ? stats.items : [];
  const weekTotal = Number(stats?.week?.total ?? 0);
  const weekTrend = Array.isArray(stats?.week?.trend) ? stats.week.trend : [];
  const weekStart = mondayOfThisWeek(new Date());
  const weekEnd = ymdAddDays(weekStart, 6);
  const prevWeekStart = ymdAddDays(weekStart, -7);
  const prevWeekEnd = ymdAddDays(weekStart, -1);
  const weekItems = getDeliveryItemsInRange(items, weekStart, weekEnd);
  const lastWeekTotal = getDeliveryCountInRange(items, prevWeekStart, prevWeekEnd);
  const record = getDeliveryRecordWeek(items);
  const bestDay = getBestDeliveryDay(weekTrend);
  const weekRun1 = Number(stats?.week?.run_1 ?? 0);
  const weekRun2 = Number(stats?.week?.run_2 ?? 0);
  const topLocationAllTime = getDeliveryTopLocation(items);

  return [
    `This week: ${weekTotal} deliveries • ${formatDeliveryWeekDelta(weekTotal, lastWeekTotal)}`,
    `Top location this week: ${getDeliveryTopLocation(weekItems)}`,
    bestDay ? `Best day: ${bestDay.day} • ${bestDay.total} deliveries` : "Best day: —",
    record.total > 0 ? `Record week: ${record.total} deliveries` : "Record week: —",
    `Run split this week: R1 ${weekRun1} · R2 ${weekRun2}`,
    `Most used location all time: ${topLocationAllTime}`,
  ];
}

function stopDeliveryHomeInsights() {
  if (DELIVERY_HOME_INSIGHT_TIMER) clearInterval(DELIVERY_HOME_INSIGHT_TIMER);
  DELIVERY_HOME_INSIGHT_TIMER = null;
  DELIVERY_HOME_INSIGHT_INDEX = 0;
}

function renderDeliveryHomeInsights(stats) {
  if (!deliveriesInsightText) {
    stopDeliveryHomeInsights();
    return;
  }

  const insights = getHomeDeliveryInsights(stats);
  if (!insights.length) {
    stopDeliveryHomeInsights();
    deliveriesInsightText.textContent = "Fast logging. Premium summaries.";
    return;
  }

  const applyInsight = () => {
    deliveriesInsightText.classList.remove("is-flash");
    deliveriesInsightText.textContent = insights[DELIVERY_HOME_INSIGHT_INDEX % insights.length];
    void deliveriesInsightText.offsetWidth;
    deliveriesInsightText.classList.add("is-flash");
  };

  applyInsight();

  if (DELIVERY_HOME_INSIGHT_TIMER) clearInterval(DELIVERY_HOME_INSIGHT_TIMER);
  DELIVERY_HOME_INSIGHT_TIMER = setInterval(() => {
    DELIVERY_HOME_INSIGHT_INDEX = (DELIVERY_HOME_INSIGHT_INDEX + 1) % insights.length;
    applyInsight();
  }, 3200);
}

function getTodayEarnedAmount() {
  if (!CLOCK?.has_week || !CLOCK?.in_time) return 0;

  const rate =
    Number(ME?.hourly_rate ?? 0) ||
    Number(LAST_DASH?.this_week?.hourly_rate ?? 0) ||
    Number(getSavedRate() ?? 0);

  if (!Number.isFinite(rate) || rate <= 0) return 0;

  const workedSec = getTodayWorkedSeconds();
  return (workedSec / 3600) * rate * Number(window.TODAY_MULT || 1);
}

function getExpectedEarningsText() {
  const expected = Number(LAST_DASH?.this_week?.pay_eur);
  if (Number.isFinite(expected)) return fmtEUR(expected);
  return "—";
}

function updateTodayEarningsUI() {
  const tHHMM  = $("todayEarnHHMM");
  const tPAY   = $("todayEarnPay");
  const tSTATE = $("todayEarnState");
  const tCard  = document.getElementById("todayEarnCard");
  const tLive   = tCard?.querySelector(".teGrid.teGrid--2");
  const tSummary = $("todayEarnSummary");
  const tDayHours = $("todayEarnDayHours");
  const tDayEarned = $("todayEarnDayEarned");
  const tDayDeliveries = $("todayEarnDayDeliveries");
  const tWeekTotal = $("todayEarnWeekTotal");
  const tWeekHours = $("todayEarnWeekHours");
  const tExpected = $("todayEarnExpected");

  const isLive =
    !!CLOCK?.has_week &&
    !!CLOCK?.in_time &&
    !CLOCK?.out_time &&
    !CLOCK?.break_running;
  const isSummary = !!CLOCK?.has_week && !!CLOCK?.in_time && !!CLOCK?.out_time;

  if (tCard) tCard.classList.toggle("is-live", isLive);
  if (tCard) tCard.classList.toggle("is-summary", isSummary);
  if (tLive) tLive.classList.toggle("hidden", isSummary);
  if (tSummary) tSummary.classList.toggle("hidden", !isSummary);

  if (isSummary) {
    if (tSTATE) tSTATE.textContent = "SUMMARY";
    if (tDayHours) tDayHours.textContent = secondsToHHMMSS(getTodayWorkedSeconds());
    if (tDayEarned) tDayEarned.textContent = fmtEUR(getTodayEarnedAmount());
    if (tDayDeliveries) tDayDeliveries.textContent = String(getTodayDeliveriesDone());
    if (tWeekTotal) tWeekTotal.textContent = fmtEUR(Number(LAST_DASH?.this_week?.pay_eur ?? 0));
    if (tWeekHours) tWeekHours.textContent = String(cwHHMM?.textContent || "00:00");
    if (tExpected) tExpected.textContent = getExpectedEarningsText();
    if (tHHMM) tHHMM.textContent = String(cwHHMM?.textContent || "00:00");
    if (tPAY) tPAY.textContent = String(cwPay?.textContent || fmtEUR(0));
    return;
  }

  if (!tHHMM || !tPAY) return;

  if (!CLOCK?.has_week || !CLOCK?.in_time) {
    tHHMM.textContent = "--:--:--";
    tPAY.textContent  = "€-.--";
    if (tSTATE) tSTATE.textContent = "OFF";
    stopLiveTicker();
    return;
  }

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

  const workedSec = getTodayWorkedSeconds();

  const eur = (workedSec / 3600) * rate * Number(window.TODAY_MULT || 1);

  tHHMM.textContent = secondsToHHMMSS(workedSec);
  tPAY.textContent  = fmtEUR(eur);
}

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
      updateTodayEarningsUI();
      return;
    }
    updateTodayEarningsUI();
  }, 1000);
}
window.startLiveTicker = startLiveTicker;
window.stopLiveTicker = stopLiveTicker;

/* =========================
   Clock refresh (break-safe)
========================= */
async function refreshClock() {
  try {
    const c = await api("/api/clock/today");
    if (!c) return;

    CLOCK = c;
    TODAY_WEEK_ID = c?.has_week ? (c.week_id ?? null) : null;

    // ===============================
    // NO WEEK CREATED
    // ===============================
    if (!c.has_week) {
      if (cwIn) cwIn.textContent = "--:--";
      if (cwOut) cwOut.textContent = "--:--";
      renderBreakInfoLine(false, null, true);
      if (cwStatusText) cwStatusText.textContent = "Create a week first.";
      setBreakButtonRunning(false);
      stopLiveTicker();
      return;
    }

    if (cwIn)  cwIn.textContent  = c.in_time  || "--:--";
    if (cwOut) cwOut.textContent = c.out_time || "--:--";

    // ===============================
    // BREAK RECONCILIATION
    // ===============================
    const localActive = hasActiveLocalBreak();

    if (c.break_running) {
      setBreakButtonRunning(true, getLocalBreakLeftSec() || BREAK_DEFAULT_SEC);

      if (!localActive) {
        const savedLeft = Number(localStorage.getItem(LS_BREAK_LEFT) || "0");
        const resumeSec =
          (Number.isFinite(savedLeft) &&
           savedLeft > 0 &&
           savedLeft <= BREAK_DEFAULT_SEC)
            ? savedLeft
            : BREAK_DEFAULT_SEC;

        localStorage.removeItem(LS_BREAK_LEFT);
        startBreakCountdown(resumeSec);
      } else {
        resumeBreakCountdownIfAny();
      }

    } else {

      if (localActive) {
        setBreakButtonRunning(true, getLocalBreakLeftSec());
        resumeBreakCountdownIfAny();
      } else {
        setBreakButtonRunning(false);
        renderBreakInfoLine(false);

        if (breakTick) clearInterval(breakTick);
        breakTick = null;
        breakRunningUI = false;
        breakRemaining = 0;
        clearBreakStorage();
      }
    }

    // ===============================
    // STATUS TEXT LOGIC
    // ===============================
    if (!cwStatusText) return;

    // 1️⃣ NOT CLOCKED IN
    if (!c.in_time) {
      try {
        const todayYmd = ymdFromDate(new Date());
        const todayRoster =
          await api(`/api/roster/day?date_ymd=${encodeURIComponent(todayYmd)}`);

        // ---- TODAY OFF ----
        if (todayRoster && todayRoster.day_off === true) {

          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowYmd = ymdFromDate(tomorrow);

          try {
            const tomorrowRoster =
              await api(`/api/roster/day?date_ymd=${encodeURIComponent(tomorrowYmd)}`);

            if (
              tomorrowRoster &&
              !tomorrowRoster.day_off &&
              tomorrowRoster.shift_in &&
              tomorrowRoster.shift_out
            ) {
              const s = fmtHHMM(tomorrowRoster.shift_in);
              const e = fmtHHMM(tomorrowRoster.shift_out);
              cwStatusText.textContent = `OFF today • Tomorrow ${s}–${e}`;
            } else {
              cwStatusText.textContent = "OFF today 😎";
            }

          } catch {
            cwStatusText.textContent = "OFF today 😎";
          }

        }

        // ---- TODAY WORK SHIFT ----
        else if (
          todayRoster &&
          !todayRoster.day_off &&
          todayRoster.shift_in &&
          todayRoster.shift_out
        ) {
          const s = fmtHHMM(todayRoster.shift_in);
          const e = fmtHHMM(todayRoster.shift_out);
          cwStatusText.textContent = `Shift ${s}–${e} • Tap IN to start`;
        }

        else {
          cwStatusText.textContent = "Tap IN to start.";
        }

      } catch {
        cwStatusText.textContent = "Tap IN to start.";
      }

      return;
    }

    // 2️⃣ BREAK RUNNING
    if (c.break_running || localActive) {
      cwStatusText.textContent = "Break running…";
      return;
    }

    // 3️⃣ WORKING
    if (!c.out_time) {
      cwStatusText.textContent = "Tracking live…";
      return;
    }

    // 4️⃣ FINISHED DAY
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowYmd = ymdFromDate(tomorrow);

      const tomorrowRoster =
        await api(`/api/roster/day?date_ymd=${encodeURIComponent(tomorrowYmd)}`);

      if (
        tomorrowRoster &&
        !tomorrowRoster.day_off &&
        tomorrowRoster.shift_in &&
        tomorrowRoster.shift_out
      ) {
        const s = fmtHHMM(tomorrowRoster.shift_in);
        const e = fmtHHMM(tomorrowRoster.shift_out);
        cwStatusText.textContent = `Done for today ✅ • Tomorrow ${s}–${e}`;
      } else {
        cwStatusText.textContent = "Done for today ✅";
      }

    } catch {
      cwStatusText.textContent = "Done for today ✅";
    }

  } catch (e) {
    if (e?.status === 401) await enterLogin();
    stopLiveTicker();
  }
}



/* =========================
   Current week totals (SAFE)
========================= */
async function refreshCurrentWeekTotalsSafe() {
  try {
    const rep = await api("/api/report/week/current");
    if (!rep || rep?.has_week === false || rep?.ok === false) {
      if (cwHHMM) cwHHMM.textContent = "00:00";
      if (cwPay)  cwPay.textContent  = fmtEUR(0);
      return;
    }

    const hhmm =
      rep?.totals?.hhmm ??
      rep?.totals?.hours_hhmm ??
      rep?.hhmm ??
      rep?.hours_hhmm ??
      "00:00";

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
   Refresh all
========================= */
async function refreshAll() {
  try {
    const dash = await api("/api/dashboard");
    if (dash) LAST_DASH = dash;

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

  let todayRoster = null;
  let rosterWeek = null;
  try {
    [todayRoster, rosterWeek] = await Promise.all([
      loadTodayRosterHint(),
      loadCurrentRosterWeekSummary(),
    ]);
  } catch {}

  updateHomeCoachCard(LAST_DASH, todayRoster, rosterWeek);

  if (deliveriesWeekInline) {
    let stats = DELIVERY_STATE;
    try {
      const loaded = await loadDeliveriesStats();
      if (loaded) stats = loaded;
      if (stats) {
        deliveriesWeekInline.textContent = String(stats.week?.total ?? 0);
        renderDeliveryHomeInsights(stats);
      }
    } catch {}
  }

  updateTodayEarningsUI();

  const shouldLive =
    !!CLOCK?.has_week &&
    !!CLOCK?.in_time &&
    !CLOCK?.out_time &&
    !CLOCK?.break_running;

  if (shouldLive) startLiveTicker();
  else stopLiveTicker();

  await maybeCheckReminders(CLOCK);
  bindCurrentWeekTap();
}

/* =========================
   Current week → open report
========================= */
function goCurrentWeekReport() {
  if (DASH_WEEK_ID) {
    go(`/report?week_id=${encodeURIComponent(DASH_WEEK_ID)}`);
    return;
  }
  go("/report?week=current");
}
function bindCurrentWeekTap() {
  if (!cwWeekBtn || cwWeekBtn.dataset.bound) return;
  cwWeekBtn.dataset.bound = "1";
  cwWeekBtn.addEventListener("click", goCurrentWeekReport);
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
  const reason = resObj?.reason || "";
  const work_date = resObj?.work_date || todayYMD();

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

async function showRosterRequiredModal() {
  const goToRoster = await showYesNoModal({
    title: "Roster required",
    message: "No roster found for this week. Please create your roster before clocking in.",
    icon: "📅",
    yesText: "Go to Roster",
    noText: "Go to Roster",
    hint: "",
  });

  if (goToRoster) go("/roster");
  return false;
}

async function getCurrentRosterForClock() {
  try {
    return await api("/api/roster/current");
  } catch {
    return null;
  }
}

async function validateBeforeClockIn() {

  // 1️⃣ Check Hourly Rate
  const rate = Number(ME?.hourly_rate ?? 0);

  if (!rate || rate <= 0) {
    alert("Add Hour Rate First.\nGo to Profile → Hourly Rate.");
    go("/profile");
    return false;
  }

  // 2️⃣ Check current week roster exists
  try {
    const roster = await getCurrentRosterForClock();
    if (!roster?.has_roster) {
      await showRosterRequiredModal();
      return false;
    }
  } catch {
    await showRosterRequiredModal();
    return false;
  }

  return true;
}

/* =========================
   Clock actions
========================= */

async function doClockIn() {
  try {

    // 1️⃣ CHECK HOURLY RATE
    const me = await api("/api/me");
    const rate = Number(me?.hourly_rate || 0);

    if (!rate || rate <= 0) {
      alert("Add Hour Rate First.\nGo to Profile → Hourly Rate.");
      return;
    }

    // 2️⃣ CHECK ROSTER FOR CURRENT FISCAL WEEK
    const rosterToday = await getCurrentRosterForClock();

    if (!rosterToday?.has_roster) {
      await showRosterRequiredModal();
      return;
    }

    // 🚀 DIRECT CLOCK IN (NO AUTO WEEK CREATION)
    const r = await api("/api/clock/in", { method: "POST" });

    if (r?.needs_extra_confirm) {
      const decision = await handleOvertimePrompt(r);
      if (!decision.proceed) return;
      await api("/api/clock/in", { method: "POST" });
    }

    await refreshAll();

  } catch (e) {
    alert(e?.message || "IN failed");
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
    alert(e?.message || "OUT failed");
  }
}

async function doClockBreak() {
  // call permission request on user gesture (best)
  requestNotificationPermission();

  try {
    const r = await api("/api/clock/break", { method: "POST" });
    if (!r) return;

    // START / RESUME
    if (r.break_running === true) {
      const savedLeft = Number(localStorage.getItem(LS_BREAK_LEFT) || "0");
      const resumeSec =
        (Number.isFinite(savedLeft) && savedLeft > 0 && savedLeft <= BREAK_DEFAULT_SEC)
          ? savedLeft
          : BREAK_DEFAULT_SEC;

      localStorage.removeItem(LS_BREAK_LEFT);
      startBreakCountdown(resumeSec);

      await refreshAll();
      return;
    }

    // STOP (PAUSE)
    const leftSec = getLocalBreakLeftSec();
    if (leftSec > 0) localStorage.setItem(LS_BREAK_LEFT, String(leftSec));
    else localStorage.removeItem(LS_BREAK_LEFT);

    stopBreakCountdown(false);
    await refreshAll();

  } catch (e) {
    alert(e?.message || "BREAK failed");
  }
}

/* =========================
   Add week page
========================= */
function openAddWeekPage(defaultRate = 0) {
  if (!hasIndexViews()) return;

  hideAllViews();
  setBottomNavVisible(true);
  show(viewAddWeek);

  if (addWeekMsg) addWeekMsg.textContent = "";

  if (awWeekNumber) awWeekNumber.value = String(tescoWeekNumber(new Date()));
  if (awStartDate) awStartDate.value = sundayOfThisWeek(new Date());

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
   Deliveries page
========================= */
const DELIVERY_LOC_OPTIONS = ["Dublin 8", "Dublin 15"];
const DELIVERY_QTY_OPTIONS = Array.from({ length: 15 }, (_, i) => i + 1);

let DELIVERY_PAGE_STATE = {
  selectedDate: todayYMD(),
  stats: null,
  selectedDay: { work_date: todayYMD(), items: [] },
  editor: { open: false, runNo: 1, location: DELIVERY_LOC_OPTIONS[0], quantity: 1 },
};

function groupDeliveriesByDay(items) {
  const map = new Map();
  (items || []).forEach((item) => {
    if (!map.has(item.work_date)) map.set(item.work_date, []);
    map.get(item.work_date).push(item);
  });
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function renderBarChart(container, items, options = {}) {
  if (!container) return;
  const values = Array.isArray(items) ? items : [];
  const max = Math.max(1, ...values.map((x) => Number(x.value || 0)));
  container.innerHTML = values.map((item) => {
    const val = Number(item.value || 0);
    const pct = Math.round((val / max) * 100);
    return `
      <div class="chartBarRow">
        <div class="chartBarMeta">
          <span class="chartBarLabel">${item.label || ""}</span>
          <span class="chartBarValue">${val}</span>
        </div>
        <div class="chartBarTrack">
          <div class="chartBarFill" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }).join("") || `<div class="emptyState">No data yet.</div>`;
}

function deliveryPageElements() {
  return {
    datePrev: $("deliveryDatePrev"),
    dateNext: $("deliveryDateNext"),
    selectedDateLabel: $("deliveriesSelectedDateLabel"),
    selectedWeekLabel: $("deliveriesSelectedWeekLabel"),
    dayTotal: $("deliveriesDayTotal"),
    dayTotalHint: $("deliveriesDayTotalHint"),
    run1Summary: $("deliveriesRun1Summary"),
    run1Location: $("deliveriesRun1Location"),
    run2Summary: $("deliveriesRun2Summary"),
    run2Location: $("deliveriesRun2Location"),
    summaryRun1: $("deliverySummaryRun1"),
    summaryRun2: $("deliverySummaryRun2"),
    run1Btn: $("deliveryRun1Btn"),
    run2Btn: $("deliveryRun2Btn"),
    run1State: $("deliveryRun1State"),
    run2State: $("deliveryRun2State"),
    weekBoard: $("deliveriesWeekBoard"),
    msg: $("deliveriesMsg"),
    editorOverlay: $("deliveryEditorOverlay"),
    editorClose: $("deliveryEditorClose"),
    editorTitle: $("deliveryEditorTitle"),
    editorDate: $("deliveryEditorDate"),
    editorSummary: $("deliveryEditorSummary"),
    editorLocation8: $("deliveryEditorLocation8"),
    editorLocation15: $("deliveryEditorLocation15"),
    editorQtyGrid: $("deliveryEditorQtyGrid"),
    editorSave: $("deliveryEditorSave"),
    refreshBtn: $("btnDeliveriesRefresh"),
    todayBtn: $("btnDeliveriesToday"),
    homeBtn: $("btnHome"),
  };
}

async function loadDeliveriesStats() {
  const res = await api("/api/deliveries/stats");
  if (!res) return null;
  DELIVERY_STATE = res;
  DELIVERY_PAGE_STATE.stats = res;
  return res;
}

function populateDeliveryForm(dayPayload) {
  const normalized = normalizeDeliveryDay(dayPayload, dayPayload?.work_date || DELIVERY_PAGE_STATE.selectedDate || todayYMD());
  DELIVERY_PAGE_STATE.selectedDate = normalized.work_date;
  DELIVERY_PAGE_STATE.selectedDay = normalized;
}

function formatDeliveryDateLabel(workDate) {
  try {
    const d = ymdToDateObj(workDate);
    return `${weekdayShort(d)} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  } catch {
    return workDate || "";
  }
}

function formatDeliveryDaySummary(run) {
  if (!run) return { location: "Not set", qty: "—", state: "Not set" };
  const qty = Number(run.delivery_count || 0);
  return {
    location: `${deliveryLocationAbbrev(run.location)} • ${qty} deliveries`,
    qty: String(qty),
    state: `${deliveryLocationAbbrev(run.location)} • ${qty} deliveries`,
  };
}

function deliveryLocationAbbrev(location) {
  const text = safeText(location).toLowerCase();
  if (text.includes("15")) return "D15";
  if (text.includes("8")) return "D8";
  return safeText(location) || "-";
}

function normalizeDeliveryDay(dayPayload, fallbackDate) {
  const items = Array.isArray(dayPayload?.items)
    ? dayPayload.items
        .map((item) => ({
          ...item,
          run_no: Number(item.run_no || 0),
          delivery_count: Number(item.delivery_count || 0),
          location: safeText(item.location || ""),
        }))
        .filter((item) => item.run_no === 1 || item.run_no === 2)
        .sort((a, b) => Number(a.run_no) - Number(b.run_no))
    : [];

  return {
    work_date: dayPayload?.work_date || fallbackDate || todayYMD(),
    items,
  };
}

function getDeliveryRun(day, runNo) {
  const items = Array.isArray(day?.items) ? day.items : [];
  return items.find((item) => Number(item.run_no) === Number(runNo)) || null;
}

function getDeliveryDayTotal(day) {
  const items = Array.isArray(day?.items) ? day.items : [];
  return items.reduce((sum, item) => sum + Number(item.delivery_count || 0), 0);
}

function getDeliveryWeekDays(dateValue) {
  const start = sundayOfThisWeek(ymdToDateObj(dateValue || todayYMD()));
  return Array.from({ length: 7 }, (_, idx) => ymdAddDays(start, idx));
}

function getSelectedDeliveryWeekLabel(dateValue) {
  return `Tesco Week ${tescoWeekNumber(ymdToDateObj(dateValue || todayYMD()))}`;
}

async function loadDeliveryDay(dateValue) {
  const target = dateValue || todayYMD();
  const res = await api(`/api/deliveries/day?date_ymd=${encodeURIComponent(target)}`);
  populateDeliveryForm(res || { work_date: target, items: [] });
  return DELIVERY_PAGE_STATE.selectedDay;
}

function renderDeliveryPage() {
  const els = deliveryPageElements();
  if (!els.selectedDateLabel) return;

  const day = DELIVERY_PAGE_STATE.selectedDay || { work_date: DELIVERY_PAGE_STATE.selectedDate, items: [] };
  const selectedDate = day.work_date || DELIVERY_PAGE_STATE.selectedDate || todayYMD();
  const weekDays = getDeliveryWeekDays(selectedDate);

  if (els.selectedDateLabel) {
    const label = formatDeliveryDateLabel(selectedDate);
    els.selectedDateLabel.textContent =
      selectedDate === todayYMD() ? `Today · ${label}` : label;
  }
  if (els.selectedWeekLabel) {
    els.selectedWeekLabel.textContent = getSelectedDeliveryWeekLabel(selectedDate);
  }

  if (els.dayTotal) {
    els.dayTotal.textContent = String(getDeliveryDayTotal(day));
  }

  const run1 = getDeliveryRun(day, 1);
  const run2 = getDeliveryRun(day, 2);

  const r1 = formatDeliveryDaySummary(run1);
  const r2 = formatDeliveryDaySummary(run2);

  if (els.run1Location) els.run1Location.textContent = r1.location;
  if (els.run2Location) els.run2Location.textContent = r2.location;
  if (els.run1Summary) els.run1Summary.textContent = r1.qty;
  if (els.run2Summary) els.run2Summary.textContent = r2.qty;
  if (els.run1State) els.run1State.textContent = r1.state;
  if (els.run2State) els.run2State.textContent = r2.state;

  if (els.run1Btn) {
    els.run1Btn.classList.toggle("is-filled", !!run1);
    els.run1Btn.classList.toggle("is-active", DELIVERY_PAGE_STATE.editor.open && DELIVERY_PAGE_STATE.editor.runNo === 1);
  }
  if (els.run2Btn) {
    els.run2Btn.classList.toggle("is-filled", !!run2);
    els.run2Btn.classList.toggle("is-active", DELIVERY_PAGE_STATE.editor.open && DELIVERY_PAGE_STATE.editor.runNo === 2);
  }
  if (els.summaryRun1) {
    els.summaryRun1.classList.toggle("is-filled", !!run1);
    els.summaryRun1.classList.toggle("is-active", DELIVERY_PAGE_STATE.editor.open && DELIVERY_PAGE_STATE.editor.runNo === 1);
  }
  if (els.summaryRun2) {
    els.summaryRun2.classList.toggle("is-filled", !!run2);
    els.summaryRun2.classList.toggle("is-active", DELIVERY_PAGE_STATE.editor.open && DELIVERY_PAGE_STATE.editor.runNo === 2);
  }

  if (els.weekBoard) {
    const items = Array.isArray(DELIVERY_PAGE_STATE.stats?.items) ? DELIVERY_PAGE_STATE.stats.items : [];
    const dayMap = new Map();
    items.forEach((item) => {
      if (!dayMap.has(item.work_date)) dayMap.set(item.work_date, []);
      dayMap.get(item.work_date).push(item);
    });

    els.weekBoard.innerHTML = weekDays.map((ymd) => {
      const rows = (dayMap.get(ymd) || []).slice().sort((a, b) => Number(a.run_no) - Number(b.run_no));
      const d1 = getDeliveryRun({ items: rows }, 1);
      const d2 = getDeliveryRun({ items: rows }, 2);
      const active = ymd === selectedDate ? " is-selected" : "";
      const isToday = ymd === todayYMD() ? " is-today" : "";
      return `
        <button class="deliveryWeekDay${active}${isToday}" type="button" data-date="${ymd}">
          <span class="deliveryWeekDayHead">
            <span class="deliveryWeekDayName">${weekdayShort(ymdToDateObj(ymd))}</span>
            <span class="deliveryWeekDayDate">${pad2(ymdToDateObj(ymd).getDate())}/${pad2(ymdToDateObj(ymd).getMonth() + 1)}</span>
          </span>
          <span class="deliveryWeekDayLine">${d1 ? `R1 ${Number(d1.delivery_count || 0)} · ${deliveryLocationAbbrev(d1.location)}` : "—"}</span>
          <span class="deliveryWeekDayLine">${d2 ? `R2 ${Number(d2.delivery_count || 0)} · ${deliveryLocationAbbrev(d2.location)}` : "—"}</span>
        </button>
      `;
    }).join("");

    els.weekBoard.querySelectorAll("[data-date]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const date = btn.getAttribute("data-date");
        if (!date) return;
        await loadDeliveryDay(date);
        renderDeliveryPage();
      });
    });
  }

  renderDeliveryEditor();
}

function openDeliveryEditor(runNo) {
  const day = DELIVERY_PAGE_STATE.selectedDay || { work_date: DELIVERY_PAGE_STATE.selectedDate, items: [] };
  const current = getDeliveryRun(day, runNo);
  DELIVERY_PAGE_STATE.editor = {
    open: true,
    runNo,
    location: current?.location || DELIVERY_LOC_OPTIONS[runNo === 2 ? 1 : 0],
    quantity: Math.max(1, Math.min(15, Number(current?.delivery_count || 1))),
  };
  renderDeliveryEditor();
  const els = deliveryPageElements();
  if (els.editorOverlay) {
    els.editorOverlay.classList.remove("hidden");
    els.editorOverlay.setAttribute("aria-hidden", "false");
  }
  renderDeliveryPage();
}

function closeDeliveryEditor() {
  DELIVERY_PAGE_STATE.editor.open = false;
  const els = deliveryPageElements();
  if (els.editorOverlay) {
    els.editorOverlay.classList.add("hidden");
    els.editorOverlay.setAttribute("aria-hidden", "true");
  }
  renderDeliveryPage();
}

function renderDeliveryEditor() {
  const els = deliveryPageElements();
  const editor = DELIVERY_PAGE_STATE.editor || {};
  const selectedDate = DELIVERY_PAGE_STATE.selectedDate || todayYMD();

  if (els.editorTitle) els.editorTitle.textContent = `Run ${editor.runNo || 1}`;
  if (els.editorDate) els.editorDate.textContent = formatDeliveryDateLabel(selectedDate);
  if (els.editorSummary) {
    els.editorSummary.textContent = `Selected: ${editor.location || "-"} · ${editor.quantity || 1} deliveries`;
  }

  if (els.editorLocation8) {
    els.editorLocation8.classList.toggle("is-active", editor.location === "Dublin 8");
  }
  if (els.editorLocation15) {
    els.editorLocation15.classList.toggle("is-active", editor.location === "Dublin 15");
  }

  if (els.editorQtyGrid) {
    els.editorQtyGrid.innerHTML = DELIVERY_QTY_OPTIONS.map((qty) => {
      const active = Number(editor.quantity || 1) === qty ? " is-active" : "";
      return `<button class="deliveryQtyBtn${active}" type="button" data-qty="${qty}">${qty}</button>`;
    }).join("");

    els.editorQtyGrid.querySelectorAll("[data-qty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        DELIVERY_PAGE_STATE.editor.quantity = Number(btn.getAttribute("data-qty") || 1);
        renderDeliveryEditor();
      });
    });
  }

  if (els.editorLocation8) {
    els.editorLocation8.onclick = () => {
      DELIVERY_PAGE_STATE.editor.location = "Dublin 8";
      renderDeliveryEditor();
    };
  }
  if (els.editorLocation15) {
    els.editorLocation15.onclick = () => {
      DELIVERY_PAGE_STATE.editor.location = "Dublin 15";
      renderDeliveryEditor();
    };
  }
}

async function saveDeliveryEditor() {
  const els = deliveryPageElements();
  const editor = DELIVERY_PAGE_STATE.editor || {};
  const day = DELIVERY_PAGE_STATE.selectedDay || { work_date: DELIVERY_PAGE_STATE.selectedDate, items: [] };
  const run1 = getDeliveryRun(day, 1);
  const run2 = getDeliveryRun(day, 2);

  const payload = {
    work_date: DELIVERY_PAGE_STATE.selectedDate || todayYMD(),
    run_1_count: Number(run1?.delivery_count || 0),
    run_1_location: safeText(run1?.location || DELIVERY_LOC_OPTIONS[0]),
    run_2_count: Number(run2?.delivery_count || 0),
    run_2_location: safeText(run2?.location || DELIVERY_LOC_OPTIONS[1]),
  };

  const key = Number(editor.runNo || 1) === 2 ? "run_2" : "run_1";
  payload[`${key}_count`] = Number(editor.quantity || 1);
  payload[`${key}_location`] = safeText(editor.location || DELIVERY_LOC_OPTIONS[0]);

  try {
    await api("/api/deliveries/day", {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    closeDeliveryEditor();
    if (els.msg) els.msg.textContent = "Deliveries saved.";
    const dayCard = document.querySelector(".deliveryDayCard");
    if (dayCard) {
      dayCard.classList.add("is-savedFlash");
      setTimeout(() => dayCard.classList.remove("is-savedFlash"), 900);
    }
    await refreshDeliveriesPage();
  } catch (e) {
    if (els.msg) els.msg.textContent = e.message || "Failed to save deliveries";
  }
}

async function refreshDeliveriesPage() {
  await loadDeliveriesStats();
  await loadDeliveryDay(DELIVERY_PAGE_STATE.selectedDate || todayYMD());
  renderDeliveryPage();
}

async function setSelectedDeliveryDate(dateValue) {
  const target = dateValue || todayYMD();
  await loadDeliveryDay(target);
  renderDeliveryPage();
}

async function initDeliveriesPage() {
  const els = deliveryPageElements();

  DELIVERY_PAGE_STATE.selectedDate = todayYMD();
  DELIVERY_PAGE_STATE.selectedDay = { work_date: DELIVERY_PAGE_STATE.selectedDate, items: [] };
  DELIVERY_PAGE_STATE.editor = {
    open: false,
    runNo: 1,
    location: DELIVERY_LOC_OPTIONS[0],
    quantity: 1,
  };

  els.refreshBtn?.addEventListener("click", refreshDeliveriesPage);
  els.todayBtn?.addEventListener("click", () => setSelectedDeliveryDate(todayYMD()));
  els.datePrev?.addEventListener("click", async () => {
    await setSelectedDeliveryDate(ymdAddDays(DELIVERY_PAGE_STATE.selectedDate, -1));
  });
  els.dateNext?.addEventListener("click", async () => {
    await setSelectedDeliveryDate(ymdAddDays(DELIVERY_PAGE_STATE.selectedDate, 1));
  });
  els.run1Btn?.addEventListener("click", () => openDeliveryEditor(1));
  els.run2Btn?.addEventListener("click", () => openDeliveryEditor(2));
  els.summaryRun1?.addEventListener("click", () => openDeliveryEditor(1));
  els.summaryRun2?.addEventListener("click", () => openDeliveryEditor(2));
  els.editorClose?.addEventListener("click", closeDeliveryEditor);
  els.editorSave?.addEventListener("click", saveDeliveryEditor);
  els.editorOverlay?.addEventListener("click", (ev) => {
    if (ev.target === els.editorOverlay) closeDeliveryEditor();
  });

  await refreshDeliveriesPage();
  renderDeliveryPage();
}

/* =========================
   Settings page
========================= */
function settingsPageElements() {
  return {
    form: $("settingsForm"),
    msg: $("settingsMsg"),
    enableBtn: $("btnEnableNotifications"),
    breakEnabled: $("breakEnabled"),
    missedInEnabled: $("missedInEnabled"),
    missedOutEnabled: $("missedOutEnabled"),
    breakReminderAfter: $("breakReminderAfter"),
    missedInOffset: $("missedInOffset"),
    missedOutOffset: $("missedOutOffset"),
    startTime: $("scheduleStartTime"),
    endTime: $("scheduleEndTime"),
    breakAfter: $("scheduleBreakAfter"),
    dayChecks: [...document.querySelectorAll("[data-schedule-day]")],
  };
}

function fillSettingsForm(reminders, schedule) {
  const els = settingsPageElements();
  if (els.breakEnabled) els.breakEnabled.checked = !!reminders?.break_enabled;
  if (els.missedInEnabled) els.missedInEnabled.checked = !!reminders?.missed_in_enabled;
  if (els.missedOutEnabled) els.missedOutEnabled.checked = !!reminders?.missed_out_enabled;
  if (els.breakReminderAfter) els.breakReminderAfter.value = String(reminders?.break_reminder_after_min ?? 240);
  if (els.missedInOffset) els.missedInOffset.value = String(reminders?.missed_in_offset_min ?? 10);
  if (els.missedOutOffset) els.missedOutOffset.value = String(reminders?.missed_out_offset_min ?? 20);
  if (els.startTime) els.startTime.value = schedule?.start_time || "09:00";
  if (els.endTime) els.endTime.value = schedule?.end_time || "17:00";
  if (els.breakAfter) els.breakAfter.value = String(schedule?.break_after_min ?? 240);
  const active = new Set(schedule?.active_days || []);
  els.dayChecks.forEach((cb) => {
    cb.checked = active.has(Number(cb.value));
  });
}

async function loadSettingsData() {
  const [reminders, schedule] = await Promise.all([
    api("/api/settings/reminders"),
    api("/api/settings/schedule"),
  ]);
  if (reminders) REMINDER_STATE.reminders = reminders;
  if (schedule) REMINDER_STATE.schedule = schedule;
  REMINDER_STATE.ready = !!(reminders && schedule);
  fillSettingsForm(reminders, schedule);
}

async function saveSettingsPage(ev) {
  ev?.preventDefault?.();
  const els = settingsPageElements();
  if (els.msg) els.msg.textContent = "";

  try {
    const schedulePayload = {
      active_days: els.dayChecks.filter((cb) => cb.checked).map((cb) => Number(cb.value)),
      start_time: els.startTime?.value || "09:00",
      end_time: els.endTime?.value || "17:00",
      break_after_min: Number(els.breakAfter?.value || 240),
    };
    const reminderPayload = {
      break_enabled: !!els.breakEnabled?.checked,
      missed_in_enabled: !!els.missedInEnabled?.checked,
      missed_out_enabled: !!els.missedOutEnabled?.checked,
      break_reminder_after_min: Number(els.breakReminderAfter?.value || 240),
      missed_in_offset_min: Number(els.missedInOffset?.value || 10),
      missed_out_offset_min: Number(els.missedOutOffset?.value || 20),
    };

    await api("/api/settings/schedule", {
      method: "PUT",
      body: JSON.stringify(schedulePayload),
    });
    await api("/api/settings/reminders", {
      method: "PUT",
      body: JSON.stringify(reminderPayload),
    });

    await loadSettingsData();
    await loadReminderConfig();
    requestNotificationPermission();
    if (els.msg) els.msg.textContent = "Settings saved.";
  } catch (e) {
    if (els.msg) els.msg.textContent = e.message || "Failed to save settings";
  }
}

async function initSettingsPage() {
  const els = settingsPageElements();
  els.form?.addEventListener("submit", saveSettingsPage);
  els.enableBtn?.addEventListener("click", requestNotificationPermission);

  await loadSettingsData();
}

/* =========================
   Admin page
========================= */
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
   ROSTER (/roster) - CLEAN REBUILD
========================= */

// Helpers
const R = (id) => document.getElementById(id);
const SHIFT_PAID_MIN = 495; // 8h15 paid

// Global state (only declared ONCE)
window.__WH_ROSTER = window.__WH_ROSTER || {
  hourlyRate: 0,
  picked: [],
  startDate: "",
  activeDayIndex: 0,
};

const ROSTER = window.__WH_ROSTER;


// =======================
// Core helpers
// =======================

function codeToLabel(code) {
  if (code === "A") return "09:45 → 19:00";
  if (code === "B") return "10:45 → 20:00";
  return "DAY OFF";
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


// =======================
// Preview Renderer
// =======================

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
  const hhmm = `${pad2(Math.floor(mins/60))}:${pad2(mins%60)}`;

  const pay = await rosterCalcExpectedPay(
    ROSTER.picked,
    ROSTER.startDate,
    ROSTER.hourlyRate
  );

  totals.textContent =
    `Expected: ${hhmm} • ${fmtEUR(Number.isFinite(pay) ? pay : 0)}`;

  for (let i = 0; i < ROSTER.picked.length; i++) {
    const code = ROSTER.picked[i];
    const ymd = ymdAddDays(ROSTER.startDate, i);
    const dt = ymdToDateObj(ymd);

    const row = document.createElement("div");
    row.className = "rpRow";

    // highlight ALL picked
    row.classList.add("is-picked");

    // stronger highlight on last
    if (i === ROSTER.picked.length - 1) {
      row.classList.add("is-latest");
    }

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


// =======================
// Wizard logic
// =======================

function rosterRenderWizardDay() {
  const dayTitle = R("rwDayTitle");
  const dayDate = R("rwDayDate");
  const saveBtn = R("btnRwSave");
  const weekInput = R("rwWeekNumber");
  const startInput = R("rwStartDate");

  if (!startInput) return;

  ROSTER.startDate = (startInput.value || "").trim();

  if (saveBtn) {
    saveBtn.disabled = ROSTER.picked.length !== 7;
  }

  if (!ROSTER.startDate) {
    if (dayTitle) dayTitle.textContent = "Pick start date";
    if (dayDate) dayDate.textContent = "";
    rosterRenderPreview();
    return;
  }

  const ymd = ymdAddDays(ROSTER.startDate, ROSTER.activeDayIndex);
  const dt = ymdToDateObj(ymd);

  if (dayTitle) dayTitle.textContent = weekdayShort(dt);
  if (dayDate) dayDate.textContent = ymd;

  if (weekInput && !weekInput.value) {
    weekInput.value = String(tescoWeekNumber(ymdToDateObj(ROSTER.startDate)));
  }

  rosterRenderPreview();
}


function rosterPick(code) {
  const startInput = R("rwStartDate");
  ROSTER.startDate = (startInput?.value || "").trim();

  if (!ROSTER.startDate) {
    alert("Select start date first.");
    return;
  }

  if (ROSTER.picked.length >= 7) return;

  // 🔵 REMOVE highlight from all buttons
  const bA = R("btnRwA");
  const bB = R("btnRwB");
  const bOFF = R("btnRwOFF");

  [bA, bB, bOFF].forEach(b => b?.classList.remove("shiftOption--active"));

  // 🟦 ADD highlight only to clicked
  if (code === "A") bA?.classList.add("shiftOption--active");
  if (code === "B") bB?.classList.add("shiftOption--active");
  if (code === "OFF") bOFF?.classList.add("shiftOption--active");

  // Save selection
  ROSTER.picked.push(code);
  ROSTER.activeDayIndex = ROSTER.picked.length - 1;

  rosterRenderWizardDay();
}



// =======================
// Init
// =======================

function enterRoster() {
  const bA = R("btnRwA");
  const bB = R("btnRwB");
  const bOFF = R("btnRwOFF");
  const startInput = R("rwStartDate");

  bA?.addEventListener("click", () => rosterPick("A"));
  bB?.addEventListener("click", () => rosterPick("B"));
  bOFF?.addEventListener("click", () => rosterPick("OFF"));

  startInput?.addEventListener("change", () => {
    ROSTER.picked = [];
    ROSTER.activeDayIndex = 0;
    rosterRenderWizardDay();
  });

  rosterRenderWizardDay();
}


/* =========================
   Routing after auth
========================= */
async function routeAfterAuth() {
  if (!ME) {
    try { ME = await refreshMe(false); } catch {}
  }
  if (ME) {
    applyMeToUI(ME);
    applyAdminUI();
  }

  if (pathIs("/admin")) { 
    await initAdminPage(); 
    return; 
  }

  if (pathIs("/roster")) { 
    await enterRoster(); 
    return; 
  }

  if (pathIs("/deliveries")) {
    await initDeliveriesPage();
    return;
  }

  if (pathIs("/settings")) {
    await initSettingsPage();
    return;
  }

  // other pages manage themselves
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

document.addEventListener("DOMContentLoaded", () => {
  const current = window.location.pathname;

  document.querySelectorAll(".navItem").forEach(btn => {
    const route = btn.getAttribute("data-route");
    if (route === current) {
      btn.classList.add("navItem--active");
    }
  });
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
  cardDeliveries?.addEventListener("click", () => go("/deliveries"));
  cardSettings?.addEventListener("click", () => go("/settings"));

  btnAddWeek?.addEventListener("click", () => go("/add-week"));
  awStartDate?.addEventListener("change", () => {
    const selected = awStartDate.value;
    if (!selected) return;
    const sunday = sundayOfThisWeek(ymdToDateObj(selected));
    awStartDate.value = sunday;
    if (awWeekNumber) awWeekNumber.value = String(tescoWeekNumber(ymdToDateObj(sunday)));
  });

  btnBackAddWeek?.addEventListener("click", backFromAddWeek);
  addWeekForm?.addEventListener("submit", createWeekFromPage);

  navHome?.addEventListener("click", () => go("/"));
  navHistory?.addEventListener("click", () => go("/roster"));
  navHolidays?.addEventListener("click", () => go("/holidays"));
  navReports?.addEventListener("click", () => go("/report"));
  document.addEventListener("DOMContentLoaded", enterRoster);
  
  

}

/* =========================
   Init
========================= */
let dayWatcherStarted = false;

(async function init() {
  bind();

  if (!dayWatcherStarted) {
    dayWatcherStarted = true;
    setInterval(watchDayChange, 5000);
  }

  startReminderEngine();

  // Apply cached ME immediately (fast UI)
  const cached = readCachedMe();
  if (cached?.ok) {
    ME = cached;
    applyMeToUI(cached);
    applyAdminUI();
  }

  // When returning from bfcache (mobile), re-sync ME silently
  window.addEventListener("pageshow", () => {
    refreshMe(false).then(() => applyAdminUI()).catch(() => {});
    loadReminderConfig().catch(() => {});
  });

  try {
    ME = await refreshMe(false);
    applyAdminUI();
    await routeAfterAuth();
  } catch (e) {
    if (hasIndexViews()) await enterLogin();
    else go("/");
  }
})();

