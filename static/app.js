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
let clockActionInProgress = false;

function setClockActionButtonBusy(btn, busy) {
  if (!btn) return;
  btn.style.opacity = busy ? "0.5" : "";
  btn.style.pointerEvents = busy ? "none" : "";
  btn.disabled = !!busy;
}

function setClockActionButtonVisual(btn, variant, disabled) {
  if (!btn) return;
  const variants = ["pill--green", "pill--gray", "pill--orange", "pill--red"];
  variants.forEach((cls) => btn.classList.remove(cls));
  if (variant) btn.classList.add(variant);
  btn.style.opacity = disabled ? "0.35" : "";
  btn.style.pointerEvents = disabled ? "none" : "";
  btn.disabled = !!disabled;
}

let __toastHost = null;
function ensureToastHost() {
  if (__toastHost) return __toastHost;
  if (!document.body) return null;

  __toastHost = document.createElement("div");
  __toastHost.className = "toastContainer";
  __toastHost.setAttribute("aria-live", "polite");
  __toastHost.setAttribute("aria-atomic", "true");
  document.body.appendChild(__toastHost);
  return __toastHost;
}

function showToast(message, type = "info") {
  const host = ensureToastHost();
  if (!host) return;

  const toast = document.createElement("div");
  const kind = ["success", "error", "info"].includes(type) ? type : "info";
  toast.className = `toastItem toastItem--${kind}`;
  toast.textContent = String(message || "");
  host.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("is-visible"));

  const dismiss = () => {
    toast.classList.remove("is-visible");
    window.setTimeout(() => toast.remove(), 180);
  };

  const timer = window.setTimeout(dismiss, 3000);
  toast.addEventListener("click", () => {
    window.clearTimeout(timer);
    dismiss();
  });
}
window.showToast = showToast;

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

function escapeHTML(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

function dublinNowMinutes(dt = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const out = {};
  parts.forEach((part) => {
    if (part.type !== "literal") out[part.type] = part.value;
  });
  const hh = Number(out.hour || 0);
  const mm = Number(out.minute || 0);
  return (hh * 60) + mm;
}

function formatCoachDateLabel(ymd) {
  if (!ymd) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    day: "numeric",
    month: "short",
  }).format(ymdToDateObj(ymd));
}

function formatCoachDateLong(ymd) {
  if (!ymd) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(ymdToDateObj(ymd));
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
const todayEarnCard = $("todayEarnCard");
const todayEarnTitle = $("todayEarnTitle");
const todayEarnState = $("todayEarnState");
const todayEarnSub = $("todayEarnSub");
const todayEarnBreak = $("todayEarnBreak");
const todayBreakCountdown = $("todayBreakCountdown");
const todayBreakStart = $("todayBreakStart");
const todayBreakEnd = $("todayBreakEnd");
const todayBreakProgress = $("todayBreakProgress");

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
const homeCoachHero = $("homeCoachHero");
const homeCoachPane = $("homeCoachPane");
const homeCoachIcon = $("homeCoachIcon");
const homeCoachTitle = $("homeCoachTitle");
const homeCoachLine = $("homeCoachLine");
const homeCoachSub = $("homeCoachSub");
const homeCoachChips = $("homeCoachChips");
const homeCoachChip = $("homeCoachChip");
const homeCoachDots = $("homeCoachDots");
const homeCoachHint = $("homeCoachHint");
const deliveriesWeekInline = $("deliveriesWeekInline");
const deliveriesRecordBadge = $("deliveriesRecordBadge");

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
const BANK_HOLIDAY_YEAR_CACHE = new Map();
const HOME_COACH_STATE = {
  cards: [],
  index: 0,
  timer: null,
  pauseUntil: 0,
  pointer: null,
  bound: false,
  ready: false,
};

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
    label.textContent = running ? "END BREAK" : "BREAK";
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
  renderTodayBreakMode({
    ...getBreakModeState(),
    leftSec: Math.max(0, leftSec),
  });

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
      showToast("Break finished — time to return", "info");
      sendBreakNotification("Break finished — time to return", "Time to go back to work!");
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

function getDeliveryItemsInRange(items, startYmd, endYmd) {
  const start = parseFloat(String(startYmd || "").replace(/-/g, ""));
  const end = parseFloat(String(endYmd || "").replace(/-/g, ""));
  return (items || []).filter((item) => {
    const raw = parseFloat(String(item?.work_date || "").replace(/-/g, ""));
    return Number.isFinite(raw) && raw >= start && raw <= end;
  });
}

function getDeliveryWeekWindow(dateYmd = todayYMD()) {
  const startYmd = sundayOfThisWeek(ymdToDateObj(dateYmd || todayYMD()));
  return {
    startYmd,
    endYmd: ymdAddDays(startYmd, 6),
  };
}

function getDeliveryLocationSplit(items, startYmd, endYmd) {
  const split = {
    "Dublin 8": 0,
    "Dublin 15": 0,
    total: 0,
  };

  getDeliveryItemsInRange(items, startYmd, endYmd).forEach((item) => {
    const qty = Number(item?.delivery_count || 0);
    const loc = safeText(item?.location || "");
    split.total += qty;
    if (loc === "Dublin 8") split["Dublin 8"] += qty;
    else if (loc === "Dublin 15") split["Dublin 15"] += qty;
  });

  return split;
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

async function loadBankHolidayYear(year) {
  const y = Number(year || 0);
  if (!Number.isFinite(y) || y <= 0) return [];
  if (BANK_HOLIDAY_YEAR_CACHE.has(y)) return BANK_HOLIDAY_YEAR_CACHE.get(y);

  try {
    const rows = await api(`/api/bank-holidays/year/${y}`);
    const list = Array.isArray(rows) ? rows : [];
    BANK_HOLIDAY_YEAR_CACHE.set(y, list);
    return list;
  } catch {
    BANK_HOLIDAY_YEAR_CACHE.set(y, []);
    return [];
  }
}

async function findUpcomingBankHoliday(today = todayYMD()) {
  const baseYear = Number(String(today || "").slice(0, 4)) || new Date().getFullYear();
  const years = [baseYear, baseYear + 1];
  const now = ymdToDateObj(today);
  let best = null;

  for (const year of years) {
    const rows = await loadBankHolidayYear(year);
    for (const row of rows) {
      if (!row?.applicable) continue;
      const rowDate = ymdToDateObj(row?.date || "");
      if (!rowDate || rowDate < now) continue;
      if (!best || rowDate < best.dateObj) {
        best = { ...row, dateObj: rowDate };
      }
    }
  }

  return best;
}

function getRosterDayForDate(rosterWeek, ymd) {
  const days = Array.isArray(rosterWeek?.days) ? rosterWeek.days : [];
  return days.find((day) => day?.work_date === ymd) || null;
}

function getNextRosterShift(rosterWeek, today = todayYMD(), includeToday = true) {
  const days = Array.isArray(rosterWeek?.upcomingDays)
    ? rosterWeek.upcomingDays
    : (Array.isArray(rosterWeek?.days) ? rosterWeek.days : []);
  const searchFrom = includeToday ? today : ymdAddDays(today, 1);
  const searchRaw = Number(String(searchFrom).replace(/-/g, ""));
  const tomorrow = ymdAddDays(today, 1);
  const tomorrowDay = rosterWeek?.tomorrowDay || days.find((day) => day?.work_date === tomorrow) || null;
  const futureDays = days.filter((day) => Number(String(day?.work_date || "").replace(/-/g, "")) >= searchRaw);
  const rosterNext = rosterWeek?.nextShift || null;
  const rosterNextRaw = rosterNext?.work_date ? Number(String(rosterNext.work_date).replace(/-/g, "")) : null;
  const nextWorkingDay = rosterNext && Number.isFinite(rosterNextRaw) && rosterNextRaw >= searchRaw
    ? rosterNext
    : futureDays.find((day) => !day?.day_off && day?.shift_in && day?.shift_out) || null;
  return { tomorrowDay, nextWorkingDay };
}

function coachShiftRange(day) {
  if (!day?.shift_in || !day?.shift_out) return "";
  return `${fmtHHMM(day.shift_in)} \u2192 ${fmtHHMM(day.shift_out)}`;
}

function coachRosterDayLabel(ymd, today = todayYMD()) {
  if (!ymd) return "";
  if (ymd === today) return "Today";
  if (ymd === ymdAddDays(today, 1)) return "Tomorrow";
  return weekdayLong(ymdToDateObj(ymd));
}

function coachRosterOffTitle(day, today = todayYMD()) {
  const label = coachRosterDayLabel(day?.work_date, today) || "Tomorrow";
  const status = String(day?.status || "").toUpperCase();
  if (status === "BANK_HOLIDAY") return `${label} bank holiday`;
  if (status === "HOLIDAY") return `${label} holiday`;
  return `${label} off`;
}

function coachToneClass(tone) {
  return ["good", "warning", "bad"].includes(tone) ? tone : "neutral";
}

function buildHomeCoachCards(home, dash, todayRoster, rosterWeek, upcomingBh) {
  const reportTotals = home?.week?.totals || {};
  const actualMinutes = Number(reportTotals.total_minutes ?? parseHHMMToMinutes(dash?.this_week?.hhmm || "00:00") ?? 0);
  const earnedPay = Number(reportTotals.total_pay ?? dash?.this_week?.pay_eur ?? 0);
  const rate = Number(dash?.this_week?.hourly_rate ?? ME?.hourly_rate ?? getSavedRate() ?? 0);
  const rosterTotalMinutes = Number(rosterWeek?.totalMinutes ?? 0);
  const rosterPlannedSoFarMinutes = Number(rosterWeek?.scheduledSoFarMinutes ?? 0);
  const expectedWeeklyPay = rosterTotalMinutes > 0 && Number.isFinite(rate) && rate > 0
    ? (rosterTotalMinutes / 60) * rate
    : 0;
  const expectedSoFarPay = expectedWeeklyPay > 0 && rosterTotalMinutes > 0
    ? expectedWeeklyPay * (rosterPlannedSoFarMinutes / rosterTotalMinutes)
    : 0;
  const weeklyRemainingPay = Math.max(0, expectedWeeklyPay - earnedPay);
  const weeklyRemainingHours = Math.max(0, rosterTotalMinutes - actualMinutes);
  const todayShift = todayRoster || rosterWeek?.todayDay || null;
  const shiftIn = safeText(todayShift?.shift_in || "");
  const shiftOut = safeText(todayShift?.shift_out || "");
  const hasShift = !!shiftIn && !!shiftOut && !todayShift?.day_off;
  const activeToday = !!CLOCK?.in_time && !CLOCK?.out_time;
  const finishedToday = !!CLOCK?.out_time;
  const breakRunning = !!CLOCK?.break_running;
  const breakMinutes = Number(CLOCK?.break_minutes || 0);
  const todayRemainingMinutes = activeToday && hasShift && shiftOut
    ? Math.max(0, hhmmToMinutes(shiftOut) - dublinNowMinutes())
    : 0;
  const deliveriesToday = getTodayDeliveriesDone();
  const deliveriesStats = home?.deliveries || DELIVERY_STATE || null;
  const deliveriesItems = Array.isArray(deliveriesStats?.items) ? deliveriesStats.items : [];
  const deliveriesWeek = Number(deliveriesStats?.week?.total ?? 0);
  const deliveriesRecord = getDeliveryRecordWeek(deliveriesItems);
  const deliveryWeekWindow = getDeliveryWeekWindow(todayYMD());
  const deliveriesWeekSplit = getDeliveryLocationSplit(deliveriesItems, deliveryWeekWindow.startYmd, deliveryWeekWindow.endYmd);
  const paceDiff = earnedPay - expectedSoFarPay;
  const rosterShiftInfo = getNextRosterShift(rosterWeek, todayYMD(), !finishedToday);
  const tomorrowDay = rosterShiftInfo.tomorrowDay;
  const nextWorkingDay = rosterShiftInfo.nextWorkingDay;
  const bhRemaining = Number(dash?.bank_holidays?.remaining ?? 0);
  const bhLabel = upcomingBh?.date ? formatCoachDateLabel(upcomingBh.date) : "";

  const cards = [];

  const todayTone = activeToday ? (breakRunning ? "warning" : "good") : (finishedToday ? "neutral" : "neutral");
  const todayBadge = activeToday ? (breakRunning ? "BREAK" : "LIVE") : finishedToday ? "DONE" : todayShift?.day_off ? "OFF" : "TODAY";
  const todayTitle = todayShift?.day_off
    ? "Day off today"
    : activeToday
      ? (breakRunning ? `On break since ${fmtHHMM(CLOCK.in_time)}` : `Clocked in ${fmtHHMM(CLOCK.in_time)}`)
      : finishedToday
        ? `Clocked out ${fmtHHMM(CLOCK.out_time)}`
        : hasShift
          ? `Today: ${coachShiftRange(todayShift)}`
          : "Today tracking";
  const todayLine = todayShift?.day_off
    ? "No clocking needed"
    : activeToday
      ? `${formatCoachHours(todayRemainingMinutes)} left today`
      : finishedToday
        ? "Shift complete"
        : hasShift
          ? `${coachShiftRange(todayShift)} on roster`
          : "No shift loaded";
  const todaySub = todayShift?.day_off
    ? ""
    : activeToday
      ? (breakRunning
        ? (breakMinutes > 0 ? `Break logged ${formatCoachHours(breakMinutes)}` : "Break in progress")
        : hasShift
          ? `Ends ${fmtHHMM(shiftOut)}`
          : "")
      : finishedToday
        ? (breakMinutes > 0 ? `Break logged ${formatCoachHours(breakMinutes)}` : "")
        : hasShift
          ? `Shift starts ${fmtHHMM(shiftIn)}`
          : "";
  cards.push({
    key: "today",
    priority: activeToday || finishedToday || breakRunning ? 0 : 7,
    tone: coachToneClass(todayTone),
    badge: todayBadge,
    icon: activeToday ? "⏱" : todayShift?.day_off ? "☀" : "⏰",
    kicker: "Today tracking",
    title: todayTitle,
    line: todayLine,
    subline: todaySub,
  });

  if (expectedSoFarPay > 0) {
    cards.push({
      key: "pace",
      priority: 1,
      tone: coachToneClass(paceDiff < 0 ? "warning" : "good"),
      badge: paceDiff < 0 ? "BEHIND" : paceDiff > 0 ? "AHEAD" : "PACE",
      icon: paceDiff < 0 ? "↘" : paceDiff > 0 ? "↗" : "≈",
      kicker: "Pace check",
      title: paceDiff < 0
        ? "You're behind pace"
        : paceDiff > 0
          ? "You're ahead"
          : "Right on pace",
      line: paceDiff < 0
        ? `-${fmtEUR(Math.abs(paceDiff))} vs expected`
        : paceDiff > 0
          ? `+${fmtEUR(paceDiff)} above target`
          : "Exactly where the roster expects",
      subline: rosterPlannedSoFarMinutes > 0 ? `${formatCoachHours(rosterPlannedSoFarMinutes)} planned so far` : "",
    });
  } else {
    cards.push({
      key: "pace",
      priority: 20,
      tone: "neutral",
      badge: "PACE",
      icon: "↗",
      kicker: "Pace check",
      title: "Roster pace is not set yet",
      line: "Add a roster to compare progress",
      subline: "",
    });
  }

  cards.push({
    key: "money",
    priority: 2,
    tone: coachToneClass(expectedWeeklyPay > 0 && weeklyRemainingPay <= 0 ? "good" : "neutral"),
    badge: "WEEK",
    icon: "€",
    kicker: "Weekly money",
    title: expectedWeeklyPay > 0
      ? `You've earned ${fmtEUR(earnedPay)} of ${fmtEUR(expectedWeeklyPay)}`
      : `You've earned ${fmtEUR(earnedPay)} this week`,
    line: expectedWeeklyPay > 0
      ? `${fmtEUR(weeklyRemainingPay)} left this week`
      : "Weekly report total",
    subline: rosterTotalMinutes > 0 ? `${formatCoachHours(actualMinutes)} worked • ${formatCoachHours(rosterTotalMinutes)} rostered` : "",
  });

  cards.push({
    key: "hours",
    priority: 3,
    tone: coachToneClass(rosterTotalMinutes > 0 && weeklyRemainingHours <= 0 ? "good" : "neutral"),
    badge: "HOURS",
    icon: "⏳",
    kicker: "Weekly hours",
    title: rosterTotalMinutes > 0
      ? `${formatCoachHours(actualMinutes)} done of ${formatCoachHours(rosterTotalMinutes)}`
      : `${formatCoachHours(actualMinutes)} worked`,
    line: rosterTotalMinutes > 0
      ? `${formatCoachHours(weeklyRemainingHours)} left this week`
      : "No roster target yet",
    subline: earnedPay > 0 ? `${fmtEUR(earnedPay)} earned so far` : "",
  });

  cards.push({
    key: "deliveries",
    priority: 4,
    tone: "neutral",
    badge: deliveriesRecord.total > 0 && deliveriesWeek >= deliveriesRecord.total ? "RECORD" : "DELIVERIES",
    icon: "🚚",
    kicker: "Deliveries",
    title: `Today: ${deliveriesToday} deliveries`,
    line: `${deliveriesWeek} this week`,
    subline: "",
    chips: [
      {
        label: `Dublin 8: ${deliveriesWeekSplit["Dublin 8"]}`,
        tone: "blue",
        title: `Dublin 8 this week: ${deliveriesWeekSplit["Dublin 8"]}`,
      },
      {
        label: `Dublin 15: ${deliveriesWeekSplit["Dublin 15"]}`,
        tone: "violet",
        title: `Dublin 15 this week: ${deliveriesWeekSplit["Dublin 15"]}`,
      },
    ],
  });

  if (!rosterWeek) {
    cards.push({
      key: "shift",
      priority: 5,
      tone: "warning",
      badge: "ROSTER",
      icon: "📅",
      kicker: "Next shift",
      title: "No roster for this week",
      line: "Add your roster to plan ahead",
      subline: "",
    });
  } else if (nextWorkingDay) {
    const nextLabel = coachRosterDayLabel(nextWorkingDay.work_date, todayYMD());
    const nextLine = `${nextLabel} ${coachShiftRange(nextWorkingDay)}`;
    const tomorrowIsOff = !!tomorrowDay?.day_off && tomorrowDay?.work_date !== nextWorkingDay?.work_date;
    cards.push({
      key: "shift",
      priority: 5,
      tone: coachToneClass("neutral"),
      badge: "NEXT",
      icon: "📅",
      kicker: "Next shift",
      title: tomorrowIsOff ? coachRosterOffTitle(tomorrowDay, todayYMD()) : "Next shift",
      line: tomorrowIsOff ? `Next shift: ${nextLine}` : nextLine,
      subline: tomorrowIsOff ? "Enjoy the day off in between" : "Ready for the next working day",
    });
  } else {
    cards.push({
      key: "shift",
      priority: 5,
      tone: coachToneClass("warning"),
      badge: "ROSTER",
      icon: "📅",
      kicker: "Next shift",
      title: "No more shifts this week",
      line: "Enjoy your time off",
      subline: "",
    });
  }

  cards.push({
    key: "bank-holiday",
    priority: 6,
    tone: coachToneClass(upcomingBh ? "neutral" : "warning"),
    badge: "BH",
    icon: "☘",
    kicker: "Bank holiday",
    title: upcomingBh?.date ? `Next BH: ${bhLabel}` : "Bank holiday reminder",
    line: Number.isFinite(bhRemaining) && bhRemaining >= 0
      ? `You have ${bhRemaining} remaining`
      : "BH allowance unavailable",
    subline: upcomingBh
      ? (upcomingBh.paid ? "Already marked paid" : "Don't forget to mark it")
      : "No upcoming bank holiday found",
  });

  return cards.sort((a, b) => (a.priority - b.priority) || a.key.localeCompare(b.key));
}

function clearHomeCoachTimer() {
  if (HOME_COACH_STATE.timer) clearTimeout(HOME_COACH_STATE.timer);
  HOME_COACH_STATE.timer = null;
}

function scheduleHomeCoachRotation(delay = 5000) {
  clearHomeCoachTimer();
  if (!HOME_COACH_STATE.cards || HOME_COACH_STATE.cards.length <= 1) return;

  const waitMs = Math.max(500, Number(delay || 5000));
  HOME_COACH_STATE.timer = window.setTimeout(() => {
    const now = Date.now();
    if (now < HOME_COACH_STATE.pauseUntil) {
      scheduleHomeCoachRotation(Math.max(500, HOME_COACH_STATE.pauseUntil - now));
      return;
    }
    advanceHomeCoach(1, true);
  }, waitMs);
}

function pauseHomeCoachRotation(ms = 12000) {
  HOME_COACH_STATE.pauseUntil = Math.max(HOME_COACH_STATE.pauseUntil, Date.now() + Math.max(1000, Number(ms || 0)));
  scheduleHomeCoachRotation(5000);
}

function renderHomeCoachDots() {
  if (!homeCoachDots) return;

  const cards = HOME_COACH_STATE.cards || [];
  homeCoachDots.innerHTML = "";
  homeCoachDots.classList.toggle("hidden", cards.length <= 1);

  if (homeCoachHint) {
    homeCoachHint.textContent = cards.length > 1 ? "Swipe for more" : "Insight ready";
  }

  if (cards.length <= 1) return;

  cards.forEach((card, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `homeCoachDot${index === HOME_COACH_STATE.index ? " is-active" : ""}`;
    btn.setAttribute("aria-label", `Show insight ${index + 1} of ${cards.length}`);
    btn.addEventListener("click", () => {
      pauseHomeCoachRotation(12000);
      goToHomeCoach(index, true);
    });
    homeCoachDots.appendChild(btn);
  });
}

function renderHomeCoachCard(card, animate = true) {
  const hero = homeCoachHero;
  if (!hero || !homeCoachTitle || !homeCoachLine || !homeCoachChip || !homeCoachIcon || !homeCoachSub) return;

  const fallback = card || {
    key: "fallback",
    tone: "neutral",
    badge: "READY",
    icon: "⚡",
    kicker: "Weekly progress coach",
    title: "Ready to start your shift?",
    line: "Loading weekly progress…",
    subline: "",
  };

  hero.classList.remove("is-coach-neutral", "is-coach-good", "is-coach-warning", "is-coach-bad");
  hero.classList.add(`is-coach-${coachToneClass(fallback.tone)}`);
  hero.dataset.cardKey = fallback.key || "";

  homeCoachIcon.textContent = fallback.icon || "⚡";
  const kickerEl = hero.querySelector(".homeHeroKicker");
  if (kickerEl) kickerEl.textContent = fallback.kicker || "Weekly progress coach";
  homeCoachTitle.textContent = fallback.title || "";
  homeCoachLine.textContent = fallback.line || "";
  homeCoachSub.textContent = fallback.subline || "";
  homeCoachSub.classList.toggle("hidden", !fallback.subline);
  homeCoachChip.textContent = fallback.badge || "READY";

  if (homeCoachChips) {
    const chips = Array.isArray(fallback.chips) ? fallback.chips : [];
    homeCoachChips.innerHTML = "";
    homeCoachChips.classList.toggle("hidden", chips.length === 0);
    chips.forEach((chip) => {
      const el = document.createElement("span");
      const toneClass = chip?.tone ? ` homeCoachSplitChip--${String(chip.tone)}` : "";
      el.className = `homeCoachSplitChip${toneClass}`;
      el.textContent = chip?.label || "";
      if (chip?.title) el.title = chip.title;
      homeCoachChips.appendChild(el);
    });
  }

  if (animate && homeCoachPane) {
    homeCoachPane.classList.remove("is-animating");
    void homeCoachPane.offsetWidth;
    homeCoachPane.classList.add("is-animating");
    window.setTimeout(() => homeCoachPane?.classList.remove("is-animating"), 280);
  }

  renderHomeCoachDots();
}

function goToHomeCoach(index, animate = true) {
  const cards = HOME_COACH_STATE.cards || [];
  if (!cards.length) return;

  const nextIndex = ((Number(index) || 0) % cards.length + cards.length) % cards.length;
  HOME_COACH_STATE.index = nextIndex;
  renderHomeCoachCard(cards[nextIndex], animate);
  scheduleHomeCoachRotation(5000);
}

function advanceHomeCoach(step = 1, animate = true) {
  goToHomeCoach(HOME_COACH_STATE.index + Number(step || 0), animate);
}

async function updateHomeCoachCard(home, dash, todayRoster, rosterWeek) {
  if (!homeCoachHero || !homeCoachPane) return;

  const currentKey = HOME_COACH_STATE.cards?.[HOME_COACH_STATE.index]?.key || null;
  const upcomingBh = await findUpcomingBankHoliday(todayYMD());
  const cards = buildHomeCoachCards(home, dash, todayRoster, rosterWeek, upcomingBh);
  HOME_COACH_STATE.cards = cards;

  if (!cards.length) {
    renderHomeCoachCard(null, false);
    clearHomeCoachTimer();
    return;
  }

  const preservedIndex = currentKey
    ? cards.findIndex((card) => card.key === currentKey)
    : -1;
  HOME_COACH_STATE.index = preservedIndex >= 0 ? preservedIndex : 0;
  renderHomeCoachCard(cards[HOME_COACH_STATE.index], true);
  HOME_COACH_STATE.ready = true;
  scheduleHomeCoachRotation(5000);
}

function renderDeliveriesMiniCard(stats) {
  if (deliveriesWeekInline) {
    deliveriesWeekInline.textContent = String(stats?.week?.total ?? 0);
  }

  if (!deliveriesRecordBadge) return;

  const items = Array.isArray(stats?.items) ? stats.items : [];
  const weekTotal = Number(stats?.week?.total ?? 0);
  const record = getDeliveryRecordWeek(items);
  const isRecordWeek = weekTotal > 0 && record.total > 0 && weekTotal >= record.total;

  deliveriesRecordBadge.textContent = isRecordWeek ? "Record week" : "";
  deliveriesRecordBadge.classList.toggle("hidden", !isRecordWeek);
}

function bindHomeCoachInteractions() {
  if (!homeCoachHero || HOME_COACH_STATE.bound) return;
  HOME_COACH_STATE.bound = true;

  const clearPointer = () => {
    HOME_COACH_STATE.pointer = null;
  };

  homeCoachHero.addEventListener("pointerdown", (ev) => {
    HOME_COACH_STATE.pointer = {
      x: ev.clientX,
      y: ev.clientY,
      t: Date.now(),
    };
    pauseHomeCoachRotation(12000);
  });

  homeCoachHero.addEventListener("pointerup", (ev) => {
    const start = HOME_COACH_STATE.pointer;
    HOME_COACH_STATE.pointer = null;
    if (!start) return;

    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    const elapsed = Date.now() - start.t;
    if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.2 || elapsed > 800) return;

    ev.preventDefault();
    pauseHomeCoachRotation(12000);
    advanceHomeCoach(dx < 0 ? 1 : -1, true);
  });

  homeCoachHero.addEventListener("pointercancel", clearPointer);
  homeCoachHero.addEventListener("pointerleave", clearPointer);
  homeCoachHero.addEventListener("focusin", () => pauseHomeCoachRotation(12000));
  homeCoachHero.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowRight") {
      ev.preventDefault();
      pauseHomeCoachRotation(12000);
      advanceHomeCoach(1, true);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      pauseHomeCoachRotation(12000);
      advanceHomeCoach(-1, true);
    }
  });
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

function getBreakModeState() {
  const lengthSec = Math.max(1, Number(getLocalBreakLengthSec() || BREAK_DEFAULT_SEC));
  const startEpoch = getLocalBreakStart() || (() => {
    const endEpoch = getLocalBreakEnd();
    return endEpoch ? endEpoch - lengthSec * 1000 : 0;
  })();
  const endEpoch = getLocalBreakEnd() || (startEpoch ? startEpoch + lengthSec * 1000 : 0);
  const leftSec = Math.max(0, Math.ceil((endEpoch - Date.now()) / 1000));
  const elapsedSec = Math.max(0, Math.min(lengthSec, lengthSec - leftSec));
  const progress = Math.max(0, Math.min(100, (elapsedSec / lengthSec) * 100));
  return { lengthSec, startEpoch, endEpoch, leftSec, elapsedSec, progress };
}

function renderTodayBreakMode(state = null) {
  const s = state || getBreakModeState();
  if (todayEarnTitle) todayEarnTitle.textContent = "Break time";
  if (todayEarnSub) todayEarnSub.textContent = "Take your break - tracking resumes after End Break";
  if (todayEarnState) todayEarnState.textContent = "BREAK";
  if (todayEarnBreak) todayEarnBreak.classList.remove("hidden");
  if (todayBreakCountdown) todayBreakCountdown.textContent = `${fmtMMSS(s.leftSec)} left`;
  if (todayBreakStart) todayBreakStart.textContent = s.startEpoch ? fmtHHMMFromEpoch(s.startEpoch) : "--:--";
  if (todayBreakEnd) todayBreakEnd.textContent = s.endEpoch ? fmtHHMMFromEpoch(s.endEpoch) : "--:--";
  if (todayBreakProgress) todayBreakProgress.style.width = `${s.progress}%`;
  if (todayEarnCard) todayEarnCard.classList.add("is-break");
}

function clearTodayBreakMode() {
  if (todayEarnTitle) todayEarnTitle.textContent = "Today earnings";
  if (todayEarnSub) todayEarnSub.textContent = "";
  if (todayEarnBreak) todayEarnBreak.classList.add("hidden");
  if (todayBreakCountdown) todayBreakCountdown.textContent = "60:00 left";
  if (todayBreakStart) todayBreakStart.textContent = "--:--";
  if (todayBreakEnd) todayBreakEnd.textContent = "--:--";
  if (todayBreakProgress) todayBreakProgress.style.width = "0%";
  if (todayEarnCard) todayEarnCard.classList.remove("is-break");
}

function updateTodayEarningsUI() {
  const tHHMM  = $("todayEarnHHMM");
  const tPAY   = $("todayEarnPay");
  const tSTATE = $("todayEarnState");
  const tSub   = todayEarnSub;
  const tCard  = document.getElementById("todayEarnCard");
  const tLive   = tCard?.querySelector(".teGrid.teGrid--2");
  const tSummary = $("todayEarnSummary");
  const tDayHours = $("todayEarnDayHours");
  const tDayEarned = $("todayEarnDayEarned");
  const tDayDeliveries = $("todayEarnDayDeliveries");
  const tWeekTotal = $("todayEarnWeekTotal");
  const tWeekHours = $("todayEarnWeekHours");
  const tExpected = $("todayEarnExpected");
  const hasWeek = !!CLOCK?.has_week;
  const hasIn = !!CLOCK?.in_time;
  const hasOut = !!CLOCK?.out_time;
  const onBreak = hasWeek && hasIn && !hasOut && (!!CLOCK?.break_running || hasActiveLocalBreak());
  const isLive =
    hasWeek &&
    hasIn &&
    !hasOut &&
    !onBreak;
  const isSummary = hasWeek && hasIn && hasOut;
  const isIdle = !hasWeek || !hasIn;

  if (tCard) tCard.classList.toggle("is-live", isLive);
  if (tCard) tCard.classList.toggle("is-summary", isSummary);
  if (tCard) tCard.classList.toggle("is-break", onBreak);
  if (tLive) tLive.classList.toggle("hidden", isSummary);
  if (tSummary) tSummary.classList.toggle("hidden", !isSummary);
  if (!onBreak) clearTodayBreakMode();

  setClockActionButtonVisual(btnIn, "pill--green", !isIdle);
  setClockActionButtonVisual(btnOut, isLive ? "pill--red" : "pill--gray", !isLive);
  setClockActionButtonVisual(btnBreak, (isLive || onBreak) ? "pill--orange" : "pill--gray", !(isLive || onBreak));
  setBreakButtonRunning(onBreak);

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
    if (tSub) {
      tSub.textContent = hasOut
        ? `Shift ended at ${fmtHHMM(CLOCK.out_time)}`
        : "Shift complete";
    }
    return;
  }

  if (!tHHMM || !tPAY) return;

  if (isIdle) {
    tHHMM.textContent = "--:--:--";
    tPAY.textContent  = "€-.--";
    if (tSTATE) tSTATE.textContent = "OFF";
    if (tSub) tSub.textContent = "Tap IN to start.";
    stopLiveTicker();
    return;
  }

  if (onBreak) {
    renderTodayBreakMode();
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
    if (tSub) tSub.textContent = "Add your hourly rate in Profile.";
    stopLiveTicker();
    return;
  }

  if (hasOut) {
    if (tSTATE) tSTATE.textContent = "DONE";
    if (tSub) tSub.textContent = `Shift ended at ${fmtHHMM(CLOCK.out_time)}`;
    stopLiveTicker();
  } else {
    if (tSTATE) tSTATE.textContent = "LIVE";
    if (tSub) tSub.textContent = `Clocked in at ${fmtHHMM(CLOCK.in_time)}`;
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
async function refreshClock(clockOverride) {
  try {
    let c;
    if (typeof clockOverride === "undefined") c = await api("/api/clock/today");
    else c = clockOverride;
    if (!c) {
      c = {
        ok: true,
        has_week: true,
        in_time: null,
        out_time: null,
        break_minutes: 0,
        break_running: false,
      };
    }

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
async function refreshCurrentWeekTotalsSafe(reportOverride) {
  try {
    const rep = typeof reportOverride === "undefined"
      ? await api("/api/report/week/current")
      : reportOverride;
    if (!rep || rep?.has_week === false || rep?.ok === false) {
      if (cwHHMM) cwHHMM.textContent = "00:00";
      if (cwPay)  cwPay.textContent  = fmtEUR(0);
      return;
    }

    const hhmm =
      rep?.totals?.total_hhmm ??
      rep?.totals?.hhmm ??
      rep?.totals?.hours_hhmm ??
      rep?.hhmm ??
      rep?.hours_hhmm ??
      "00:00";

    const pay =
      rep?.totals?.total_pay ??
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
  let home = null;
  try {
    home = await api("/api/home");
    if (home?.dashboard) LAST_DASH = home.dashboard;
    if (home?.clock) CLOCK = home.clock;
    if (home?.deliveries) {
      DELIVERY_STATE = home.deliveries;
      DELIVERY_PAGE_STATE.stats = home.deliveries;
    }
    if (typeof home?.today_multiplier !== "undefined") {
      window.TODAY_MULT = Number(home.today_multiplier || 1);
      _todayMultCache = { ymd: todayYMD(), value: window.TODAY_MULT };
    }
  } catch (e) {
    if (e?.status === 401) { await enterLogin(); return; }
    showToast("Connection error — data may be outdated", "error");
  }

  const dash = home?.dashboard || LAST_DASH;

  DASH_WEEK_ID =
    dash?.this_week?.id ||
    dash?.this_week?.week_id ||
    null;

  if (cwWeekNo) {
    cwWeekNo.textContent =
      dash?.this_week?.week_number ? String(dash.this_week.week_number) : "--";
  }

  const paid = Number(dash?.bank_holidays?.paid ?? 0);
  const remaining = Number(dash?.bank_holidays?.remaining ?? 0);
  if (bhPaid)   bhPaid.textContent   = String(paid);
  if (bhRemain) bhRemain.textContent = String(remaining);

  if (home) {
    await refreshClock(home?.clock ?? null);
    await refreshCurrentWeekTotalsSafe(home?.week ?? null);
  }

  const rosterSummary = home?.roster_summary || null;
  const todayRoster = rosterSummary?.current_day || rosterSummary || null;
  const rosterWeek = rosterSummary?.week || null;
  const rosterExists = !!todayRoster?.has_roster;
  const rosterBannerHost = $("noRosterBannerHost");

  if (rosterBannerHost && home) {
    const weekNo = Number(dash?.this_week?.week_number ?? home?.week?.week?.week_number ?? tescoWeekNumber(new Date()));
    if (rosterExists) {
      rosterBannerHost.innerHTML = "";
    } else {
      rosterBannerHost.innerHTML = `
        <div id="noRosterBanner" style="
          background:#FAEEDA; color:#633806;
          border:0.5px solid #EF9F27;
          border-radius:10px; padding:10px 14px;
          font-size:13px; margin:8px 0; cursor:pointer;
          display:flex; align-items:center; gap:8px;">
          <span>⚠</span>
          <span>No roster for week ${Number.isFinite(weekNo) && weekNo > 0 ? weekNo : "--"} — tap to create</span>
        </div>`;
      const rosterBanner = $("noRosterBanner");
      if (rosterBanner && !rosterBanner.dataset.bound) {
        rosterBanner.dataset.bound = "1";
        rosterBanner.addEventListener("click", () => go("/roster"));
      }
    }
  }

  await updateHomeCoachCard(home, dash, todayRoster, rosterWeek);

  if (deliveriesWeekInline) {
    const stats = home?.deliveries || DELIVERY_STATE;
    if (stats) renderDeliveriesMiniCard(stats);
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
    showToast("Add Hour Rate First. Go to Profile → Hourly Rate.", "error");
    window.setTimeout(() => go("/profile"), 250);
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

async function doClockIn(ev) {
  if (clockActionInProgress) return;
  clockActionInProgress = true;
  const btn = ev?.currentTarget || btnIn || null;
  setClockActionButtonBusy(btn, true);
  try {

    // 1️⃣ CHECK HOURLY RATE
    const me = await api("/api/me");
    const rate = Number(me?.hourly_rate || 0);

    if (!rate || rate <= 0) {
      showToast("Add Hour Rate First. Go to Profile → Hourly Rate.", "error");
      window.setTimeout(() => go("/profile"), 250);
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
    showToast("Clocked in.", "success");

  } catch (e) {
    showToast(e?.message || "IN failed", "error");
  } finally {
    clockActionInProgress = false;
    setClockActionButtonBusy(btn, false);
  }
}



async function doClockOut(ev) {
  if (clockActionInProgress) return;
  clockActionInProgress = true;
  const btn = ev?.currentTarget || btnOut || null;
  setClockActionButtonBusy(btn, true);
  try {
    const r = await api("/api/clock/out", { method: "POST" });

    if (r?.needs_extra_confirm) {
      const decision = await handleOvertimePrompt(r);
      if (!decision.proceed) return;
      await api("/api/clock/out", { method: "POST" });
    }

    await refreshAll();
    showToast("Clocked out.", "success");
  } catch (e) {
    showToast(e?.message || "OUT failed", "error");
  } finally {
    clockActionInProgress = false;
    setClockActionButtonBusy(btn, false);
  }
}

async function doClockBreak(ev) {
  if (clockActionInProgress) return;
  clockActionInProgress = true;
  const btn = ev?.currentTarget || btnBreak || null;
  setClockActionButtonBusy(btn, true);
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
      showToast("Break started.", "success");
      return;
    }

    // STOP (PAUSE)
    const leftSec = getLocalBreakLeftSec();
    if (leftSec > 0) localStorage.setItem(LS_BREAK_LEFT, String(leftSec));
    else localStorage.removeItem(LS_BREAK_LEFT);

    stopBreakCountdown(false);
    await refreshAll();
    showToast("Break paused.", "success");

  } catch (e) {
    showToast(e?.message || "BREAK failed", "error");
  } finally {
    clockActionInProgress = false;
    setClockActionButtonBusy(btn, false);
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

    showToast("Week created.", "success");
    await new Promise((resolve) => setTimeout(resolve, 250));
    go("/");
  } catch (e) {
    if (addWeekMsg) addWeekMsg.textContent = e.message || "Failed to create week";
    showToast(e.message || "Failed to create week", "error");
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
    showToast("Deliveries saved.", "success");
    const dayCard = document.querySelector(".deliveryDayCard");
    if (dayCard) {
      dayCard.classList.add("is-savedFlash");
      setTimeout(() => dayCard.classList.remove("is-savedFlash"), 900);
    }
    await refreshDeliveriesPage();
  } catch (e) {
    if (els.msg) els.msg.textContent = e.message || "Failed to save deliveries";
    showToast(e.message || "Failed to save deliveries", "error");
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
    showToast("Settings saved.", "success");
  } catch (e) {
    if (els.msg) els.msg.textContent = e.message || "Failed to save settings";
    showToast(e.message || "Failed to save settings", "error");
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
  if (window.__WH_BOTTOM_NAV_BOUND__) return;
  window.__WH_BOTTOM_NAV_BOUND__ = true;

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
    const route = btn.getAttribute("data-active-route") || btn.getAttribute("data-route");
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

  bindHomeCoachInteractions();

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

