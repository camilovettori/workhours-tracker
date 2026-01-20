console.log("report.js loaded ✅");

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = data?.detail || (typeof data === "string" ? data : "Request failed");
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmtEUR(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString(undefined, { style: "currency", currency: "EUR" });
  } catch {
    return `€${v.toFixed(2)}`;
  }
}

function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function go(url) {
  window.location.href = url;
}

function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string" || !hhmm.includes(":")) return 0;
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function renderWeeksList(weeks) {
  const box = $("weeksList");
  if (!box) return;

  box.innerHTML = "";

  if (!weeks || weeks.length === 0) {
    box.innerHTML = `
      <div style="color:#64748b;font-weight:900;padding:14px 6px;">
        No weeks yet. Go back and add a week first.
      </div>
    `;
    return;
  }

  for (const w of weeks) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "weekRow";
    row.innerHTML = `
      <div class="weekRowLeft">
        <div class="weekRowTitle">Week ${w.week_number}</div>
        <div class="weekRowSub">Start: ${w.start_date}</div>
      </div>
      <div class="weekRowRight">
        <div class="weekRowHH">${w.total_hhmm || "00:00"}</div>
        <div class="weekRowPay">${fmtEUR(w.total_pay || 0)}</div>
      </div>
      <div class="weekRowChev">›</div>
    `;
    row.addEventListener("click", () => go(`/report?week_id=${w.id}`));
    box.appendChild(row);
  }
}

function renderWeekDetail(week) {
  // expects report.html to have these IDs
  const tWeek = $("rWeek");
  const tSub = $("rSub");
  const tRate = $("rRate");
  const tStart = $("rStart");
  const tbody = $("rTbody");
  const totalHH = $("rTotalHH");
  const totalPay = $("rTotalPay");

  if (tWeek) tWeek.textContent = `Week ${week.week_number}`;
  if (tSub) tSub.textContent = `Week ${week.week_number} • Weekly report`;
  if (tRate) tRate.textContent = `€${Number(week.hourly_rate || 0).toFixed(2)} / hour`;
  if (tStart) tStart.textContent = week.start_date || "—";

  if (tbody) tbody.innerHTML = "";

  let sumMin = 0;
  let sumPay = 0;

  const rate = Number(week.hourly_rate || 0);

  for (const e of (week.entries || [])) {
    const mins = hhmmToMinutes(e.worked_hhmm || "00:00");
    sumMin += mins;

    const mult = Number(e.multiplier || 1.0);
    const pay = (mins / 60) * rate * mult;
    sumPay += pay;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${e.weekday || ""}</td>
      <td>${e.date_ddmmyyyy || e.work_date || ""}</td>
      <td>${e.time_in || "—"}</td>
      <td>${e.time_out || "—"}</td>
      <td>${(e.break_minutes ?? 0)}m</td>
      <td>${e.worked_hhmm || "00:00"}</td>
      <td>${fmtEUR(pay)}</td>
    `;
    tbody && tbody.appendChild(tr);
  }

  const hh = String(Math.floor(sumMin / 60)).padStart(2, "0");
  const mm = String(sumMin % 60).padStart(2, "0");

  if (totalHH) totalHH.textContent = `${hh}:${mm}`;
  if (totalPay) totalPay.textContent = fmtEUR(sumPay);
}

async function load() {
  const btnBack = $("btnBack");
  const btnPrint = $("btnPrint");

  // Back always works:
  btnBack?.addEventListener("click", () => {
    const hasWeek = !!getParam("week_id");
    if (hasWeek) go("/report"); // from detail -> list
    else go("/");               // from list -> home
  });

  // Print only in detail
  btnPrint?.addEventListener("click", () => window.print());

  const weekId = getParam("week_id");

  // If no week_id => show list
  if (!weekId) {
    // show list section / hide detail section if your HTML has them
    $("sectionList")?.classList.remove("hidden");
    $("sectionDetail")?.classList.add("hidden");

    const weeks = await api("/api/weeks");
    renderWeeksList(weeks);
    return;
  }

  // week_id => show detail
  $("sectionList")?.classList.add("hidden");
  $("sectionDetail")?.classList.remove("hidden");

  const week = await api(`/api/weeks/${weekId}`);
  renderWeekDetail(week);
}

load().catch((e) => {
  console.error(e);
  const errBox = $("reportError");
  if (errBox) errBox.textContent = `Error loading report: ${e.message || "Failed"}`;
  if (e.status === 401) window.location.href = "/";
});
