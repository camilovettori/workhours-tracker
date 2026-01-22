/* =========================
   Work Hours Tracker - app.js (v12)
   - Login: no tabs, single Login button, Sign up link below, bigger centered logo
   - Home: uses backend endpoints
   - Reports: /report
   - Add week: NEW PAGE /add-week (no modal)
========================= */

console.log("app.js loaded ✅");

const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");

/* =========================
   Utils
========================= */
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
  const diff = (day === 0 ? -6 : 1 - day); // go back to Monday
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

/* =========================
   Views
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

// dashboard buttons (Add week)
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

// All time / Today
const allHHMM = $("allHHMM");
const allPay = $("allPay");
const allIn = $("allIn");
const allOut = $("allOut");
const allBreak = $("allBreak");
const todayPay = $("todayPay");

// Bank holidays
const bhAvail = $("bhAvail");
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
let UI_DAY = todayYMD();          // "YYYY-MM-DD" local (usa tua função)
let breakTick = null;             // setInterval handler
let breakRemaining = 0;           // segundos
let breakRunningUI = false;       // estado do countdown (UI)

let CURRENT_WEEK_ID = null;
let CLOCK = null;
function stopBreakCountdown(vibrate = false){
  if (breakTick) clearInterval(breakTick);
  breakTick = null;
  breakRunningUI = false;
  breakRemaining = 0;

  if (vibrate && "vibrate" in navigator) navigator.vibrate([150,80,150]);
}

function resetTodayVisual(){
  // limpa só visual do "today"
  if (cwIn) cwIn.textContent = "00:00";
  if (cwOut) cwOut.textContent = "00:00";
  if (cwBreak) cwBreak.textContent = "0m";
  if (btnBreak) btnBreak.innerHTML = `<span class="pillIcon">⏱</span> BREAK`;
  stopBreakCountdown(false);
}

function watchDayChange(){
  const now = todayYMD();
  if (now !== UI_DAY){
    UI_DAY = now;
    resetTodayVisual();
    refreshClock().catch(()=>{});
    refreshTodayPay().catch(()=>{});
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
      if (r && r.dev_reset_link) {
        forgotMsg.textContent = `Reset link (dev): ${r.dev_reset_link}`;
      } else {
        forgotMsg.textContent = "If the email exists, you’ll receive a reset link.";
      }
    }
  } catch (e) {
    if (forgotMsg) forgotMsg.textContent = e.message || "Failed";
  }
}

/* =========================
   Dashboard / Clock
========================= */
async function refreshAll() {
  const dash = await api("/api/dashboard");

  // Current week totals
  if (cwHHMM) cwHHMM.textContent = dash?.this_week?.hhmm || "00:00";
  if (cwPay) cwPay.textContent = fmtEUR(dash?.this_week?.pay_eur || 0);

  // All-time totals
  if (allHHMM) allHHMM.textContent = dash?.totals?.hhmm || "00:00";
  if (allPay) allPay.textContent = fmtEUR(dash?.totals?.pay_eur || 0);

  // Bank holidays
  const avail = Number(dash?.bank_holidays?.available ?? 0);
  const paid = Number(dash?.bank_holidays?.paid ?? 0);
  if (bhAvail) bhAvail.textContent = String(avail);
  if (bhPaid) bhPaid.textContent = String(paid);
  if (bhRemain) bhRemain.textContent = "0"; // backend not providing remaining yet

  await refreshClock();
  await refreshTodayPay();
}

async function refreshClock() {
  try {
    const c = await api("/api/clock/today");
    CLOCK = c;

    if (!c.has_week) {
      CURRENT_WEEK_ID = null;

      if (cwIn) cwIn.textContent = "00:00";
      if (cwOut) cwOut.textContent = "00:00";
      if (cwBreak) cwBreak.textContent = "0m";
      if (cwStatusText) cwStatusText.textContent = "Create a week to start tracking.";

      if (btnBreak) btnBreak.innerHTML = `<span class="pillIcon">⏱</span> BREAK`;

      if (allIn) allIn.textContent = "00:00";
      if (allOut) allOut.textContent = "00:00";
      if (allBreak) allBreak.textContent = "0m";
      return;
    }
    function pad2(n){ return String(n).padStart(2,"0"); }

function fmtMMSS(totalSec){
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

function stopBreakCountdown(vibrate = false){
  if (breakTick) clearInterval(breakTick);
  breakTick = null;
  breakRunningUI = false;
  breakRemaining = 0;

  if (vibrate && "vibrate" in navigator) navigator.vibrate([150,80,150]);
}

function resetTodayVisual(){
  // limpa só visual
  if (cwIn) cwIn.textContent = "00:00";
  if (cwOut) cwOut.textContent = "00:00";
  if (cwBreak) cwBreak.textContent = "0m";
  if (btnBreak) btnBreak.innerHTML = `<span class="pillIcon">⏱</span> BREAK`;

  stopBreakCountdown(false);
}

function watchDayChange(){
  const now = todayYMD();
  if (now !== UI_DAY){
    UI_DAY = now;
    resetTodayVisual();
    // puxa o estado real de hoje
    refreshClock().catch(()=>{});
    refreshTodayPay().catch(()=>{});
  }
}

// roda pra sempre (app aberto)
setInterval(watchDayChange, 5000);


    CURRENT_WEEK_ID = c.week_id;

    const inT = c.in_time || "00:00";
    const outT = c.out_time || "00:00";
    const brM = `${Number(c.break_minutes || 0)}m`;

    if (cwIn) cwIn.textContent = inT;
    if (cwOut) cwOut.textContent = outT;
    if (cwBreak) cwBreak.textContent = brM;

    if (allIn) allIn.textContent = inT;
    if (allOut) allOut.textContent = outT;
    if (allBreak) allBreak.textContent = brM;

    if (btnBreak) {
      btnBreak.innerHTML = c.break_running
        ? `<span class="pillIcon">⏱</span> BREAK (stop)`
        : `<span class="pillIcon">⏱</span> BREAK`;
    }

    const hhmm = (cwHHMM?.textContent || "00:00").includes(":") ? cwHHMM.textContent : "00:00";
    if (cwStatusText) {
      cwStatusText.textContent = hhmm !== "00:00" ? "You're on track this week!" : "Add time to start this week.";
    }
  } catch (e) {
    if (e.status === 401) await enterLogin();
  }
}

async function refreshTodayPay() {
  if (!todayPay) return;

  if (!CURRENT_WEEK_ID) {
    todayPay.textContent = "€0.00";
    return;
  }

  try {
    const week = await api(`/api/weeks/${CURRENT_WEEK_ID}`);
    const rate = Number(week?.hourly_rate || 0);
    const ymd = todayYMD();

    const entry = (week?.entries || []).find((e) => e.work_date === ymd);
    if (!entry) {
      todayPay.textContent = "€0.00";
      return;
    }

    const mins = hhmmToMinutes(entry.worked_hhmm);
    const mult = Number(entry.multiplier || 1.0);
    const pay = (mins / 60) * rate * mult;

    todayPay.textContent = fmtEUR(pay);
  } catch {
    todayPay.textContent = "€0.00";
  }
}

/* =========================
   Clock actions
========================= */
function nowHHMM(){
  const d = new Date();
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}

async function doClockIn() {
  try {
    await api("/api/clock/in", { method: "POST" });

    // busca estado atualizado do dia
    const c = await api("/api/clock/today");

    if (cwIn)  cwIn.textContent  = c.in_time || "00:00";
    if (cwOut) cwOut.textContent = c.out_time || "00:00";
    if (cwBreak) cwBreak.textContent = `${Number(c.break_minutes || 0)}m`;

    // NÃO chama refreshAll aqui
    // Totais podem atualizar depois, via polling natural
  } catch (e) {
    alert(e.message || "IN failed");
  }
}


async function doClockOut() {
  try {
    await api("/api/clock/out", { method: "POST" });

    // update visual imediato
    const t = nowHHMM();
    if (cwOut) cwOut.textContent = t;

    await refreshAll();
  } catch (e) {
    alert(e.message || "OUT failed");
  }
}

async function doClockBreak() {
  try {
    await api("/api/clock/break", { method: "POST" });
    await refreshClock();
    await refreshTodayPay();
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

    // go home
    window.location.href = "/";
  } catch (e) {
    if (addWeekMsg) addWeekMsg.textContent = e.message || "Failed to create week";
  }
}

/* =========================
   Route after auth
========================= */
async function routeAfterAuth() {
  // already authed because /api/me works
  if (pathIs("/add-week")) {
    let defaultRate = 0;
    try {
      const weeks = await api("/api/weeks");
      if (weeks && weeks.length) defaultRate = Number(weeks[0].hourly_rate || 0);
    } catch {}
    openAddWeekPage(defaultRate);
    return;
  }

  await enterHome();
}

/* =========================
   Bind
========================= */
function bind() {
  // auth forms
  loginForm?.addEventListener("submit", doLogin);
  signupForm?.addEventListener("submit", doSignup);

  // signup/login toggles
  btnShowSignup?.addEventListener("click", showSignup);
  btnShowLogin?.addEventListener("click", showLogin);

  // forgot
  btnForgot?.addEventListener("click", toggleForgot);
  btnSendReset?.addEventListener("click", sendReset);

  // logout
  btnLogout?.addEventListener("click", doLogout);

  // clock
  btnIn?.addEventListener("click", doClockIn);
  btnOut?.addEventListener("click", doClockOut);
  btnBreak?.addEventListener("click", doClockBreak);

  // cards
  cardHolidays?.addEventListener("click", () => go("/holidays"));
  cardReports?.addEventListener("click", () => go("/report"));

  // add week button (home)
  btnAddWeek?.addEventListener("click", () => go("/add-week"));

  // add week page
  btnBackAddWeek?.addEventListener("click", backFromAddWeek);
  addWeekForm?.addEventListener("submit", createWeekFromPage);

  // bottom nav
  navHome?.addEventListener("click", () => go("/"));
  navHistory?.addEventListener("click", () => go("/weeks"));
  navHolidays?.addEventListener("click", () => go("/holidays"));
  navReports?.addEventListener("click", () => go("/report"));
  navProfile?.addEventListener("click", () => go("/profile"));
}

/* =========================
   Init
========================= */


(async function init() {
  bind();
  setInterval(watchDayChange, 5000);


  try {
    // check auth
    await api("/api/me");
    await routeAfterAuth();
  } catch {
    await enterLogin();
  }
})();