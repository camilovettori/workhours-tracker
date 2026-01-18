/* =========================
   Work Hours Tracker - app.js
========================= */
console.log("app.js loaded ✅");

const $ = (id) => document.getElementById(id);

function show(el) { el && el.classList.remove("hidden"); }
function hide(el) { el && el.classList.add("hidden"); }

function setMsg(el, text, ok = false) {
  if (!el) return;
  el.style.color = ok ? "#15803d" : "#b91c1c";
  el.textContent = text || "";
}

function money(x) { return "€" + Number(x || 0).toFixed(2); }

function minutesToHHMM(totalMin) {
  totalMin = Math.max(0, Number(totalMin || 0));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  });

  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);

  if (!res.ok) {
    const msg =
      (data && data.detail) ? data.detail :
      (typeof data === "string" ? data : `Error ${res.status}`);
    throw new Error(msg);
  }
  return data;
}

/* =========================
   Screens
========================= */
const screens = {
  auth: $("screenAuth"),
  signup: $("screenSignup"),
  forgot: $("screenForgot"),
  reset: $("screenReset"),
  home: $("screenHome"),
  weeks: $("screenWeeks"),
  weekDetail: $("screenWeekDetail"),
  dayForm: $("screenDayForm"),
  bh: $("screenBH"),
  reports: $("screenReports"),
  profile: $("screenProfile"),
};

function openScreen(name) {
  Object.values(screens).forEach(hide);
  show(screens[name]);

  if (name === "auth" || name === "signup" || name === "forgot" || name === "reset") {
    hideBottomNav();
  } else {
    showBottomNav();
  }
  setActiveNav(name);
}

/* =========================
   State
========================= */
let currentUser = null;
let currentWeek = null;
let editingEntry = null;

/* =========================
   Remember me (NO PASSWORD)
========================= */
const LS_REM = {
  enabled: "wh_remember_enabled",
  fn: "wh_remember_fn",
  ln: "wh_remember_ln",
  email: "wh_remember_email",
};

function updateCreditVisibility() {
  const credit = $("credit");
  if (!credit) return;
  credit.style.display = "";
}


function loadRemember() {
  const cb = $("rememberMe");
  if (!cb) return;

  const enabled = localStorage.getItem(LS_REM.enabled) === "1";
  cb.checked = enabled;

  if ($("pw")) $("pw").value = "";

  if (enabled) {
    if ($("fn")) $("fn").value = localStorage.getItem(LS_REM.fn) || "";
    if ($("ln")) $("ln").value = localStorage.getItem(LS_REM.ln) || "";
    if ($("email")) $("email").value = localStorage.getItem(LS_REM.email) || "";
  } else {
    if ($("fn")) $("fn").value = "";
    if ($("ln")) $("ln").value = "";
    if ($("email")) $("email").value = "";
  }

  updateCreditVisibility();
}

function saveRemember(enabled) {
  const cb = $("rememberMe");
  if (!cb) return;

  if (enabled) {
    localStorage.setItem(LS_REM.enabled, "1");
    localStorage.setItem(LS_REM.fn, ($("fn")?.value || "").trim());
    localStorage.setItem(LS_REM.ln, ($("ln")?.value || "").trim());
    localStorage.setItem(LS_REM.email, ($("email")?.value || "").trim());
  } else {
    localStorage.setItem(LS_REM.enabled, "0");
    localStorage.removeItem(LS_REM.fn);
    localStorage.removeItem(LS_REM.ln);
    localStorage.removeItem(LS_REM.email);
  }
  updateCreditVisibility();
}

$("rememberMe")?.addEventListener("change", (e) => {
  const enabled = !!e.target.checked;
  if (!enabled) {
    if ($("fn")) $("fn").value = "";
    if ($("ln")) $("ln").value = "";
    if ($("email")) $("email").value = "";
  }
  saveRemember(enabled);
});

/* =========================
   Intro video
========================= */
(function introVideo() {
  const introEl = $("introContainer");
  const videoEl = $("introVideo");

  function hideIntro() {
    if (introEl) introEl.style.display = "none";
  }

  if (introEl && videoEl) {
    videoEl.addEventListener("ended", hideIntro);
    videoEl.addEventListener("error", hideIntro);
    setTimeout(hideIntro, 4000);
  }
})();

/* =========================
   Bottom Nav
========================= */
const bottomNav = $("bottomNav");
function showBottomNav() { bottomNav && bottomNav.classList.remove("hidden"); }
function hideBottomNav() { bottomNav && bottomNav.classList.add("hidden"); }

function setActiveNav(screenName) {
  if (!bottomNav) return;
  const map = {
    home: "home",
    weeks: "weeks",
    bh: "bh",
    reports: "reports",
    profile: "profile",
    weekDetail: "weeks",
    dayForm: "weeks",
  };
  const activeKey = map[screenName] || null;
  bottomNav.querySelectorAll(".navItem").forEach((b) => {
    const key = b.getAttribute("data-screen");
    b.classList.toggle("active", !!activeKey && key === activeKey);
  });
}

bottomNav?.addEventListener("click", async (e) => {
  const btn = e.target.closest(".navItem");
  if (!btn) return;

  const target = btn.getAttribute("data-screen");
  if (!target) return;

  if (target === "home") return openHome();
  if (target === "weeks") return openWeeks();
  if (target === "bh") return openBH();
  if (target === "reports") return openReports();
  if (target === "profile") return openProfile();
});

/* =========================
   Logo
========================= */
(function loadLogo() {
  const img = $("appLogo");
  if (!img) return;

  const candidates = ["/static/logo.png", "/static/tesco.png"];
  let idx = 0;

  function tryNext() {
    if (idx >= candidates.length) {
      img.style.display = "none";
      return;
    }
    img.src = candidates[idx++];
  }
  img.onerror = tryNext;
  tryNext();
})();

/* =========================
   Auth navigation buttons
========================= */
$("btnSignUpOpen")?.addEventListener("click", () => {
  setMsg($("signupMsg"), "");
  openScreen("signup");
});

$("btnForgotOpen")?.addEventListener("click", () => {
  setMsg($("forgotMsg"), "");
  if ($("f_email") && $("email")) $("f_email").value = ($("email").value || "").trim();
  openScreen("forgot");
});

$("btnSignupBack")?.addEventListener("click", () => openAuth());
$("btnForgotBack")?.addEventListener("click", () => openAuth());

/* =========================
   Auth actions
========================= */
function openAuth() {
  currentWeek = null;
  editingEntry = null;
  setMsg($("authMsg"), "");
  loadRemember();
  openScreen("auth");
}

$("btnSignIn")?.addEventListener("click", async () => {
  try {
    setMsg($("authMsg"), "");

    const email = ($("email")?.value || "").trim().toLowerCase();

    const password = $("pw")?.value || "";
    const remember = $("rememberMe")?.checked || false;

    if (!email || !password) {
      throw new Error("Email and password are required.");
    }

    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: email,
        password: password,
        remember: remember,
      }),
    });

    saveRemember(remember);
    currentUser = await api("/api/me");
    await openHome();
  } catch (e) {
    setMsg($("authMsg"), e.message);
  }
});



$("btnSignUp")?.addEventListener("click", async () => {
  try {
    setMsg($("signupMsg"), "");
    await api("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        first_name: ($("s_fn")?.value || "").trim(),
        last_name: ($("s_ln")?.value || "").trim(),
        email: ($("s_email")?.value || "").trim(),
        password: $("s_pw")?.value || "",
      }),
    });

    currentUser = await api("/api/me").catch(() => null);
    await openHome();
  } catch (e) {
    setMsg($("signupMsg"), e.message);
  }
});

$("btnForgotSend")?.addEventListener("click", async () => {
  try {
    setMsg($("forgotMsg"), "");
    const email = ($("f_email")?.value || "").trim();
    if (!email) throw new Error("Please enter your email.");

    const r = await api("/api/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    });

    // if SMTP missing, backend returns dev_reset_link (safe for you now)
    if (r && r.dev_reset_link) {
      setMsg($("forgotMsg"), `DEV link: ${r.dev_reset_link}`, true);
    } else {
      setMsg($("forgotMsg"), "Check your email for the reset link.", true);
    }
  } catch (e) {
    setMsg($("forgotMsg"), e.message);
  }
});

function getResetTokenFromURL() {
  const params = new URLSearchParams(window.location.search || "");
  return params.get("reset") || params.get("token") || "";
}

$("btnResetSave")?.addEventListener("click", async () => {
  try {
    setMsg($("resetMsg"), "");
    const token = getResetTokenFromURL();
    if (!token) throw new Error("Missing reset token.");

    const new_password = $("r_pw")?.value || "";
    if (new_password.length < 4) throw new Error("Password too short.");

    await api("/api/reset", {
      method: "POST",
      body: JSON.stringify({ token, new_password }),
    });

    setMsg($("resetMsg"), "Password updated. Please sign in.", true);
    setTimeout(() => openAuth(), 800);
  } catch (e) {
    setMsg($("resetMsg"), e.message);
  }
});

$("btnLogout")?.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  currentUser = null;
  openAuth();
});

$("btnProfileLogout")?.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  currentUser = null;
  openAuth();
});

/* =========================
   HOME
========================= */
async function openHome() {
  openScreen("home");

  if (!currentUser) currentUser = await api("/api/me").catch(() => null);
  if (currentUser && $("homeSubtitle")) {
    $("homeSubtitle").textContent = `${currentUser.first_name} ${currentUser.last_name}`;
  }
  await refreshHome();
}

async function refreshHome() {
  try {
    const weeks = await api("/api/weeks");
    let totalPayAll = 0;
    let totalMinAll = 0;

    const mostRecent = weeks?.[0] || null;

    for (const w of weeks || []) {
      totalPayAll += Number(w.total_pay || 0);
      const hhmm = (w.total_hhmm || "00:00").split(":");
      totalMinAll += (Number(hhmm[0] || 0) * 60) + Number(hhmm[1] || 0);
    }

    if ($("homeWeekHours")) $("homeWeekHours").textContent = mostRecent ? (mostRecent.total_hhmm || "00:00") : "00:00";
    if ($("homeWeekPay")) $("homeWeekPay").textContent = mostRecent ? money(mostRecent.total_pay || 0) : money(0);
    if ($("homeAllHours")) $("homeAllHours").textContent = minutesToHHMM(totalMinAll);
    if ($("homeAllPay")) $("homeAllPay").textContent = money(totalPayAll);

    const year = new Date().getFullYear();
    const bhs = await api(`/api/bank-holidays/${year}`);
    const paid = (bhs || []).filter(x => x.paid).length;
    const toTake = (bhs || []).length - paid;

    if ($("homeBHToTake")) $("homeBHToTake").textContent = `${toTake} to take`;
    if ($("homeBHPaid")) $("homeBHPaid").textContent = `${paid} paid`;
  } catch (e) {
    console.error(e);
  }
}

/* Quick actions */
$("goWeeks")?.addEventListener("click", () => openWeeks());
$("goNewWeek")?.addEventListener("click", async () => { await openWeeks(); show($("newWeekBox")); });
$("goBH")?.addEventListener("click", () => openBH());
$("goReports")?.addEventListener("click", () => openReports());

/* =========================
   WEEKS
========================= */
async function openWeeks() {
  openScreen("weeks");
  hide($("newWeekBox"));
  setMsg($("weekMsg"), "");
  await refreshWeeks();
}

$("btnNewWeek")?.addEventListener("click", () => {
  show($("newWeekBox"));
  setMsg($("weekMsg"), "");
});

$("btnCancelWeek")?.addEventListener("click", () => hide($("newWeekBox")));

$("btnCreateWeek")?.addEventListener("click", async () => {
  try {
    setMsg($("weekMsg"), "");
    const week_number = Number($("newWeekNumber")?.value);
    const start_date = $("newStartDate")?.value;
    const hourly_rate = Number($("newRate")?.value);

    if (!week_number || !start_date || isNaN(hourly_rate)) {
      throw new Error("Fill week number, start date and hourly rate.");
    }

    await api("/api/weeks", {
      method: "POST",
      body: JSON.stringify({ week_number, start_date, hourly_rate }),
    });

    if ($("newWeekNumber")) $("newWeekNumber").value = "";
    if ($("newRate")) $("newRate").value = "";
    hide($("newWeekBox"));

    await refreshWeeks();
    setMsg($("weekMsg"), "Week created.", true);
  } catch (e) {
    setMsg($("weekMsg"), e.message);
  }
});

async function refreshWeeks() {
  const list = $("weeksList");
  if (!list) return;

  list.innerHTML = "";
  const weeks = await api("/api/weeks");

  if (!weeks.length) {
    list.innerHTML = `<div class="muted">No weeks yet. Create one.</div>`;
    return;
  }

  for (const w of weeks) {
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

/* =========================
   WEEK DETAIL
========================= */
$("btnBackWeeks")?.addEventListener("click", () => openWeeks());

$("btnReport")?.addEventListener("click", () => {
  if (!currentWeek) return;
  window.open(`/report?week_id=${encodeURIComponent(currentWeek.id)}`, "_blank");
});

$("btnDeleteWeek")?.addEventListener("click", async () => {
  if (!currentWeek) return;
  if (!confirm("Delete this week (all days)?")) return;

  await api(`/api/weeks/${currentWeek.id}`, { method: "DELETE" });
  currentWeek = null;
  await openWeeks();
});

$("btnSaveRate")?.addEventListener("click", async () => {
  try {
    if (!currentWeek) return;
    const hourly_rate = Number($("rateEdit")?.value);
    await api(`/api/weeks/${currentWeek.id}`, {
      method: "PATCH",
      body: JSON.stringify({ hourly_rate }),
    });
    await loadWeek(currentWeek.id);
  } catch (e) {
    alert(e.message);
  }
});

$("btnAddDay")?.addEventListener("click", () => openDayFormAdd());

async function openWeekDetail(weekId) {
  openScreen("weekDetail");
  await loadWeek(weekId);
}

async function loadWeek(weekId) {
  const w = await api(`/api/weeks/${weekId}`);
  currentWeek = w;

  if ($("weekTitle")) $("weekTitle").textContent = `Week ${w.week_number}`;
  if ($("weekMeta")) $("weekMeta").textContent = `Start: ${w.start_date} • Sunday/Bank Holiday = 1.5x`;
  if ($("weekTotals")) $("weekTotals").textContent = `Total ${w.totals.total_hhmm} • ${money(w.totals.total_pay)}`;
  if ($("rateEdit")) $("rateEdit").value = w.hourly_rate;

  renderEntries(w.entries);
  setMsg($("entryMsg"), "");
}

function renderEntries(entries) {
  const tb = $("entriesBody");
  if (!tb) return;

  tb.innerHTML = "";
  if (!entries.length) {
    tb.innerHTML = `<tr><td colspan="8" class="muted">No days yet.</td></tr>`;
    return;
  }

  for (const e of entries) {
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
    `;

    tr.addEventListener("click", () => openDayFormEdit(e));
    tb.appendChild(tr);
  }
}

/* =========================
   DAY FORM
========================= */
$("btnDayBack")?.addEventListener("click", () => openScreen("weekDetail"));

$("btnSaveDay")?.addEventListener("click", async () => {
  try {
    if (!currentWeek) throw new Error("No week selected.");

    const bhPaidVal = $("bhPaid")?.value ?? "";
    const bh_paid = bhPaidVal === "" ? null : (bhPaidVal === "true");

    await api(`/api/weeks/${currentWeek.id}/entry`, {
      method: "PUT",
      body: JSON.stringify({
        work_date: $("workDate")?.value,
        time_in: $("timeIn")?.value || null,
        time_out: $("timeOut")?.value || null,
        break_minutes: Number($("breakMin")?.value || 0),
        note: ($("note")?.value || "").trim() || null,
        bh_paid,
      }),
    });

    setMsg($("dayMsg"), "Saved.", true);
    await loadWeek(currentWeek.id);
    openScreen("weekDetail");
  } catch (e) {
    setMsg($("dayMsg"), e.message);
  }
});

$("btnDeleteDay")?.addEventListener("click", async () => {
  try {
    if (!editingEntry?.id) return;
    if (!confirm("Delete this day?")) return;

    await api(`/api/entries/${editingEntry.id}`, { method: "DELETE" });
    await loadWeek(currentWeek.id);
    openScreen("weekDetail");
  } catch (e) {
    alert(e.message);
  }
});

function openDayFormAdd() {
  editingEntry = null;
  if ($("dayFormTitle")) $("dayFormTitle").textContent = "Add day";
  if ($("btnDeleteDay")) hide($("btnDeleteDay"));
  fillDayForm(null);
  openScreen("dayForm");
}

function openDayFormEdit(entry) {
  editingEntry = entry;
  if ($("dayFormTitle")) $("dayFormTitle").textContent = "Edit day";
  if ($("btnDeleteDay")) show($("btnDeleteDay"));
  fillDayForm(entry);
  openScreen("dayForm");
}

function fillDayForm(entry) {
  setMsg($("dayMsg"), "");

  if ($("workDate")) $("workDate").value = entry?.work_date || "";
  if ($("timeIn")) $("timeIn").value = entry?.time_in || "";
  if ($("timeOut")) $("timeOut").value = entry?.time_out || "";
  if ($("breakMin")) $("breakMin").value = String(entry?.break_minutes ?? 0);
  if ($("note")) $("note").value = entry?.note || "";

  if ($("bhPaid")) {
    $("bhPaid").value =
      entry?.bh_paid === true ? "true" :
      entry?.bh_paid === false ? "false" : "";
  }
}

/* =========================
   BANK HOLIDAYS
========================= */
async function openBH() {
  openScreen("bh");
  if ($("bhYear")) $("bhYear").value = String(new Date().getFullYear());
  await loadBH();
}

$("btnLoadBH")?.addEventListener("click", async () => loadBH());

async function loadBH() {
  const year = Number($("bhYear")?.value || new Date().getFullYear());
  const list = $("bhList");
  if (!list) return;

  list.innerHTML = "";

  const items = await api(`/api/bank-holidays/${year}`);
  for (const bh of items) {
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
          <option value="true" ${bh.paid ? "selected" : ""}>Yes</option>
          <option value="false" ${!bh.paid ? "selected" : ""}>No</option>
        </select>
      </div>
    `;

    const sel = div.querySelector("select");
    sel.onchange = async () => {
      const paid = sel.value === "true";
      await api(`/api/bank-holidays/${bh.id}`, {
        method: "PATCH",
        body: JSON.stringify({ paid }),
      });
    };

    list.appendChild(div);
  }
}

/* =========================
   REPORTS
========================= */
async function openReports() {
  openScreen("reports");
  await fillReportSelect();
}

async function fillReportSelect() {
  const sel = $("reportWeekSelect");
  if (!sel) return;

  sel.innerHTML = "";
  const weeks = await api("/api/weeks");

  if (!weeks.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No weeks available";
    sel.appendChild(opt);
    return;
  }

  for (const w of weeks) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = `Week ${w.week_number} • ${w.start_date} • ${w.total_hhmm} • ${money(w.total_pay)}`;
    sel.appendChild(opt);
  }
}

$("btnOpenReport")?.addEventListener("click", () => {
  const weekId = $("reportWeekSelect")?.value;
  if (!weekId) return;
  window.open(`/report?week_id=${encodeURIComponent(weekId)}`, "_blank");
});

/* =========================
   PROFILE
========================= */
async function openProfile() {
  openScreen("profile");
  try {
    if (!currentUser) currentUser = await api("/api/me");
    if ($("profileSub")) $("profileSub").textContent = "Account details";
    if ($("profileName")) $("profileName").textContent = `${currentUser.first_name} ${currentUser.last_name}`;
    if ($("profileEmail")) $("profileEmail").textContent = currentUser.email ? currentUser.email : "—";
  } catch (e) {
    console.error(e);
  }
}

/* =========================
   PWA
========================= */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});
}

/* =========================
   Boot
========================= */
async function boot() {
  updateCreditVisibility();

  const token = getResetTokenFromURL();
  if (token) {
    openScreen("reset");
    return;
  }

  try {
    currentUser = await api("/api/me");
    await openHome();
  } catch (_) {
    openAuth();
  }
}

boot();
