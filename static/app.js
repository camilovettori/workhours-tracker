/* =========================
   Work Hours Tracker - app.js (v14)
   FIXES:
   ✅ Removes stray debug PATCH that was breaking /roster
   ✅ Fixes undefined rosterId reference
   ✅ Adds missing doClockBreak()
   ✅ Keeps overtime prompt flow (DAY OFF + tolerance)
   ✅ Keeps: Login, Home, Add-week, Roster page
========================= */

console.log("app.js loaded ✅");

const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");

/* =====================================================
   Navigation – Home cards / buttons
   Bank Holidays
===================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // Procura qualquer elemento que tenha data-route
  document.querySelectorAll("[data-route]").forEach((el) => {
    el.addEventListener("click", () => {
      const route = el.getAttribute("data-route");
      if (route) {
        window.location.href = route;
      }
    });
  });

  // Botão direto (caso exista)
  const btnHolidays = document.getElementById("btnHolidays");
  if (btnHolidays) {
    btnHolidays.addEventListener("click", () => {
      window.location.href = "/holidays";
    });
  }
});

/* =========================
   Utils
========================= */

function isoWeekNumber(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function weekStartMondayISO(d = new Date()) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay() || 7; // Sun=0 -> 7
  date.setDate(date.getDate() - (day - 1)); // back to Monday
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getSavedRate() {
  const v = Number(localStorage.getItem("hourly_rate") || 0);
  return v > 0 ? v : 18.24; // default
}

function saveRate(rate) {
  const v = Number(rate || 0);
  if (v > 0) localStorage.setItem("hourly_rate", String(v));
}

// cria week se não existir
async function ensureWeekExistsForClock() {
  const c = await api("/api/clock/today");
  if (c?.has_week) return c;

  const payload = {
    week_number: isoWeekNumber(new Date()),
    start_date: weekStartMondayISO(new Date()),
    hourly_rate: getSavedRate(),
  };

  // endpoint esperado (mesmo usado pelo Add Week page)
  const created = await api("/api/weeks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // depois de criar, pega o clock de novo
  return await api("/api/clock/today");
}

function fmtEUR(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString(undefined, { style: "currency", currency: "EUR" });
  } catch {
    return `€${v.toFixed(2)}`;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });

  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    const msg =
      data && data.detail
        ? data.detail
        : typeof data === "string"
        ? data
        : "Request failed";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string" || !hhmm.includes(":")) return 0;
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function todayYMD() {
  const t = new Date();
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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
  const diff = day === 0 ? -6 : 1 - day; // go back to Monday
  x.setDate(x.getDate() + diff);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function go(path) {
  window.location.href = path;
}

function pathIs(p) {
  return window.location.pathname === p;
}

/* ===== date helpers for roster ===== */
function ymdAddDays(ymd, add) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + Number(add || 0));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function weekdayShort(dt) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
}
function ymdToDateObj(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function codeToLabel(code) {
  if (code === "A") return "09:45 → 19:00";
  if (code === "B") return "10:45 → 20:00";
  return "OFF";
}

/* =========================
   Views (index.html only)
========================= */
const viewLogin = $("viewLogin");
const viewHome = $("viewHome");
const viewAddWeek = $("viewAddWeek");

function hideAllViews() {
  hide(viewLogin);
  hide(viewHome);
  hide(viewAddWeek);
}

/* =========================
   Login UI
========================= */
const loginForm = $("loginForm");
const loginEmail = $("loginEmail");
const loginPassword = $("loginPassword");
const loginRemember = $("loginRemember");
const loginMsg = $("loginMsg");

const signupForm = $("signupForm");
const suFirst = $("suFirst");
const suLast = $("suLast");
const suEmail = $("suEmail");
const suPassword = $("suPassword");
const signupMsg = $("signupMsg");

const btnForgot = $("btnForgot");
const forgotPanel = $("forgotPanel");
const forgotEmail = $("forgotEmail");
const btnSendReset = $("btnSendReset");
const forgotMsg = $("forgotMsg");

const btnShowSignup = $("btnShowSignup");
const btnShowLogin = $("btnShowLogin");

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

/* =========================
   Home UI
========================= */
const welcomeName = $("welcomeName");
const btnLogout = $("btnLogout");
const btnOpenProfile = $("btnOpenProfile");



const btnAddWeek = $("btnAddWeek");

// Current week
const cwHHMM = $("cwHHMM");
const cwPay = $("cwPay");
const btnIn = $("btnIn");
const btnOut = $("btnOut");
const btnBreak = $("btnBreak");
const cwIn = $("cwIn");
const cwOut = $("cwOut");
const cwBreak = $("cwBreak");
const cwStatusText = $("cwStatusText");


// Bank holidays

const bhPaid = $("bhPaid");
const bhRemain = $("bhRemain");

// Cards click
const cardHolidays = $("cardHolidays");
const cardReports = $("cardReports");

// Nav
const navHome = $("navHome");
const navHistory = $("navHistory");
const navHolidays = $("navHolidays");
const navReports = $("navReports");
const navProfile = $("navProfile");

/* =========================
   Add Week UI (page)
========================= */
const btnBackAddWeek = $("btnBackAddWeek");
const addWeekForm = $("addWeekForm");
const awWeekNumber = $("awWeekNumber");
const awStartDate = $("awStartDate");
const awHourlyRate = $("awHourlyRate");
const addWeekMsg = $("addWeekMsg");

/* =========================
   State
========================= */
let UI_DAY = todayYMD();
let CURRENT_WEEK_ID = null;
let CLOCK = null;

/* =========================
   Break countdown (UI)
========================= */
let breakTick = null;
let breakRemaining = 0;
let breakRunningUI = false;

const BREAK_DEFAULT_SEC = 60 * 60; // 60 minutes
const LS_BREAK_END = "wh_break_end_epoch";
const LS_BREAK_DAY = "wh_break_day";

function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtMMSS(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}
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
}
function stopBreakCountdown(vibrate = false) {
  if (breakTick) clearInterval(breakTick);
  breakTick = null;

  breakRunningUI = false;
  breakRemaining = 0;

  clearBreakStorage();
  setBreakButtonRunning(false);

  if (cwBreak && CLOCK) {
    cwBreak.textContent = `${Number(CLOCK.break_minutes || 0)}m`;
  }

  if (vibrate && "vibrate" in navigator) {
    navigator.vibrate([200, 100, 200]);
  }
}
function tickBreakCountdown() {
  const endEpoch = Number(localStorage.getItem(LS_BREAK_END) || "0");
  if (!endEpoch) {
    stopBreakCountdown(false);
    return;
  }

  const leftSec = Math.ceil((endEpoch - Date.now()) / 1000);
  breakRemaining = leftSec;

  if (cwBreak) cwBreak.textContent = fmtMMSS(leftSec);

  if (leftSec <= 0) {
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
function resumeBreakCountdownIfAny() {
  const savedDay = localStorage.getItem(LS_BREAK_DAY);
  const endEpoch = Number(localStorage.getItem(LS_BREAK_END) || "0");

  if (!savedDay || savedDay !== UI_DAY || !endEpoch) {
    clearBreakStorage();
    return;
  }

  const leftSec = Math.ceil((endEpoch - Date.now()) / 1000);
  if (leftSec > 0) startBreakCountdown(leftSec);
  else clearBreakStorage();
}
function resetTodayVisual() {
  if (cwIn) cwIn.textContent = "00:00";
  if (cwOut) cwOut.textContent = "00:00";
  if (cwBreak) cwBreak.textContent = "0m";
  setBreakButtonRunning(false);
  stopBreakCountdown(false);
}

/* =========================
   Day change watcher
========================= */
function watchDayChange() {
  const now = todayYMD();
  if (now !== UI_DAY) {
    UI_DAY = now;
    resetTodayVisual();
    refreshAll().catch(() => {});
    refreshTodayPay().catch(() => {});
  }
}

/* =========================
   Auth entry
========================= */
async function enterLogin() {
  hideAllViews();
  show(viewLogin);
  showLogin();
}

async function enterHome() {
  hideAllViews();
  show(viewHome);

  const me = await api("/api/me");
  const full = `${me.first_name || ""} ${me.last_name || ""}`.trim() || "User";
  if (welcomeName) welcomeName.textContent = full;

  await refreshAll();
  resumeBreakCountdownIfAny();
}

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
    await routeAfterAuth();
  } catch (e) {
    if (signupMsg) signupMsg.textContent = e.message || "Sign up failed";
  }
}

async function doLogout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {}
  await enterLogin();
}

/* =========================
   Forgot / reset (dev mode)
========================= */
async function sendReset() {
  clearAuthMsgs();

  const email = (forgotEmail?.value || "").trim();
  if (!email) {
    if (forgotMsg) forgotMsg.textContent = "Type your email.";
    return;
  }

  try {
    const r = await api("/api/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    });

    if (forgotMsg) {
      forgotMsg.style.color = "#0f172a";
      if (r && r.dev_reset_link) forgotMsg.textContent = `Reset link (dev): ${r.dev_reset_link}`;
      else forgotMsg.textContent = "If the email exists, you’ll receive a reset link.";
    }
  } catch (e) {
    if (forgotMsg) forgotMsg.textContent = e.message || "Failed";
  }
}

/* =========================
   Dashboard / Clock
========================= */


// NÃO redeclara: já existe em outro lugar
// let CLOCK = null;
// let CURRENT_WEEK_ID = null;

let CURRENT_RATE = 0;
let todayTicker = null;
let LAST_DASH = null;

let LIVE_TIMER = null;     // interval do “today earnings”
let LIVE_LAST_TS = 0;      // evita recalcular 1000x



function stopLiveTicker() {
  if (LIVE_TIMER) clearInterval(LIVE_TIMER);
  LIVE_TIMER = null;
}

function startLiveTicker() {
  stopLiveTicker();
  LIVE_TIMER = setInterval(() => {
    // só recalcula se faz sentido
    if (!CLOCK?.has_week) return;
    updateTodayEarningsUI();
  }, 1000);
}

function hhmmToMinutes(hhmm) {
  if (!hhmm || !String(hhmm).includes(":")) return 0;
  const [h, m] = String(hhmm).split(":").map(Number);
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

function updateTodayEarningsUI() {
  const tHHMM = document.getElementById("todayEarnHHMM");
  const tPAY  = document.getElementById("todayEarnPay");
  const tSTATE = document.getElementById("todayEarnState");

  if (!tHHMM || !tPAY) return;

  // se não tem week ou não deu IN ainda
  if (!CLOCK?.has_week || !CLOCK?.in_time) {
    tHHMM.textContent = "--:--";
    tPAY.textContent  = "€-.--";
    if (tSTATE) tSTATE.textContent = "OFF";
    stopLiveTicker();
    return;
  }

  const rate = Number(LAST_DASH?.this_week?.hourly_rate ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) {
    tHHMM.textContent = "--:--";
    tPAY.textContent  = "€-.--";
    if (tSTATE) tSTATE.textContent = "RATE?";
    stopLiveTicker();
    return;
  }

  // se está em break, congela (não sobe)
  if (CLOCK.break_running) {
    if (tSTATE) tSTATE.textContent = "BREAK";
    return;
  }

  // se já deu OUT, congela no valor final e para interval
  if (CLOCK.out_time) {
    if (tSTATE) tSTATE.textContent = "DONE";
    stopLiveTicker();
  } else {
    if (tSTATE) tSTATE.textContent = "LIVE";
  }

  // calcula minutos trabalhados (in -> now/out) - break_minutes acumulado
  const now = new Date();
  const [ih, im] = String(CLOCK.in_time).split(":").map(Number);
  const inDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ih || 0, im || 0, 0);

  let endDt = now;
  if (CLOCK.out_time) {
    const [oh, om] = String(CLOCK.out_time).split(":").map(Number);
    endDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), oh || 0, om || 0, 0);
  }

  let workedMin = Math.max(0, Math.floor((endDt - inDt) / 60000));
  const br = Number(CLOCK.break_minutes || 0);
  workedMin = Math.max(0, workedMin - br);

  const hh = String(Math.floor(workedMin / 60)).padStart(2, "0");
  const mm = String(workedMin % 60).padStart(2, "0");
  const eur = (workedMin / 60) * rate;

  tHHMM.textContent = `${hh}:${mm}`;
  tPAY.textContent  = fmtEUR(eur);
}

async function refreshAll() {
  // 1) Dashboard (week totals + BH totals)
  const dash = await api("/api/dashboard");
  LAST_DASH = dash;

  // Current week label + totals
  if (cwWeekNo) cwWeekNo.textContent = dash?.this_week?.week_number ? String(dash.this_week.week_number) : "--";
  //if (cwHHMM) cwHHMM.textContent = dash?.this_week?.hhmm || "--:--";//
  //if (cwPay)  cwPay.textContent  = fmtEUR(dash?.this_week?.pay_eur || 0);//

  // Bank Holidays (Paid / Not Paid)
  const paid = Number(dash?.bank_holidays?.paid ?? 0);
  const remaining = Number(dash?.bank_holidays?.remaining ?? 0);

  if (bhPaid)   bhPaid.textContent   = String(paid);
  if (bhRemain) bhRemain.textContent = String(remaining);

  // 2) Clock state (in/out/break)
  await refreshClock();
await refreshCurrentWeekTotals();

// hoje earnings
updateTodayEarningsUI();



  // 3) Atualiza UI do Today earnings + inicia ticker se necessário
  updateTodayEarningsUI();

  // ticker só roda quando: tem IN, não tem OUT, e não está em break
  if (CLOCK?.has_week && CLOCK?.in_time && !CLOCK?.out_time) startLiveTicker();
  else stopLiveTicker();
}

async function refreshClock() {
  try {
    const c = await api("/api/clock/today");
    CLOCK = c;

    if (!c.has_week) {
      CURRENT_WEEK_ID = null;

      if (cwIn) cwIn.textContent = "--:--";
      if (cwOut) cwOut.textContent = "--:--";
      if (cwBreak) cwBreak.textContent = "0m";
      if (cwStatusText) cwStatusText.textContent = "Create a week first.";

      setBreakButtonRunning(false);
      stopLiveTicker();
      return;
    }

    CURRENT_WEEK_ID = c.week_id;

    if (cwIn) cwIn.textContent = c.in_time || "--:--";
    if (cwOut) cwOut.textContent = c.out_time || "--:--";
    if (cwBreak) cwBreak.textContent = `${Number(c.break_minutes || 0)}m`;

    setBreakButtonRunning(!!c.break_running);

    if (cwStatusText) {
      if (!c.in_time) cwStatusText.textContent = "Tap IN to start.";
      else if (c.break_running) cwStatusText.textContent = "Break running…";
      else if (!c.out_time) cwStatusText.textContent = "Tracking live…";
      else cwStatusText.textContent = "Done for today ✅";
    }

  } catch (e) {
    if (e.status === 401) await enterLogin();
    stopLiveTicker();
  }
}

async function refreshCurrentWeekTotals() {
  if (!CURRENT_WEEK_ID) {
    if (cwHHMM) cwHHMM.textContent = "--:--";
    if (cwPay)  cwPay.textContent  = "€-.--";
    return;
  }

  try {
    const week = await api(`/api/weeks/${CURRENT_WEEK_ID}`);

    // week number (se quiser garantir aqui também)
    if (cwWeekNo) cwWeekNo.textContent = week?.week_number ? String(week.week_number) : "--";

    const rate = Number(week?.hourly_rate || 0);
    const entries = Array.isArray(week?.entries) ? week.entries : [];

    let totalMin = 0;
    let totalPay = 0;

    for (const e of entries) {
      const mins = hhmmToMinutes(e.worked_hhmm);
      const mult = Number(e.multiplier || 1.0);
      totalMin += mins;
      totalPay += (mins / 60) * rate * mult;
    }

    const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");

    if (cwHHMM) cwHHMM.textContent = `${hh}:${mm}`;
    if (cwPay)  cwPay.textContent  = fmtEUR(totalPay);
  } catch (e) {
    // fallback: não quebra a UI
    if (cwHHMM) cwHHMM.textContent = "--:--";
    if (cwPay)  cwPay.textContent  = "€-.--";
  }
}


/* =========================
   Overtime prompt (Yes/No)
========================= */
async function handleOvertimePrompt(resObj) {
  const reason = resObj.reason || "";
  const kind = resObj.kind || "";
  const work_date = resObj.work_date || todayYMD();

  let text = "";
  if (reason === "DAY_OFF") {
    text = "You are off today.\nOvertime Authorized? (Yes / No)";
  } else {
    text = "Overtime Authorized? (Yes / No)";
  }

  const yes = window.confirm(text); // OK=Yes / Cancel=No

  if (yes) {
    await api("/api/clock/extra-confirm", {
      method: "POST",
      body: JSON.stringify({ work_date, authorized: true }),
    });
    return { proceed: true, authorized: true, reason };
  } else {
    await api("/api/clock/extra-confirm", {
      method: "POST",
      body: JSON.stringify({ work_date, authorized: false }),
    });

    if (reason === "DAY_OFF") {
      alert("Overtime not authorized.");
      return { proceed: false, authorized: false, reason };
    }

    if (kind === "IN") alert("You are early (or late). You will not get paid.");
    else alert("Outside roster time. Extra will not be paid.");

    return { proceed: true, authorized: false, reason };
  }
}

/* =========================
   Clock actions
========================= */
async function doClockIn() {
  try {
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


async function doClockBreak() {
  try {
    const r = await api("/api/clock/break", { method: "POST" });

    // backend returns break_running true/false (+ break_minutes when stopping)
    if (r && r.break_running === true) {
      // Start local countdown (60 min default)
      startBreakCountdown(BREAK_DEFAULT_SEC);
    } else {
      // Stop local countdown, show minutes
      stopBreakCountdown(false);
      await refreshAll();
    }

    await refreshAll();
  } catch (e) {
    alert(e.message || "BREAK failed");
  }
}

/* =========================
   Add week page (no modal)
========================= */
function openAddWeekPage(defaultRate = 0) {
  hideAllViews();
  show(viewAddWeek);

  if (addWeekMsg) addWeekMsg.textContent = "";

  if (awWeekNumber) awWeekNumber.value = String(isoWeekNumber(new Date()));
  if (awStartDate) awStartDate.value = mondayOfThisWeek(new Date());
  if (awHourlyRate) awHourlyRate.value = String(Number(defaultRate || 0).toFixed(2));
}

function backFromAddWeek() {
  if (window.history.length > 1) window.history.back();
  else window.location.href = "/";
}

async function createWeekFromPage(ev) {
  ev.preventDefault();
  if (addWeekMsg) addWeekMsg.textContent = "";

  try {
    const week_number = Number(awWeekNumber?.value || 0);
    const start_date = (awStartDate?.value || "").trim();
    const hourly_rate = Number(awHourlyRate?.value || 0);

    await api("/api/weeks", {
      method: "POST",
      body: JSON.stringify({ week_number, start_date, hourly_rate }),
    });

    window.location.href = "/";
  } catch (e) {
    if (addWeekMsg) addWeekMsg.textContent = e.message || "Failed to create week";
  }
}

/* =========================
   ROSTER PAGE (/roster)
========================= */
let rosterHourlyRate = 0;
let rosterPicked = []; // 7 codes
let rosterStartDate = "";
let rosterActiveDayIndex = 0;

const SHIFT_PAID_MIN = 495; // 8h15 (495m) paid

function R(id) {
  return document.getElementById(id);
}

function rosterExpectedMinutesFromCodes(codes) {
  return (codes || []).reduce((acc, code) => {
    if (code === "A" || code === "B") return acc + SHIFT_PAID_MIN;
    return acc;
  }, 0);
}

function rosterFmtHHMMFromMinutes(mins) {
  const m = Math.max(0, Math.floor(Number(mins || 0)));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function rosterRenderPreview() {
  const box = R("rosterPreview");
  const list = R("rpList");
  const totals = R("rpTotals");
  if (!box || !list || !totals) return;

  if (!rosterPicked.length || !rosterStartDate) {
    box.classList.add("hidden");
    return;
  }

  box.classList.remove("hidden");
  list.innerHTML = "";

  const mins = rosterExpectedMinutesFromCodes(rosterPicked);
  const hhmm = rosterFmtHHMMFromMinutes(mins);
  const pay = (mins / 60) * Number(rosterHourlyRate || 0);
  totals.textContent = `Expected: ${hhmm} • ${fmtEUR(pay)}`;

  for (let i = 0; i < rosterPicked.length; i++) {
    const code = rosterPicked[i];
    const ymd = ymdAddDays(rosterStartDate, i);
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

  rosterStartDate = (startInput.value || "").trim();

  if (saveBtn) saveBtn.disabled = rosterPicked.length !== 7;

  if (!rosterStartDate) {
    if (dayTitle) dayTitle.textContent = "Pick start date";
    if (dayDate) dayDate.textContent = "";
    rosterRenderPreview();
    return;
  }

  const ymd = ymdAddDays(rosterStartDate, rosterActiveDayIndex);
  const dt = ymdToDateObj(ymd);

  if (dayTitle) dayTitle.textContent = `${weekdayShort(dt)}`;
  if (dayDate) dayDate.textContent = `${ymd}`;

  if (weekInput && !String(weekInput.value || "").trim()) {
    weekInput.value = String(isoWeekNumber(new Date()));
  }

  rosterRenderPreview();
}

function rosterWizardReset() {
  rosterPicked = [];
  rosterActiveDayIndex = 0;

  const weekInput = R("rwWeekNumber");
  const startInput = R("rwStartDate");

  if (weekInput) weekInput.value = String(isoWeekNumber(new Date()));
  if (startInput) startInput.value = todayYMD(); // Sunday-based roster? You can choose your default.
  rosterStartDate = (startInput?.value || "").trim();

  rosterRenderWizardDay();
}

function rosterPick(code) {
  const startInput = R("rwStartDate");
  rosterStartDate = (startInput?.value || "").trim();
  if (!rosterStartDate) {
    alert("Select start date first.");
    return;
  }

  if (rosterPicked.length >= 7) return;

  rosterPicked.push(code);
  rosterActiveDayIndex = Math.min(6, rosterPicked.length); // next day
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

function rosterShowDetail(roster) {
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
  const hhmm = rosterFmtHHMMFromMinutes(mins);
  const pay = (mins / 60) * Number(rosterHourlyRate || 0);

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
    const r = await api(`/api/roster/${rosterId}`);
    rosterShowDetail(r);
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
        <div class="weekRight">
          <div class="hhmm"></div>
          <div class="eur"></div>
        </div>
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

  if (!week_number || week_number < 1) {
    alert("Week number invalid.");
    return;
  }
  if (!start_date) {
    alert("Start date required.");
    return;
  }
  if (rosterPicked.length !== 7) {
    alert("Select all days (Sun..Sat) before saving.");
    return;
  }

  try {
    await api("/api/roster", {
      method: "POST",
      body: JSON.stringify({
        week_number,
        start_date,
        days: rosterPicked,
      }),
    });

    rosterCloseWizard();
    await rosterLoadList();
  } catch (e) {
    alert(e.message || "Failed to save roster");
  }
}

async function enterRoster() {
  // hourly rate from latest week (for expected pay)
  try {
    const weeks = await api("/api/weeks");
    rosterHourlyRate = weeks && weeks.length ? Number(weeks[0].hourly_rate || 0) : 0;
  } catch {
    rosterHourlyRate = 0;
  }

  // bind roster buttons if exist
  const addBtn = R("btnRosterAddWeek");
  const cancelBtn = R("btnRwCancel");
  const backBtn = R("btnRwBack");
  const saveBtn = R("btnRwSave");
  const startInput = R("rwStartDate");

  // avoid double-binding if user navigates back/forward
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

  if (R("btnRwA") && !R("btnRwA").dataset.bound) {
    R("btnRwA").dataset.bound = "1";
    R("btnRwA").addEventListener("click", () => rosterPick("A"));
  }
  if (R("btnRwB") && !R("btnRwB").dataset.bound) {
    R("btnRwB").dataset.bound = "1";
    R("btnRwB").addEventListener("click", () => rosterPick("B"));
  }
  if (R("btnRwOFF") && !R("btnRwOFF").dataset.bound) {
    R("btnRwOFF").dataset.bound = "1";
    R("btnRwOFF").addEventListener("click", () => rosterPick("OFF"));
  }

  if (startInput && !startInput.dataset.bound) {
    startInput.dataset.bound = "1";
    startInput.addEventListener("change", () => {
      rosterStartDate = (R("rwStartDate")?.value || "").trim();
      rosterPicked = [];
      rosterActiveDayIndex = 0;
      rosterRenderWizardDay();
    });
  }

  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = "1";
    saveBtn.addEventListener("click", rosterSaveWeek);
  }

  await rosterLoadList();
}

/* =========================
   Route after auth
========================= */
async function routeAfterAuth() {
  // standalone pages
  if (pathIs("/add-week")) {
    let defaultRate = 0;
    try {
      const weeks = await api("/api/weeks");
      if (weeks && weeks.length) defaultRate = Number(weeks[0].hourly_rate || 0);
    } catch {}
    openAddWeekPage(defaultRate);
    return;
  }

  if (pathIs("/roster")) {
    // roster.html is a standalone page: no views to show/hide here
    await enterRoster();
    return;
  }

  // default (index)
  await enterHome();
}

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
  if (btnOpenProfile) btnOpenProfile.addEventListener("click", () => goto("profile"));
function openProfile() {
  goto("profile"); // usa teu router atual
}

if (btnOpenProfile) btnOpenProfile.addEventListener("click", openProfile);
if (navProfile) navProfile.addEventListener("click", openProfile);


  btnIn?.addEventListener("click", doClockIn);
  btnOut?.addEventListener("click", doClockOut);
  btnBreak?.addEventListener("click", doClockBreak);

  cardHolidays?.addEventListener("click", () => go("/holidays"));
  cardReports?.addEventListener("click", () => go("/report"));

  btnAddWeek?.addEventListener("click", () => go("/add-week"));

  btnBackAddWeek?.addEventListener("click", backFromAddWeek);
  addWeekForm?.addEventListener("submit", createWeekFromPage);

  navHome?.addEventListener("click", () => go("/"));
  function openProfile() {
  goto("profile");
}

btnOpenProfile?.addEventListener("click", openProfile);
navProfile?.addEventListener("click", openProfile);

  navHistory?.addEventListener("click", () => go("/roster"));
  navHolidays?.addEventListener("click", () => go("/holidays"));
  navReports?.addEventListener("click", () => go("/report"));
  navProfile?.addEventListener("click", () => go("/profile"));
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

  try {
    await api("/api/me");
    await routeAfterAuth();
  } catch {
    await enterLogin();
  }
})();
// Enable click on any element with data-route="/somewhere"
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-route]").forEach((el) => {
    el.addEventListener("click", () => {
      const r = el.getAttribute("data-route");
      if (r) window.location.href = r;
    });
  });
});
