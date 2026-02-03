(function () {
  // ======================================================
  // 1) CONFIG
  // ======================================================
  const MYM_JSON_URL = "https://keithcreelman.github.io/ups-league-data/mym_dashboard.json";

  // Cloudflare Worker that returns: { ok:true, isAdmin:true/false, reason:"...", emailCount:n }
  // NOTE: This does NOT rely on browser cookies. The Worker uses its own commish cookie server-side.
  const ADMIN_WORKER_URL = "https://ups-league-data.keith-creelman.workers.dev/";

  // If the current page doesn't have ?L= in the URL (common for some custom/home modules),
  // we fall back to these.
  const DEFAULT_LEAGUE_ID = "74598";
  const DEFAULT_YEAR = "2025";

  // ======================================================
  // 2) DOM + SAFE HELPERS
  // ======================================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function safeStr(x) { return (x === null || x === undefined) ? "" : String(x); }
  function safeInt(x) {
    const n = parseInt(String(x).replace(/[^\d-]/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }
  function pad4(fid) {
    const d = safeStr(fid).replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }
  function htmlEsc(s) {
    return safeStr(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseDate(x) {
    const s = safeStr(x).trim();
    if (!s) return null;
    const t = s.replace(" ", "T");
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? (t + ":00") : t;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtYMD(x) {
    const d = parseDate(x);
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function must(sel) {
    const el = $(sel);
    if (!el) throw new Error(`Missing required element: ${sel}`);
    return el;
  }

  // ======================================================
  // 3) URL HELPERS
  // ======================================================
  function getLeagueId() {
    try {
      const u = new URL(window.location.href);
      return u.searchParams.get("L") || "";
    } catch (e) { return ""; }
  }

  function getYear() {
    // Prefer explicit YEAR= in querystring (your Worker supports it)
    try {
      const u = new URL(window.location.href);
      const qYear = u.searchParams.get("YEAR");
      if (qYear) return qYear;
    } catch (e) { /* ignore */ }

    // Otherwise attempt /2025/ style
    const m = window.location.pathname.match(/\/(\d{4})\//);
    return m ? m[1] : "2025";
  }

  // Only used to choose a default team in the dropdown (not for admin)
  function detectFranchiseId() {
    try {
      const u = new URL(window.location.href);
      const qs = u.searchParams;
      const cand =
        qs.get("FRANCHISE_ID") ||
        qs.get("FRANCHISEID") ||
        qs.get("franchise_id") ||
        qs.get("FRANCHISE") ||
        qs.get("F") ||
        qs.get("FR") ||
        "";
      return pad4(cand);
    } catch (e) {
      return "";
    }
  }

  // ======================================================
  // 4) PAYLOAD NORMALIZATION
  // ======================================================
  function normalizePayload(raw) {
    if (Array.isArray(raw)) return { eligibility: raw, usage: [], meta: {} };

    const all = raw.View_MYM_All || raw.view_mym_all || raw.mym_all || null;
    if (Array.isArray(all)) {
      return {
        eligibility: all,
        usage: raw.View_MYM_Usage || raw.usage || [],
        meta: raw.meta || {}
      };
    }

    return {
      eligibility: raw.eligibility || raw.View_MYM_Eligibility || [],
      usage: raw.usage || raw.View_MYM_Usage || [],
      meta: raw.meta || {}
    };
  }

  // ======================================================
  // 5) ADMIN CHECK (WORKER)
  // ======================================================
  async function getAdminFlagFromWorker() {
    let L = getLeagueId();
    let YEAR = getYear();

    // If we're on a module page without ?L=, fall back
    if (!L) L = DEFAULT_LEAGUE_ID;
    if (!YEAR) YEAR = DEFAULT_YEAR;

    const url =
      `${ADMIN_WORKER_URL}?L=${encodeURIComponent(L)}&YEAR=${encodeURIComponent(YEAR)}&_=${Date.now()}`;

    try {
      // Important: no credentials needed; Worker authenticates to MFL server-side.
      const res = await fetch(url, { cache: "no-store" });
      const j = await res.json();

      return {
        ok: !!j.ok,
        isAdmin: !!j.isAdmin,
        reason: safeStr(j.reason || ""),
        emailCount: safeInt(j.emailCount || 0),
        L,
        YEAR
      };
    } catch (e) {
      return { ok: false, isAdmin: false, reason: `Worker check failed: ${e && e.message ? e.message : e}`, L, YEAR };
    }
  }

  // ======================================================
  // 6) ELIGIBILITY OVERRIDE
  // ======================================================
  function computeEligible(row, asOfDate) {
    const acqType = safeStr(row.mym_acq_type || "").toUpperCase();
    if (acqType === "ROOKIE_DRAFT") return 0;

    const deadline = parseDate(row.mym_deadline);
    if (!deadline || !asOfDate) return 0;

    return (asOfDate.getTime() <= deadline.getTime()) ? 1 : 0;
  }

  // (Score logic intentionally kept but not used in UI right now)
  function scoreCandidate(row, asOfDate) {
    const salary = safeInt(row.salary);
    const pos = safeStr(row.positional_grouping || row.position).toUpperCase();
    const eligible = safeInt(row._eligibleEffective) === 1;
    if (!eligible) return 0;

    const deadline = parseDate(row.mym_deadline);
    const urgDays = (deadline && asOfDate)
      ? Math.ceil((deadline.getTime() - asOfDate.getTime()) / (1000 * 60 * 60 * 24))
      : 14;

    const posW = ({
      QB: 1.0, RB: 1.4, WR: 1.2, TE: 1.25,
      DL: 1.05, LB: 1.05, DB: 1.05, S: 1.05, CB: 1.05
    })[pos] || 1.0;

    const salaryScore = Math.max(0, 20000 - salary) / 20000;
    const urgencyScore = Math.max(0, Math.min(1, (14 - urgDays) / 14));

    const score = (salaryScore * 60) + (posW * 20) + (urgencyScore * 20);
    return Math.round(score);
  }

  // ======================================================
  // 7) UI RENDER
  // ======================================================
  function pillForType(acqType) {
    const t = safeStr(acqType).toUpperCase();
    if (t.includes("AUCTION")) return "auction";
    if (t.includes("ROOKIE")) return "rookie";
    return "waiver";
  }

  function renderTable(rows, mode, asOfDate) {
  if (!rows.length) {
    return `<div class="ccc-tableWrap" style="padding:12px;">No rows.</div>`;
  }

  const isEligibleTab = (mode === "eligible");

  const head = `
    <div class="ccc-tableWrap">
      <table class="ccc-table">
        <thead>
          <tr>
            <th style="min-width:180px;">Player</th>
            <th>Pos</th>
            <th>Salary</th>
            <th>Acq Type</th>
            <th>Acquired</th>
            <th>Deadline</th>
            ${isEligibleTab ? `<th style="min-width:140px;">Actions</th>` : ``}
            <th style="min-width:320px;">Explanation</th>
          </tr>
        </thead>
        <tbody>
  `;

  const body = rows.map(r => {
    const player = htmlEsc(r.player_name);
    const pos = htmlEsc(r.positional_grouping || r.position);
    const salaryNum = safeInt(r.salary);
    const salary = salaryNum.toLocaleString();
    const acqType = safeStr(r.mym_acq_type);

    const acquired = htmlEsc(fmtYMD(r.acquired_date));
    const deadline = htmlEsc(fmtYMD(r.mym_deadline));
    const expl = htmlEsc(r.rule_explanation || "");

    // Only show Offer Contract in Eligible tab
    const actions = isEligibleTab
      ? `
        <button
          type="button"
          class="ccc-btn"
          data-offer="1"
          data-player-id="${htmlEsc(r.player_id)}"
          data-player-name="${htmlEsc(r.player_name)}"
          data-salary="${salaryNum}"
          data-franchise-id="${htmlEsc(pad4(r.franchise_id))}"
          data-franchise-name="${htmlEsc(r.franchise_name || "")}"
          data-acq-type="${htmlEsc(acqType)}"
          data-deadline="${htmlEsc(fmtYMD(r.mym_deadline))}"
        >Offer Contract</button>
      `
      : ``;

    return `
      <tr>
        <td class="playerCell">${player}</td>
        <td class="muted">${pos}</td>
        <td>${salary}</td>
        <td><span class="pill ${pillForType(acqType)}">${htmlEsc(acqType)}</span></td>
        <td class="muted">${acquired}</td>
        <td class="muted">${deadline}</td>
        ${isEligibleTab ? `<td>${actions}</td>` : ``}
        <td class="explain">${expl}</td>
      </tr>
    `;
  }).join("");

  return head + body + `</tbody></table></div>`;
}

  function renderSummary(teamName, rowsAll, rowsElig, usageRow, asOfDate, isAdmin) {
    const used = usageRow ? safeInt(usageRow.mym_used) : 0;
    const remaining = usageRow ? safeInt(usageRow.mym_remaining) : 0;

    const soonest = rowsElig
      .map(r => ({ r, d: parseDate(r.mym_deadline) }))
      .filter(x => x.d)
      .sort((a, b) => a.d - b.d)[0];

    const soonestTxt = soonest ? fmtYMD(soonest.r.mym_deadline) : "N/A";
    const asOfTxt = asOfDate ? asOfDate.toISOString().slice(0, 16).replace("T", " ") : "";

    return `
      <div class="ccc-summaryTop">
        <div class="ccc-summaryTitle">${htmlEsc(teamName)} MYM Snapshot</div>
        <div class="muted" style="font-size:12px;">
          ${isAdmin ? `<span class="pill">As-Of: ${htmlEsc(asOfTxt)}</span>` : ``}
        </div>
      </div>

      <div class="ccc-kpis">
        <div class="kpi">
          <div class="label">Eligible Now</div>
          <div class="value">${rowsElig.length}</div>
          <div class="hint">out of ${rowsAll.length} players</div>
        </div>

        <div class="kpi">
          <div class="label">Soonest Deadline</div>
          <div class="value">${htmlEsc(soonestTxt)}</div>
          <div class="hint">earliest eligible deadline</div>
        </div>

        <div class="kpi">
          <div class="label">MYM Used</div>
          <div class="value">${used}</div>
          <div class="hint">successful submissions</div>
        </div>

        <div class="kpi">
          <div class="label">MYM Remaining</div>
          <div class="value">${remaining}</div>
          <div class="hint">cap: 5 per season</div>
        </div>
      </div>
    `;
  }

  // ======================================================
  // 8) STATE + TEAM LIST
  // ======================================================
  const state = {
    payload: { eligibility: [], usage: [], meta: {} },
    isAdmin: false,
    adminReason: "",
    selectedTeam: "__ALL__",
    detectedFranchiseId: "",
    asOfDate: null,
    search: ""
  };

  function buildTeamList(rows) {
    const map = new Map();
    rows.forEach(r => {
      const id = pad4(r.franchise_id);
      const nm = safeStr(r.franchise_name);
      if (id && !map.has(id)) map.set(id, nm || id);
    });

    const list = Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return [{ id: "__ALL__", name: "All Teams" }, ...list];
  }

  function populateTeamSelect(teams, selectedId) {
    const sel = $("#teamSelect");
    if (!sel) return;

    sel.innerHTML = "";
    teams.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      opt.selected = (t.id === selectedId);
      sel.appendChild(opt);
    });
  }

  function getUsageRow(usageRows, franchiseId, season) {
    const seasonStr = safeStr(season);
    let row = usageRows.find(u => pad4(u.franchise_id) === franchiseId && safeStr(u.season) === seasonStr);
    if (!row) row = usageRows.find(u => pad4(u.franchise_id) === franchiseId);
    return row || null;
  }

  function applyEffectiveEligibility(rows, asOfDate) {
    rows.forEach(r => {
      r._eligibleEffective = safeInt(r.eligible_flag);
      if (state.isAdmin && asOfDate) {
        r._eligibleEffective = computeEligible(r, asOfDate);
      }
    });
  }

  function sortRowsNewestAcquired(rows) {
    return rows.sort((a, b) => {
      const aa = parseDate(a.acquired_date) || new Date("1900-01-01");
      const bb = parseDate(b.acquired_date) || new Date("1900-01-01");
      if (bb - aa !== 0) return bb - aa;
      const da = parseDate(a.mym_deadline) || new Date("2999-01-01");
      const db = parseDate(b.mym_deadline) || new Date("2999-01-01");
      return da - db;
    });
  }

  function render() {
    const { eligibility, usage, meta } = state.payload;

    const cccError = $("#cccError");
    const cccMeta = $("#cccMeta");
    const summary = $("#summary");
    const tabEligible = $("#tabEligible");
    const tabIneligible = $("#tabIneligible");

    if (cccError) cccError.textContent = "";

    const asOfDate = state.isAdmin ? state.asOfDate : null;
    applyEffectiveEligibility(eligibility, asOfDate);

    const searchLower = safeStr(state.search).trim().toLowerCase();

    let scoped = eligibility;
    if (state.selectedTeam !== "__ALL__") {
      const fid = pad4(state.selectedTeam);
      scoped = scoped.filter(r => pad4(r.franchise_id) === fid);
    }
    if (searchLower) {
      scoped = scoped.filter(r => safeStr(r.player_name).toLowerCase().includes(searchLower));
    }

    const season = scoped[0] ? scoped[0].season : (eligibility[0] ? eligibility[0].season : "");
    const built = (meta && meta.generated_at) ? safeStr(meta.generated_at) : "";
    const minSeason = (meta && meta.min_season) ? safeStr(meta.min_season) : "";

    if (cccMeta) {
      cccMeta.textContent =
        `Season: ${season || "?"}` +
        (built ? ` | built: ${built}` : "") +
        (minSeason ? ` | min season: ${minSeason}` : "") +
        (state.isAdmin ? ` | admin: yes` : "") +
        (state.adminReason ? ` | ${state.adminReason}` : "");
    }

    const eligibleRows = sortRowsNewestAcquired(scoped.filter(r => safeInt(r._eligibleEffective) === 1));
    const ineligibleRows = sortRowsNewestAcquired(scoped.filter(r => safeInt(r._eligibleEffective) !== 1));

    const teamName =
      (state.selectedTeam === "__ALL__") ? "All Teams" :
      (scoped[0] ? safeStr(scoped[0].franchise_name) : "Team");

    let usageRow = null;
    if (state.selectedTeam !== "__ALL__") {
      usageRow = getUsageRow(usage, pad4(state.selectedTeam), season);
    } else {
      const used = usage.reduce((acc, u) => acc + safeInt(u.mym_used), 0);
      const remaining = usage.reduce((acc, u) => acc + safeInt(u.mym_remaining), 0);
      usageRow = { mym_used: used, mym_remaining: remaining };
    }

    if (summary) summary.innerHTML = renderSummary(teamName, scoped, eligibleRows, usageRow, asOfDate, state.isAdmin);
    if (tabEligible) tabEligible.innerHTML = renderTable(eligibleRows, "eligible", asOfDate || new Date());
    if (tabIneligible) tabIneligible.innerHTML = renderTable(ineligibleRows, "ineligible", asOfDate || new Date());
  }

  // ======================================================
  // 9) LOAD
  // ======================================================
  async function load() {
    try {
      // Ensure required elements exist (fail loud)
      must("#cccMeta");
      must("#tabEligible");
      must("#tabIneligible");
      must("#teamSelect");
      must("#searchBox");
      must("#adminBadge");
      must("#adminControls");
      must("#asOfInput");
      must("#asOfResetBtn");
      must("#refreshBtn");
      must("#clearBtn");

      $("#cccMeta").textContent = "Loading MYM data…";

      // 1) Load MYM dashboard JSON
      const bust = (MYM_JSON_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const res = await fetch(MYM_JSON_URL + bust, { cache: "no-store" });
      if (!res.ok) throw new Error("MYM JSON HTTP " + res.status);

      const raw = await res.json();
      state.payload = normalizePayload(raw);

      // 2) Determine admin via Worker (server-side cookie)
      state.detectedFranchiseId = detectFranchiseId();

      const admin = await getAdminFlagFromWorker();
      state.isAdmin = !!admin.isAdmin;
      state.adminReason = safeStr(admin.reason || "");

      console.log("[CCC] admin via Worker:", admin);

      // 3) Toggle admin UI
      $("#adminBadge").style.display = state.isAdmin ? "" : "none";
      $("#adminControls").style.display = state.isAdmin ? "flex" : "none";

      // 4) As-of defaults (admin only)
      if (state.isAdmin) {
        const now = new Date();
        state.asOfDate = now;

        const pad = (n) => String(n).padStart(2, "0");
        $("#asOfInput").value =
          `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      } else {
        state.asOfDate = null;
        $("#asOfInput").value = "";
      }

      // 5) Build team list / default selection
      const teams = buildTeamList(state.payload.eligibility);
      const detected = teams.some(t => t.id === state.detectedFranchiseId) ? state.detectedFranchiseId : "__ALL__";
      state.selectedTeam = detected;

      populateTeamSelect(teams, state.selectedTeam);

      // 6) Render + default tab
      setTab("eligible");
      render();

    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const cccError = $("#cccError");
      const cccMeta = $("#cccMeta");
      if (cccMeta) cccMeta.textContent = "";
      if (cccError) cccError.textContent = "Could not load MYM dashboard: " + msg;
      console.error(e);
    }
  }
// =========================
// 9B - MYM Modal State + Wiring
// =========================
const mymModalState = {
  open: false,
  row: null,      // selected player row info
  years: 2        // default MYM-2
};

function formatK(n) {
  // assumes integer dollars
  const v = safeInt(n);
  return (v % 1000 === 0) ? `${v/1000}K` : `${v}`;
}

function computeGuarantee(salary, years) {
  const s = safeInt(salary);
  const y = safeInt(years);
  const tcv = s * y;

  // Rule:
  // if TCV > 4K => 75% TCV
  // else => (years-1)*salary
  if (tcv > 4000) return Math.round(tcv * 0.75);
  return Math.max(0, (y - 1) * s);
}

function buildContractInfo(salary, years) {
  const s = safeInt(salary);
  const y = safeInt(years);
  const tcv = s * y;
  const aav = s;
  const gtd = computeGuarantee(s, y);

  const parts = [];
  parts.push(`CL ${y}`);
  parts.push(`TCV ${formatK(tcv)}`);
  parts.push(`AAV ${formatK(aav)}`);

  const yearParts = [];
  yearParts.push(`Y1-${formatK(s)}`);
  yearParts.push(`Y2-${formatK(s)}`);
  if (y === 3) yearParts.push(`Y3-${formatK(s)}`);

  parts.push(yearParts.join(", "));
  parts.push(`GTD: ${formatK(gtd)}`);

  return {
    years: y,
    tcv,
    aav,
    gtd,
    contractInfo: parts.join("| ")
  };
}

function ensureModalExists() {
  const modal = $("#mymModal");
  if (!modal) throw new Error("Missing #mymModal in HTML. Add the modal markup.");
  return modal;
}

function setModalOption(years) {
  mymModalState.years = years;

  const btn2 = $("#btnMYM2");
  const btn3 = $("#btnMYM3");
  if (btn2 && btn3) {
    btn2.classList.toggle("primary", years === 2);
    btn3.classList.toggle("primary", years === 3);
  }

  renderModalSummary();
}

function renderModalSummary() {
  const row = mymModalState.row;
  if (!row) return;

  const salary = safeInt(row.salary);
  const years = mymModalState.years;

  const calc = buildContractInfo(salary, years);

  $("#mymYears").textContent = String(calc.years);
  $("#mymTCV").textContent   = safeInt(calc.tcv).toLocaleString();
  $("#mymAAV").textContent   = safeInt(calc.aav).toLocaleString();
  $("#mymGTD").textContent   = safeInt(calc.gtd).toLocaleString();
  $("#mymContractInfo").textContent = calc.contractInfo;

  // As-of pill only for admin
  const pill = $("#mymAsOfPill");
  if (pill) {
    if (state.isAdmin && state.asOfDate) {
      pill.style.display = "";
      pill.textContent = `As-Of: ${state.asOfDate.toISOString().slice(0,16).replace("T"," ")}`;
    } else {
      pill.style.display = "none";
    }
  }
}

function openMYMModal(row) {
  ensureModalExists();
  mymModalState.row = row;
  mymModalState.open = true;
  mymModalState.years = 2; // default MYM-2

  const sub = $("#mymModalSub");
  if (sub) {
    sub.textContent = `${row.player_name} | Salary: ${safeInt(row.salary).toLocaleString()} | Team: ${row.franchise_name || row.franchise_id}`;
  }

  $("#mymModalErr").style.display = "none";
  $("#mymModalErr").textContent = "";

  setModalOption(2);

  $("#mymModal").style.display = "";
  document.body.style.overflow = "hidden";
}

function closeMYMModal() {
  const modal = $("#mymModal");
  if (!modal) return;

  modal.style.display = "none";
  document.body.style.overflow = "";
  mymModalState.open = false;
  mymModalState.row = null;
}

// You will point this at YOUR server-side endpoint that does the MFL import.
// For now it just logs what WOULD be sent.
async function submitMYMContract() {
  const row = mymModalState.row;
  if (!row) return;

  const salary = safeInt(row.salary);
  const years = mymModalState.years;
  const calc = buildContractInfo(salary, years);

  // This is the payload you will POST to your Worker/Python service
  const payload = {
    type: "MYM",
    leagueId: getLeagueId() || DEFAULT_LEAGUE_ID,
    year: getYear() || DEFAULT_YEAR,
    player_id: safeStr(row.player_id),
    salary: salary,
    contract_year: years,
    contract_info: calc.contractInfo,
    tcv: calc.tcv,
    aav: calc.aav,
    guaranteed: calc.gtd
  };

  console.log("[MYM submit payload]", payload);

  // TODO: replace with real POST call when your Worker endpoint is ready:
  // const res = await fetch("https://YOUR-WORKER-ENDPOINT/offer-mym", {
  //   method:"POST",
  //   headers:{ "Content-Type":"application/json" },
  //   body: JSON.stringify(payload)
  // });
  // const j = await res.json();
  // if(!res.ok || !j.ok) throw new Error(j.error || "MFL import failed");

  closeMYMModal();
}
  // ======================================================
  // 10) TABS + EVENTS
  // ======================================================
  function setTab(tab) {
    const tabEligible = $("#tabEligible");
    const tabIneligible = $("#tabIneligible");

    if (tabEligible) tabEligible.style.display = (tab === "eligible") ? "" : "none";
    if (tabIneligible) tabIneligible.style.display = (tab === "ineligible") ? "" : "none";

    $$(".ccc-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  }

  function wireEvents() {
    $$(".ccc-tab").forEach(btn => {
      btn.addEventListener("click", () => setTab(btn.dataset.tab));
    });

    const teamSelect = $("#teamSelect");
    if (teamSelect) {
      teamSelect.addEventListener("change", (e) => {
        state.selectedTeam = e.target.value;
        render();
      });
    }

    const searchBox = $("#searchBox");
    if (searchBox) {
      searchBox.addEventListener("input", (e) => {
        state.search = e.target.value;
        render();
      });
    }

    const clearBtn = $("#clearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const sb = $("#searchBox");
        if (sb) sb.value = "";
        state.search = "";
        render();
      });
    }

    const refreshBtn = $("#refreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => load());
    }

    const asOfInput = $("#asOfInput");
    if (asOfInput) {
      asOfInput.addEventListener("change", () => {
        if (!state.isAdmin) return;
        const v = asOfInput.value;
        const d = v ? new Date(v) : new Date();
        state.asOfDate = isNaN(d.getTime()) ? new Date() : d;
        render();
      });
    }

    const asOfResetBtn = $("#asOfResetBtn");
    if (asOfResetBtn) {
      asOfResetBtn.addEventListener("click", () => {
        if (!state.isAdmin) return;
        const now = new Date();
        state.asOfDate = now;

        const pad = (n) => String(n).padStart(2, "0");
        $("#asOfInput").value =
          `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

        render();
      });
    }
  }
/* ===== Modal ===== */
.ccc-modal{ position:fixed; inset:0; z-index:9999; }
.ccc-modal-backdrop{ position:absolute; inset:0; background:rgba(0,0,0,.55); }
.ccc-modal-card{
  position:relative;
  max-width: 720px;
  margin: 6vh auto;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: radial-gradient(900px 500px at 25% 10%, rgba(78,161,255,.18), transparent 60%),
              radial-gradient(900px 500px at 85% 10%, rgba(139,92,255,.16), transparent 60%),
              linear-gradient(180deg, rgba(255,255,255,.06), rgba(0,0,0,.25));
  box-shadow: var(--shadow);
  overflow:hidden;
}
.ccc-modal-head{
  display:flex; justify-content:space-between; align-items:flex-start;
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--line);
}
.ccc-modal-title{ font-size:16px; font-weight:1000; }
.ccc-modal-sub{ margin-top:4px; font-size:12px; }
.ccc-modal-x{
  background: rgba(255,255,255,.08);
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: 10px;
  padding: 6px 10px;
  cursor:pointer;
  font-weight:1000;
}
.ccc-modal-body{ padding: 12px 14px; }
.ccc-modal-row{ padding: 6px 0; }
.ccc-modal-label{ font-size:12px; color: var(--muted); font-weight:900; margin-bottom:8px; }
.ccc-modal-actions{ display:flex; gap:10px; flex-wrap:wrap; }
.ccc-modal-foot{
  display:flex; justify-content:flex-end; gap:10px;
  padding: 12px 14px;
  border-top: 1px solid var(--line);
}
.ccc-code{
  border: 1px solid var(--line);
  background: rgba(0,0,0,.22);
  border-radius: 12px;
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  color: rgba(233,238,249,.92);
  white-space: pre-wrap;
  word-break: break-word;
}
  // ======================================================
  // START
  // ======================================================
  // Make sure DOM is ready before wiring up + load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      wireEvents();
      load();
    });
  } else {
    wireEvents();
    load();
  }
})();
