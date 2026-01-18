/* =========================
   Work Hours Tracker - app.js (FIXED)
   - Fixes: dash not defined, boot stuck, home render flow
   - Adds: IN/OUT/BREAK wiring + refresh
   - Keeps: remember me (no password), intro overlay safe, bottom nav
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

async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    ...opts,
  });

  if (!r.ok) {
    let msg = "Request failed";
    try {
      const j = await r.json();
      msg = j.detail || JSON.stringify(j);
    } catch (_) {
      msg = await r.text();
    }
    throw new Error(msg);
  }
  return r.json();
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
  email: "wh_remember_email",
};

function loadRemember() {
  const cb = $("rememberMe");
  if (!cb) return;

  const enabled = localStorage.getItem(LS_REM.enabled) === "1";
  cb.checked = enabled;

  if ($("pw")) $("pw").value = "";

  if (enabled) {
    if ($("email")) $("email").value = localStorage.getItem(LS_REM.email) || "";
  } else {
    if ($("email")) $("email").value = "";
  }
}

function saveRemember(enabled) {
  const cb = $("rememberMe");
  if (!cb) return;

  if (enabled) {
    localStorage.setItem(LS_REM.enabled, "1");
    localStorage.setItem(LS_REM.email, ($("email")?.value || "").trim());
  } else {
    localStorage.setItem(LS_REM.enabled, "0");
    localStorage.removeItem(LS_REM.email);
  }
}

$("rememberMe")?.addEventListener("change", (e) => {
  saveRemember(!!e.target.checked);
});

/* =========================
   Intro video overlay (safe)
========================= */
(function introVideo() {
  const introEl = $("introContainer");
  const videoEl = $("introVideo");
  const skipBtn = $("introSkip");
  if (!introEl) return;
  introEl.classList.remove("hidden");

  let done = false;

  function hideIntro() {
    if (done) return;
    done = true;
    try {
      if (videoEl) {
        videoEl.pause();
        videoEl.currentTime = 0;
      }
    } catch (_) {}
    

    introEl.classList.add("hidden");
    

  }

  skipBtn?.addEventListener("click", hideIntro);
  introEl.addEventListener("click", (e) => {
    if (e.target && e.target.id === "introSkip") return;
    hideIntro();
  }, { passive: true });

  videoEl?.addEventListener("ended", hideIntro);
  videoEl?.addEventListener("error", hideIntro);

  (async () => {
    try {
      if (videoEl) {
        videoEl.muted = true;
        await videoEl.play();
      }
    } catch (_) {
      hideIntro();
    }
  })();

  setTimeout(hideIntro, 2500);
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

  if (target === "home") return openHomeNewUX();
  if (target === "weeks") return openWeeks();
  if (target === "bh") return openBH();
  if (target === "reports") return openReports();
  if (target === "profile") return openProfile();
});

/* =========================
   Logo fallback
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

    if (!email || !password) throw new Error("Email and password are required.");

    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember }),
    });

    saveRemember(remember);
    currentUser = await api("/api/me");
    await openHomeNewUX();
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
    await openHomeNewUX();
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

$("btnProfileLogout")?.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  currentUser = null;
  openAuth();
});

/* =========================
   NEW HOME UX (post-login)
========================= */
async function openHomeNewUX() {
  // hard check: if no session -> go auth
  try {
    currentUser = await api("/api/me");
  } catch (_) {
    return openAuth();
  }

  openScreen("home");
  await renderHomeNewUX();
}

function whtEuro(v) {
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(Number(v || 0));
  } catch {
    return `€${Number(v || 0).toFixed(2)}`;
  }
}

function whtEsc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function whtGetAppRoot() {
  return document.querySelector("#screenHome");
}

function whtHomeTemplate({ me, dash, clock }) {
  const fullName = `${me.first_name || ""} ${me.last_name || ""}`.trim() || (me.email || "User");
  const initials =
    fullName.split(/\s+/).slice(0, 2).map((s) => (s[0] || "").toUpperCase()).join("") || "U";

  const pct = Number(dash?.this_week?.progress_pct || 0);

  const inTxt = clock?.in_time ? clock.in_time : "—";
  const outTxt = clock?.out_time ? clock.out_time : "—";
  const brTxt = clock ? `${clock.break_minutes || 0}m` : "—";
  const breakLabel = clock?.break_running ? "BREAK (stop)" : "BREAK";

  return `
  <div class="wht-page">
    <div class="wht-container">
      <div class="wht-topbar">
        <div>
          <h1 class="wht-h1">Home</h1>
          <div class="wht-sub">Welcome, <b>${whtEsc(fullName)}</b></div>
        </div>
        <button class="wht-btn" id="whtLogoutBtn" type="button">Logout</button>
      </div>

      <div class="wht-card wht-hero">
        <div>
          <div class="wht-hero-kicker">Current week</div>
          <div class="wht-hero-time">${whtEsc(dash.this_week.hhmm || "00:00")}</div>
          <div class="wht-hero-pay">${whtEuro(dash.this_week.pay_eur || 0)}</div>

          <div class="wht-clockBtns" style="display:flex; gap:10px; margin-top:10px;">
            <button class="wht-btn wht-btn-primary" id="whtInBtn" type="button">IN</button>
            <button class="wht-btn wht-btn-primary" id="whtOutBtn" type="button">OUT</button>
            <button class="wht-btn wht-btn-primary" id="whtBreakBtn" type="button">${breakLabel}</button>
          </div>

          <div class="wht-clockStatus" style="margin-top:10px; font-size:13px; opacity:.85;">
            IN: <b>${whtEsc(inTxt)}</b> &nbsp;•&nbsp; OUT: <b>${whtEsc(outTxt)}</b> &nbsp;•&nbsp; BREAK: <b>${whtEsc(brTxt)}</b>
          </div>

          <button class="wht-btn wht-btn-primary" id="whtAddWeekBtn" type="button" style="margin-top:12px;">
            <span><span class="wht-plus">+</span> Add week</span>
          </button>
        </div>

        <div class="wht-ringWrap">
          <div class="wht-ring" style="--pct:${pct}%">
            <div class="wht-avatar" id="whtAvatarBtn" title="Click to change photo">
              ${
                me.avatar_url
                  ? `<img src="${whtEsc(me.avatar_url)}?t=${Date.now()}" alt="avatar" />`
                  : `<div class="wht-fallback">${whtEsc(initials)}</div>`
              }
            </div>
            <input id="whtAvatarFile" type="file" accept="image/*" style="display:none" />
          </div>
        </div>
      </div>

      <div class="wht-grid2">
        <div class="wht-card" id="whtTotalsCard">
          <div class="wht-row">
            <div class="wht-miniIcon">⏱️</div>
            <div>
              <div class="wht-title">Total</div>
              <div class="wht-big">${whtEsc(dash.totals.hhmm || "00:00")}</div>
              <div class="wht-sub">${whtEuro(dash.totals.pay_eur || 0)} • All weeks</div>
            </div>
          </div>
        </div>

        <div class="wht-card wht-click" id="whtBHCard">
          <div class="wht-row" style="justify-content:space-between;">
            <div class="wht-row">
              <div class="wht-miniIcon">🏁</div>
              <div>
                <div class="wht-title">Bank Holidays</div>
                <div class="wht-sub"><b>${Number(dash.bank_holidays.available || 0)}</b> available</div>
                <div class="wht-sub"><b>${Number(dash.bank_holidays.paid || 0)}</b> paid</div>
              </div>
            </div>
            <div class="wht-arrow">›</div>
          </div>
        </div>
      </div>

      <div class="wht-card wht-click" id="whtReportsRow">
        <div class="wht-row" style="justify-content:space-between;">
          <div class="wht-row">
            <div class="wht-miniIcon">📊</div>
            <div>
              <div class="wht-title">Reports</div>
              <div class="wht-sub">View your work summaries</div>
            </div>
          </div>
          <div class="wht-arrow">›</div>
        </div>
      </div>

      <div class="wht-sectionTitle">Quick actions</div>
      <div class="wht-qa">
        <button class="wht-qaBtn" id="whtQAAddWeek" type="button"><span class="wht-qaIcon">＋</span><span>Add week</span></button>
        <button class="wht-qaBtn" id="whtQABH" type="button"><span class="wht-qaIcon">🏁</span><span>Bank holidays</span></button>
        <button class="wht-qaBtn" id="whtQAReports" type="button"><span class="wht-qaIcon">📊</span><span>View reports</span></button>
      </div>
    </div>
  </div>
  `;
}

async function renderHomeNewUX() {
  const root = whtGetAppRoot();
  if (!root) throw new Error("Missing #screenHome in index.html");

  root.innerHTML = `<div class="muted" style="padding:16px">Loading...</div>`;

  // must be authorized
  const me = await api("/api/me");

  // IMPORTANT: declare them BEFORE using (fixes "dash is not defined")
  let dash = null;
  let clock = null;

  // clock is independent (and optional)
  try {
    clock = await api("/api/clock/today");
  } catch (_) {
    clock = null;
  }

  // Prefer /api/dashboard (fast + clean)
  try {
    dash = await api("/api/dashboard");
  } catch (_) {
    // fallback: build from old endpoints
    const weeks = await api("/api/weeks");
    const mostRecent = weeks?.[0] || null;

    let totalPayAll = 0;
    let totalMinAll = 0;

    for (const w of weeks || []) {
      totalPayAll += Number(w.total_pay || 0);
      const hhmm = (w.total_hhmm || "00:00").split(":");
      totalMinAll += Number(hhmm[0] || 0) * 60 + Number(hhmm[1] || 0);
    }

    const year = new Date().getFullYear();
    const bhs = await api(`/api/bank-holidays/${year}`);
    const paid = (bhs || []).filter((x) => x.paid).length;
    const available = (bhs || []).length - paid;

    dash = {
      this_week: {
        hhmm: mostRecent ? (mostRecent.total_hhmm || "00:00") : "00:00",
        pay_eur: mostRecent ? Number(mostRecent.total_pay || 0) : 0,
      },
      totals: { hhmm: minutesToHHMM(totalMinAll), pay_eur: totalPayAll },
      bank_holidays: { available, paid },
    };
  }

  // Progress ring: goal 40h
  const hh = String(dash?.this_week?.hhmm || "00:00").split(":");
  const thisWeekMin = (Number(hh[0] || 0) * 60) + Number(hh[1] || 0);
  const goalMin = 40 * 60;
  dash.this_week.progress_pct = goalMin ? Math.min(100, Math.round((thisWeekMin / goalMin) * 100)) : 0;

  root.innerHTML = whtHomeTemplate({ me, dash, clock });

  // Wire actions (after innerHTML)
  async function refreshClockAndDash() {
    await renderHomeNewUX();
  }

  document.querySelector("#whtInBtn")?.addEventListener("click", async () => {
    try {
      await api("/api/clock/in", { method: "POST" });
      await refreshClockAndDash();
    } catch (e) {
      alert(e.message);
    }
  });

  document.querySelector("#whtOutBtn")?.addEventListener("click", async () => {
    try {
      await api("/api/clock/out", { method: "POST" });
      await refreshClockAndDash();
    } catch (e) {
      alert(e.message);
    }
  });

  document.querySelector("#whtBreakBtn")?.addEventListener("click", async () => {
    try {
      await api("/api/clock/break", { method: "POST" });
      await refreshClockAndDash();
    } catch (e) {
      alert(e.message);
    }
  });

  document.querySelector("#whtLogoutBtn")?.addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    currentUser = null;
    openAuth();
  });

  // Avatar upload
  const fileInput = document.querySelector("#whtAvatarFile");
  document.querySelector("#whtAvatarBtn")?.addEventListener("click", () => fileInput?.click());

  fileInput?.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;

    const fd = new FormData();
    fd.append("file", f);

    const res = await fetch("/api/me/avatar", { method: "POST", body: fd, credentials: "include" });
    if (!res.ok) {
      alert("Avatar upload failed");
      return;
    }
    await renderHomeNewUX();
  });

  const goAddWeek = async () => {
    await openWeeks();
    show($("newWeekBox"));
  };

  document.querySelector("#whtAddWeekBtn")?.addEventListener("click", goAddWeek);
  document.querySelector("#whtQAAddWeek")?.addEventListener("click", goAddWeek);

  document.querySelector("#whtBHCard")?.addEventListener("click", () => openBH());
  document.querySelector("#whtQABH")?.addEventListener("click", () => openBH());

  document.querySelector("#whtReportsRow")?.addEventListener("click", () => openReports());
  document.querySelector("#whtQAReports")?.addEventListener("click", () => openReports());
}

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
  if ($("weekMeta")) $("weekMeta").textContent = `Start: ${w.start_date} • Sunday = 1.5x`;
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
    const is15 = (Number(e.multiplier || 1) === 1.5);

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
    currentUser = await api("/api/me");
    if ($("profileName")) $("profileName").textContent = `${currentUser.first_name} ${currentUser.last_name}`.trim();
    if ($("profileEmail")) $("profileEmail").textContent = currentUser.email || "—";
  } catch (e) {
    console.error(e);
    openAuth();
  }
}

/* =========================
   PWA
========================= */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});
}

/* =========================
   Boot (FIXED)
   - Always opens a proper screen
   - If logged: go Home
   - If not logged: go Auth
========================= */
async function bootApp() {
  try {
    const me = await api("/api/me", { method: "GET" });
    currentUser = me;
    await openHomeNewUX();
  } catch (_) {
    openAuth();
  } finally {
    const loading = document.querySelector("#loading");
    if (loading) loading.classList.add("hidden");

   
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bootApp();
});
