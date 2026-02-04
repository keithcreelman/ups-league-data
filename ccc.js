(function () {
  "use strict";

  // ======================================================
  // 1) CONFIG
  // ======================================================
  const MYM_JSON_URL = "https://keithcreelman.github.io/ups-league-data/mym_dashboard.json";

  // Cloudflare Worker: { ok:true, isAdmin:true/false, reason:"...", emailCount:n }
  const ADMIN_WORKER_URL = "https://ups-league-data.keith-creelman.workers.dev/";

  // Fallbacks if page URL lacks ?L= or YEAR=
  const DEFAULT_LEAGUE_ID = "74598";
  const DEFAULT_YEAR = "2025";

  // MYM submit endpoint
  const OFFER_MYM_URL = "https://ups-league-data.keith-creelman.workers.dev/offer-mym";

  // ======================================================
  // 2) DOM + SAFE HELPERS
  // ======================================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function safeStr(x) {
    return x === null || x === undefined ? "" : String(x);
  }

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
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? t + ":00" : t;
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

  function fmtLocalYMDHM(d) {
    if (!d || isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${da} ${h}:${mi}`;
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
    } catch (e) {
      return "";
    }
  }

  function getYear() {
    try {
      const u = new URL(window.location.href);
      const qYear = u.searchParams.get("YEAR");
      if (qYear) return qYear;
    } catch (e) {}

    const m = window.location.pathname.match(/\/(\d{4})\//);
    return m ? m[1] : DEFAULT_YEAR;
  }

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
        meta: raw.meta || {},
      };
    }

    return {
      eligibility: raw.eligibility || raw.View_MYM_Eligibility || [],
      usage: raw.usage || raw.View_MYM_Usage || [],
      meta: raw.meta || {},
    };
  }

  // ======================================================
  // 5) ADMIN CHECK (WORKER)
  // ======================================================
  async function getAdminFlagFromWorker() {
    let L = getLeagueId();
    let YEAR = getYear();

    if (!L) L = DEFAULT_LEAGUE_ID;
    if (!YEAR) YEAR = DEFAULT_YEAR;

    const url = `${ADMIN_WORKER_URL}?L=${encodeURIComponent(L)}&YEAR=${encodeURIComponent(
      YEAR
    )}&_=${Date.now()}`;

    try {
      const res = await fetch(url, { cache: "no-store" });
      const j = await res.json();

      return {
        ok: !!j.ok,
        isAdmin: !!j.isAdmin,
        reason: safeStr(j.reason || ""),
        emailCount: safeInt(j.emailCount || 0),
        L,
        YEAR,
      };
    } catch (e) {
      return {
        ok: false,
        isAdmin: false,
        reason: `Worker check failed: ${e && e.message ? e.message : e}`,
        L,
        YEAR,
      };
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

    return asOfDate.getTime() <= deadline.getTime() ? 1 : 0;
  }

  // ======================================================
  // 7) SORT + TABLE RENDER
  // ======================================================
  function pillForType(acqType) {
    const t = safeStr(acqType).toUpperCase();
    if (t.includes("AUCTION")) return "auction";
    if (t.includes("ROOKIE")) return "rookie";
    return "waiver";
  }

  function posKeyFromRow(r) {
    const p = safeStr(r.positional_grouping || r.position).toUpperCase().trim();
    if (["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB"].includes(p)) return p;
    return p || "NA";
  }

  const sortState = {
    tab: "eligible",
    key: "acquired",
    dir: "desc", // asc | desc
  };

  function compareVals(a, b, dir) {
    if (a === b) return 0;
    const d = dir === "asc" ? 1 : -1;
    return a > b ? d : -d;
  }

  function getSortValue(r, key) {
    switch (key) {
      case "player":
        return safeStr(r.player_name).toLowerCase();
      case "pos":
        return safeStr(r.positional_grouping || r.position).toLowerCase();
      case "salary":
        return safeInt(r.salary);
      case "acqType":
        return safeStr(r.mym_acq_type).toLowerCase();
      case "acquired":
        return (parseDate(r.acquired_date) || new Date("1900-01-01")).getTime();
      case "deadline":
        return (parseDate(r.mym_deadline) || new Date("2999-01-01")).getTime();
      default:
        return safeStr(r.player_name).toLowerCase();
    }
  }

  function sortRows(rows, key, dir) {
    const copy = rows.slice();
    copy.sort((ra, rb) => {
      const a = getSortValue(ra, key);
      const b = getSortValue(rb, key);
      return compareVals(a, b, dir);
    });
    return copy;
  }

  function sortIcon(tab, key) {
    if (sortState.tab !== tab) return "";
    if (sortState.key !== key) return "";
    return sortState.dir === "asc" ? "▲" : "▼";
  }

  function renderTable(rows, tabMode) {
    if (!rows.length) {
      return `<div class="ccc-tableWrap" style="padding:12px;">No rows.</div>`;
    }

    const isEligibleTab = tabMode === "eligible";

    const head = `
      <div class="ccc-tableWrap" data-table="${tabMode}">
        <table class="ccc-table">
          <thead>
            <tr>
              ${isEligibleTab ? `<th style="min-width:140px;">Actions</th>` : ``}
              <th data-sort="player">Player <span class="sort">${sortIcon(tabMode, "player")}</span></th>
              <th data-sort="pos">Pos <span class="sort">${sortIcon(tabMode, "pos")}</span></th>
              <th data-sort="salary">Salary <span class="sort">${sortIcon(tabMode, "salary")}</span></th>
              <th data-sort="acquired">Acquired <span class="sort">${sortIcon(tabMode, "acquired")}</span></th>
              <th data-sort="deadline">Deadline <span class="sort">${sortIcon(tabMode, "deadline")}</span></th>
              ${isEligibleTab ? `` : `<th style="min-width:320px;">Explanation</th>`}
            </tr>
          </thead>
          <tbody>
    `;

    const body = rows
      .map((r) => {
        const player = htmlEsc(r.player_name);
        const posDisp = htmlEsc(r.positional_grouping || r.position);
        const posKey = htmlEsc(posKeyFromRow(r));
        const salaryNum = safeInt(r.salary);
        const salary = salaryNum.toLocaleString();
        const acqType = safeStr(r.mym_acq_type);

        const acquired = htmlEsc(fmtYMD(r.acquired_date));
        const deadline = htmlEsc(fmtYMD(r.mym_deadline));
        const expl = htmlEsc(r.rule_explanation || "");

        const actions = isEligibleTab
          ? `
          <button
            type="button"
            class="ccc-btn ccc-btn-offer"
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
        <tr class="pos-${posKey}">
          ${isEligibleTab ? `<td>${actions}</td>` : ``}
          <td class="playerCell">${player}</td>
          <td class="muted">${posDisp}</td>
          <td>${salary}</td>
          <td class="muted">${acquired}</td>
          <td class="muted">${deadline}</td>
          ${isEligibleTab ? `` : `<td class="explain">${expl}</td>`}
        </tr>
      `;
      })
      .join("");

    return head + body + `</tbody></table></div>`;
  }

  function renderSummary(teamName, rowsAll, rowsElig, usageRow, asOfDate, isAdmin) {
    const used = usageRow ? safeInt(usageRow.mym_used) : 0;
    const remaining = usageRow ? safeInt(usageRow.mym_remaining) : 0;

    const soonest = rowsElig
      .map((r) => ({ r, d: parseDate(r.mym_deadline) }))
      .filter((x) => x.d)
      .sort((a, b) => a.d - b.d)[0];

    const soonestTxt = soonest ? fmtYMD(soonest.r.mym_deadline) : "N/A";
    const asOfTxt = asOfDate ? fmtLocalYMDHM(asOfDate) : "";

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
    search: "",
    activeTab: "eligible",
  };

  function buildTeamList(rows) {
    const map = new Map();
    rows.forEach((r) => {
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
    teams.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      opt.selected = t.id === selectedId;
      sel.appendChild(opt);
    });
  }

  function getUsageRow(usageRows, franchiseId, season) {
    const seasonStr = safeStr(season);
    let row = usageRows.find(
      (u) => pad4(u.franchise_id) === franchiseId && safeStr(u.season) === seasonStr
    );
    if (!row) row = usageRows.find((u) => pad4(u.franchise_id) === franchiseId);
    return row || null;
  }

  function applyEffectiveEligibility(rows, asOfDate) {
    rows.forEach((r) => {
      r._eligibleEffective = safeInt(r.eligible_flag);
      if (state.isAdmin && asOfDate) {
        r._eligibleEffective = computeEligible(r, asOfDate);
      }
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

    let scoped = eligibility.slice();
    if (state.selectedTeam !== "__ALL__") {
      const fid = pad4(state.selectedTeam);
      scoped = scoped.filter((r) => pad4(r.franchise_id) === fid);
    }
    if (searchLower) {
      scoped = scoped.filter((r) =>
        safeStr(r.player_name).toLowerCase().includes(searchLower)
      );
    }

    const season = scoped[0] ? scoped[0].season : eligibility[0] ? eligibility[0].season : "";
    const built = meta && meta.generated_at ? safeStr(meta.generated_at) : "";
    const minSeason = meta && meta.min_season ? safeStr(meta.min_season) : "";

    if (cccMeta) {
      cccMeta.textContent =
        `Season: ${season || "?"}` +
        (built ? ` | built: ${built}` : "") +
        (minSeason ? ` | min season: ${minSeason}` : "") +
        (state.isAdmin ? ` | admin: yes` : "") +
        (state.adminReason ? ` | ${state.adminReason}` : "");
    }

    const eligibleRowsRaw = scoped.filter((r) => safeInt(r._eligibleEffective) === 1);
    const ineligibleRowsRaw = scoped.filter((r) => safeInt(r._eligibleEffective) !== 1);

    const eligibleRows = sortRows(
      eligibleRowsRaw,
      sortState.tab === "eligible" ? sortState.key : "acquired",
      sortState.tab === "eligible" ? sortState.dir : "desc"
    );

    const ineligibleRows = sortRows(
      ineligibleRowsRaw,
      sortState.tab === "ineligible" ? sortState.key : "acquired",
      sortState.tab === "ineligible" ? sortState.dir : "desc"
    );

    const teamName =
      state.selectedTeam === "__ALL__"
        ? "All Teams"
        : scoped[0]
        ? safeStr(scoped[0].franchise_name)
        : "Team";

    let usageRow = null;
    if (state.selectedTeam !== "__ALL__") {
      usageRow = getUsageRow(usage, pad4(state.selectedTeam), season);
    } else {
      const used = usage.reduce((acc, u) => acc + safeInt(u.mym_used), 0);
      const remaining = usage.reduce((acc, u) => acc + safeInt(u.mym_remaining), 0);
      usageRow = { mym_used: used, mym_remaining: remaining };
    }

    if (summary) summary.innerHTML = renderSummary(teamName, scoped, eligibleRows, usageRow, asOfDate, state.isAdmin);
    if (tabEligible) tabEligible.innerHTML = renderTable(eligibleRows, "eligible");
    if (tabIneligible) tabIneligible.innerHTML = renderTable(ineligibleRows, "ineligible");
  }

  // ======================================================
  // 9B) MODAL STATE + HELPERS
  // ======================================================
  const mymModalState = { open: false, row: null, years: 2 };

  function formatK(n) {
    const v = safeInt(n);
    return v % 1000 === 0 ? `${v / 1000}K` : `${v}`;
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

    return { years: y, tcv, aav, gtd, contractInfo: parts.join("| ") };
  }

  function ensureModalExists() {
    const modal = $("#mymModal");
    if (!modal) throw new Error("Missing #mymModal in HTML.");
    return modal;
  }

  function renderModalSummary() {
    const row = mymModalState.row;
    if (!row) return;

    const salary = safeInt(row.salary);
    const years = mymModalState.years;
    const calc = buildContractInfo(salary, years);

    $("#mymYears").textContent = String(calc.years);
    $("#mymTCV").textContent = safeInt(calc.tcv).toLocaleString();
    $("#mymAAV").textContent = safeInt(calc.aav).toLocaleString();
    $("#mymGTD").textContent = safeInt(calc.gtd).toLocaleString();
    $("#mymContractInfo").textContent = calc.contractInfo;

    const pill = $("#mymAsOfPill");
    if (pill) {
      if (state.isAdmin && state.asOfDate) {
        pill.style.display = "";
        pill.textContent = `As-Of: ${fmtLocalYMDHM(state.asOfDate)}`;
      } else {
        pill.style.display = "none";
      }
    }
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

  function openMYMModal(row) {
    ensureModalExists();
    mymModalState.row = row;
    mymModalState.open = true;
    mymModalState.years = 2;

    const title = $("#mymModalTitle");
    if (title) {
      title.textContent = `Offer MYM Contract - ${row.player_name}`;
    }

    const sub = $("#mymModalSub");
    if (sub) {
      sub.textContent = `Salary: ${safeInt(row.salary).toLocaleString()} | Team: ${row.franchise_name || row.franchise_id}`;
    }

    const err = $("#mymModalErr");
    if (err) {
      err.style.display = "none";
      err.textContent = "";
    }

    setModalOption(2);

    const modal = $("#mymModal");
    modal.classList.add("is-open");
    document.body.classList.add("ccc-modalOpen");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeMYMModal() {
    const modal = $("#mymModal");
    if (!modal) return;

    modal.classList.remove("is-open");
    document.body.classList.remove("ccc-modalOpen");
    modal.setAttribute("aria-hidden", "true");

    mymModalState.open = false;
    mymModalState.row = null;
  }

  // ✅ FIXED: single, clean submit function (no duplicate try blocks)
  async function submitMYMContract() {
  const row = mymModalState.row;
  if (!row) return;

  const L = getLeagueId() || DEFAULT_LEAGUE_ID;
  const YEAR = getYear() || DEFAULT_YEAR;

  const salary = safeInt(row.salary);
  const years = mymModalState.years;
  const calc = buildContractInfo(salary, years);
  const isRookie = safeStr(row.mym_acq_type).toLowerCase().includes("rookie") || /\(R\)/i.test(safeStr(row.player_name));

  // Keep payload keys aligned with the Worker/MFL contract expectations.
  const payload = {
    L: String(L),
    YEAR: String(YEAR),
    aav: safeInt(calc.aav),
    contract_info: String(calc.contractInfo),
    contract_status: isRookie ? "Rookie-MYM" : "MYM",
    contract_year: safeInt(years),
    guaranteed: safeInt(calc.gtd),
    leagueId: String(L),
    player_id: String(row.player_id),
    salary: safeInt(salary),
    tcv: safeInt(calc.tcv),
    type: "MYM",
    year: String(YEAR)
  };

  console.log("[MYM submit payload]", payload);

  const btn = $("#mymSubmitBtn");
  const err = $("#mymModalErr");
  if (err) { err.style.display = "none"; err.textContent = ""; }
  if (btn) { btn.disabled = true; btn.textContent = "Submitting..."; }

  try {
    // ✅ ALSO put required params in querystring (what your Worker is likely checking)
    const url =
      `${OFFER_MYM_URL}?L=${encodeURIComponent(L)}&YEAR=${encodeURIComponent(YEAR)}`;

    let res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    // Fallback for endpoints that parse form bodies instead of JSON.
    if (!res.ok) {
      const form = new URLSearchParams();
      Object.entries(payload).forEach(([k, v]) => form.set(k, String(v)));
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: form.toString()
      });
    }

    // Worker might return JSON OR text on error
    const text = await res.text();
    let out = {};
    try { out = text ? JSON.parse(text) : {}; } catch (_) {}

    if (!res.ok || out.ok !== true) {
      const msg =
        (out &&
          (out.error ||
            (out.reason
              ? out.upstreamPreview
                ? `${out.reason}: ${String(out.upstreamPreview).slice(0, 280)}`
                : out.reason
              : ""))) ||
        (text && text.slice(0, 300)) ||
        `Submit failed (HTTP ${res.status})`;

      if (err) {
        err.style.display = "";
        err.textContent = msg;
      }
      return; // do NOT close modal on failure
    }

    if (out && out.preCheck) {
      console.log("[MYM preCheck]", out.preCheck);
    }
    if (out && out.postCheck) {
      console.log("[MYM postCheck]", out.postCheck);
    }
    if (out && out.submitDebug) {
      console.log("[MYM submitDebug]", out.submitDebug);
    }

    closeMYMModal();
    await load(); // refresh dashboard
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (err) {
      err.style.display = "";
      err.textContent = msg;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Submit Contract"; }
  }
}

  // ======================================================
  // 9) LOAD
  // ======================================================
  async function load() {
    try {
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

      // Modal required elements
      must("#mymModal");
      must("#btnMYM2");
      must("#btnMYM3");
      must("#mymSubmitBtn");

      $("#cccMeta").textContent = "Loading MYM data…";

      const bust = (MYM_JSON_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const res = await fetch(MYM_JSON_URL + bust, { cache: "no-store" });
      if (!res.ok) throw new Error("MYM JSON HTTP " + res.status);

      const raw = await res.json();
      state.payload = normalizePayload(raw);

      state.detectedFranchiseId = detectFranchiseId();

      const admin = await getAdminFlagFromWorker();
      state.isAdmin = !!admin.isAdmin;
      state.adminReason = safeStr(admin.reason || "");

      $("#adminBadge").style.display = state.isAdmin ? "" : "none";
      $("#adminControls").style.display = state.isAdmin ? "flex" : "none";

      if (state.isAdmin) {
        const now = new Date();
        state.asOfDate = now;
        const pad = (n) => String(n).padStart(2, "0");
        $("#asOfInput").value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
          now.getDate()
        )}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      } else {
        state.asOfDate = null;
        $("#asOfInput").value = "";
      }

      const teams = buildTeamList(state.payload.eligibility);
      const detected = teams.some((t) => t.id === state.detectedFranchiseId)
        ? state.detectedFranchiseId
        : "__ALL__";
      state.selectedTeam = detected;

      populateTeamSelect(teams, state.selectedTeam);

      setTab("eligible");

      // default sort per tab
      sortState.tab = "eligible";
      sortState.key = "acquired";
      sortState.dir = "desc";

      render();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const cccError = $("#cccError");
      const cccMeta = $("#cccMeta");
      if (cccMeta) cccMeta.textContent = "";
      if (cccError) cccError.textContent = "Could not load MYM dashboard: " + msg;
      console.error(e);
    }
  }

  // ======================================================
  // 10) TABS + EVENTS
  // ======================================================
  function setTab(tab) {
    state.activeTab = tab;

    const tabEligible = $("#tabEligible");
    const tabIneligible = $("#tabIneligible");

    if (tabEligible) tabEligible.style.display = tab === "eligible" ? "" : "none";
    if (tabIneligible) tabIneligible.style.display = tab === "ineligible" ? "" : "none";

    $$(".ccc-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  }

  function handleHeaderSortClick(th, tableMode) {
    const key = th.getAttribute("data-sort");
    if (!key) return;

    if (sortState.tab !== tableMode) {
      sortState.tab = tableMode;
      sortState.key = key;
      sortState.dir = "asc";
    } else {
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = key;
        sortState.dir = "asc";
      }
    }

    render();
  }

  function wireEvents() {
    // Tabs
    $$(".ccc-tab").forEach((btn) =>
      btn.addEventListener("click", () => {
        setTab(btn.dataset.tab);
        render();
      })
    );

    // Filters
    const teamSelect = $("#teamSelect");
    if (teamSelect)
      teamSelect.addEventListener("change", (e) => {
        state.selectedTeam = e.target.value;
        render();
      });

    const searchBox = $("#searchBox");
    if (searchBox)
      searchBox.addEventListener("input", (e) => {
        state.search = e.target.value;
        render();
      });

    const clearBtn = $("#clearBtn");
    if (clearBtn)
      clearBtn.addEventListener("click", () => {
        $("#searchBox").value = "";
        state.search = "";
        render();
      });

    const refreshBtn = $("#refreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", () => load());

    // Admin as-of
    const asOfInput = $("#asOfInput");
    if (asOfInput)
      asOfInput.addEventListener("change", () => {
        if (!state.isAdmin) return;
        const v = asOfInput.value;
        const d = v ? new Date(v) : new Date();
        state.asOfDate = isNaN(d.getTime()) ? new Date() : d;
        render();
      });

    const asOfResetBtn = $("#asOfResetBtn");
    if (asOfResetBtn)
      asOfResetBtn.addEventListener("click", () => {
        if (!state.isAdmin) return;
        const now = new Date();
        state.asOfDate = now;
        const pad = (n) => String(n).padStart(2, "0");
        $("#asOfInput").value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
          now.getDate()
        )}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        render();
      });

    // TABLE SORT (event delegation)
    document.addEventListener(
      "click",
      (e) => {
        const th = e.target && e.target.closest ? e.target.closest("th[data-sort]") : null;
        if (!th) return;

        const wrap = th.closest ? th.closest(".ccc-tableWrap") : null;
        if (!wrap) return;

        const tableMode = wrap.getAttribute("data-table") || "eligible";
        handleHeaderSortClick(th, tableMode);
      },
      true
    );

    // OPEN MODAL (capture + stopImmediatePropagation beats MFL handlers)
    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target && e.target.closest ? e.target.closest("[data-offer='1']") : null;
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const row = {
          player_id: btn.getAttribute("data-player-id"),
          player_name: btn.getAttribute("data-player-name"),
          salary: safeInt(btn.getAttribute("data-salary")),
          franchise_id: btn.getAttribute("data-franchise-id"),
          franchise_name: btn.getAttribute("data-franchise-name"),
          mym_acq_type: btn.getAttribute("data-acq-type"),
          mym_deadline: btn.getAttribute("data-deadline"),
        };

        openMYMModal(row);
      },
      true
    );

    // Close modal (backdrop/X/cancel)
    const modal = $("#mymModal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        const close = e.target && e.target.getAttribute && e.target.getAttribute("data-close");
        if (close === "1") closeMYMModal();
      });
    }

    // Escape closes modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const modalEl = $("#mymModal");
        if (modalEl && modalEl.classList.contains("is-open")) closeMYMModal();
      }
    });

    // Modal option buttons
    const btn2 = $("#btnMYM2");
    const btn3 = $("#btnMYM3");
    if (btn2) btn2.addEventListener("click", () => setModalOption(2));
    if (btn3) btn3.addEventListener("click", () => setModalOption(3));

    // Submit
    const submitBtn = $("#mymSubmitBtn");
    if (submitBtn) submitBtn.addEventListener("click", () => submitMYMContract());
  }

  // ======================================================
  // START
  // ======================================================
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
