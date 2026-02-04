(function () {
  "use strict";

  // ======================================================
  // 1) CONFIG
  // ======================================================
  const MYM_JSON_URL = "https://keithcreelman.github.io/ups-league-data/mym_dashboard.json";
  const MYM_SUBMISSIONS_URL = "https://keithcreelman.github.io/ups-league-data/mym_submissions.json";
  const RESTRUCTURE_SUBMISSIONS_URL =
    "https://keithcreelman.github.io/ups-league-data/restructure_submissions.json";
  const SEASON_CAP_PER_TEAM = 5;
  const RESTRUCTURE_CAP_PER_TEAM = 3;
  const MYM_EVENTS_BY_SEASON = {
    "2024": { contract_deadline: "2024-09-01", season_complete: "2024-12-30" },
    "2025": { contract_deadline: "2025-08-31", season_complete: "2025-12-29" },
    "2026": { contract_deadline: "2026-09-06", season_complete: "2026-12-29" },
  };

  // Cloudflare Worker: { ok:true, isAdmin:true/false, reason:"...", emailCount:n }
  const ADMIN_WORKER_URL = "https://ups-league-data.keith-creelman.workers.dev/";

  // Fallbacks if page URL lacks ?L= or YEAR=
  const DEFAULT_LEAGUE_ID = "74598";
  const DEFAULT_YEAR = "2025";

  // MYM submit endpoint
  const OFFER_MYM_URL = "https://ups-league-data.keith-creelman.workers.dev/offer-mym";
  const OFFER_RESTRUCTURE_URL =
    "https://ups-league-data.keith-creelman.workers.dev/offer-restructure";
  const COMMISH_CONTRACT_UPDATE_URL =
    "https://ups-league-data.keith-creelman.workers.dev/commish-contract-update";
  const ROSTER_REFRESH_URL = "https://ups-league-data.keith-creelman.workers.dev/refresh-mym-json";

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

  function fmtLocalFromValue(x) {
    const d = parseDate(x);
    return d ? fmtLocalYMDHM(d) : "";
  }

  function must(sel) {
    const el = $(sel);
    if (!el) throw new Error(`Missing required element: ${sel}`);
    return el;
  }

  const LOCAL_OVERRIDE_KEY = "ccc_mym_submit_overrides_v1";
  const LOCAL_ASOF_OVERRIDE_KEY = "ccc_asof_override_v1";

  function loadLocalOverrides() {
    try {
      const raw = localStorage.getItem(LOCAL_OVERRIDE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveLocalOverrides(overrides) {
    try {
      localStorage.setItem(LOCAL_OVERRIDE_KEY, JSON.stringify(overrides || {}));
    } catch (e) {}
  }

  function fmtForDatetimeLocal(d) {
    if (!d || isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${da}T${h}:${mi}`;
  }

  function loadAsOfOverrideState() {
    try {
      const raw = localStorage.getItem(LOCAL_ASOF_OVERRIDE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      const asOfDate = obj.asOfDate ? new Date(obj.asOfDate) : null;
      if (asOfDate && isNaN(asOfDate.getTime())) return null;
      return {
        asOfDate,
        active: !!obj.active,
      };
    } catch (e) {
      return null;
    }
  }

  function saveAsOfOverrideState(asOfDate, active) {
    try {
      localStorage.setItem(
        LOCAL_ASOF_OVERRIDE_KEY,
        JSON.stringify({
          asOfDate: asOfDate && !isNaN(asOfDate.getTime()) ? asOfDate.toISOString() : "",
          active: !!active,
        })
      );
    } catch (e) {}
  }

  function clearAsOfOverrideState() {
    try {
      localStorage.removeItem(LOCAL_ASOF_OVERRIDE_KEY);
    } catch (e) {}
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
    if (Array.isArray(raw)) return { eligibility: raw, usage: [], submissions: [], meta: {} };

    const all = raw.View_MYM_All || raw.view_mym_all || raw.mym_all || null;
    if (Array.isArray(all)) {
      return {
        eligibility: all,
        usage: raw.View_MYM_Usage || raw.usage || [],
        submissions: raw.submissions || raw.View_MYM_Submissions || [],
        meta: raw.meta || {},
      };
    }

    return {
      eligibility: raw.eligibility || raw.View_MYM_Eligibility || [],
      usage: raw.usage || raw.View_MYM_Usage || [],
      submissions: raw.submissions || raw.View_MYM_Submissions || [],
      meta: raw.meta || {},
    };
  }

  function normalizeSubmissions(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== "object") return [];
    if (Array.isArray(raw.submissions)) return raw.submissions;
    if (Array.isArray(raw.rows)) return raw.rows;
    return [];
  }

  function normalizeSubmissionRow(r) {
    return {
      submission_id: safeStr(r.submission_id || r.id),
      league_id: safeStr(r.league_id || r.L || r.leagueId),
      season: safeStr(r.season || r.year),
      franchise_id: pad4(r.franchise_id || r.franchiseId),
      franchise_name: safeStr(r.franchise_name || r.franchiseName),
      player_id: safeStr(r.player_id || r.playerId || r.id),
      player_name: safeStr(r.player_name || r.playerName),
      position: safeStr(r.position || r.pos || r.positional_grouping),
      salary: safeInt(r.salary),
      contract_year: safeInt(r.contract_year || r.contractYear),
      contract_status: safeStr(r.contract_status || r.contractStatus),
      contract_info: safeStr(r.contract_info || r.contractInfo),
      submitted_at_utc: safeStr(r.submitted_at_utc || r.submitted_at || r.submittedAt),
      commish_override_flag: safeInt(
        r.commish_override_flag || r.commish_override || r.override_flag
      )
        ? 1
        : 0,
      override_as_of_date: safeStr(
        r.override_as_of_date || r.override_as_of || r.overrideAsOf
      ),
      source: safeStr(r.source),
      inferred: safeInt(r.inferred) ? 1 : 0,
    };
  }

  function submissionNaturalKey(r) {
    return [
      safeStr(r.season || ""),
      safeStr(r.player_id || ""),
      safeStr(r.contract_year || ""),
      safeStr(r.contract_info || ""),
      safeStr(r.contract_status || ""),
    ].join("|");
  }

  function buildSubmittedRows(eligibilityRows, loggedRows, meta) {
    const out = [];
    const keySet = new Set();

    (loggedRows || []).forEach((raw) => {
      const r = normalizeSubmissionRow(raw);
      const key = submissionNaturalKey(r);
      keySet.add(key);
      out.push(r);
    });

    const inferredTs = safeStr(meta && meta.generated_at);
    (eligibilityRows || []).forEach((row) => {
      if (!hasSubmittedMYM(row)) return;
      const inferred = normalizeSubmissionRow({
        season: row.season,
        player_id: row.player_id,
        player_name: row.player_name,
        position: row.positional_grouping || row.position,
        franchise_id: row.franchise_id,
        franchise_name: row.franchise_name,
        salary: row.salary,
        contract_year: row.contract_year,
        contract_status: row.contract_status,
        contract_info: row.contract_info,
        submitted_at_utc: inferredTs,
        source: "derived-from-dashboard",
        inferred: 1,
      });
      const key = submissionNaturalKey(inferred);
      if (keySet.has(key)) return;
      keySet.add(key);
      out.push(inferred);
    });

    out.sort((a, b) => {
      const ad = parseDate(a.submitted_at_utc);
      const bd = parseDate(b.submitted_at_utc);
      const at = ad ? ad.getTime() : 0;
      const bt = bd ? bd.getTime() : 0;
      if (at !== bt) return bt - at;
      return safeStr(a.player_name).localeCompare(safeStr(b.player_name));
    });

    return out;
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

  function parseLeagueAdminFromData(data) {
    const league = data && (data.league || data);
    const frBlock =
      (league && league.franchises) ||
      (league && league.league && league.league.franchises) ||
      null;
    const frArr = (frBlock && (frBlock.franchise || frBlock)) || [];
    const franchises = Array.isArray(frArr) ? frArr : [frArr].filter(Boolean);
    const emailCount = franchises.reduce((acc, f) => {
      const hasEmail = !!(f && (f.email || (f.owner && f.owner.email)));
      return acc + (hasEmail ? 1 : 0);
    }, 0);

    return {
      ok: true,
      isAdmin: emailCount > 1,
      reason: emailCount > 1
        ? "Private owner data visible (commish)"
        : "No private owner data visible (owner mode)",
      emailCount,
    };
  }

  async function getAdminFlagFromBrowser(leagueId, year) {
    const L = safeStr(leagueId || getLeagueId() || DEFAULT_LEAGUE_ID);
    const YEAR = safeStr(year || getYear() || DEFAULT_YEAR);
    const candidates = [];

    if (window && window.location && window.location.origin) {
      candidates.push(
        `${window.location.origin}/${encodeURIComponent(
          YEAR
        )}/export?TYPE=league&L=${encodeURIComponent(L)}&JSON=1&_=${Date.now()}`
      );
    }
    candidates.push(
      `https://api.myfantasyleague.com/${encodeURIComponent(
        YEAR
      )}/export?TYPE=league&L=${encodeURIComponent(L)}&JSON=1&_=${Date.now()}`
    );

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) continue;
        const data = await res.json();
        const parsed = parseLeagueAdminFromData(data);
        return {
          ...parsed,
          L,
          YEAR,
          source: "browser",
        };
      } catch (e) {
        // Try next endpoint.
      }
    }

    return {
      ok: false,
      isAdmin: false,
      reason: "Could not verify commish mode from current login",
      emailCount: 0,
      L,
      YEAR,
      source: "browser",
    };
  }

  // ======================================================
  // 6) ELIGIBILITY OVERRIDE
  // ======================================================
  function hasSubmittedMYM(row) {
    const status = safeStr(row.contract_status).toLowerCase();
    return status.includes("mym");
  }

  function computeEligible(row, asOfDate) {
    if (hasSubmittedMYM(row)) return 0;

    const acqType = safeStr(row.mym_acq_type || "").toUpperCase();
    if (acqType === "ROOKIE_DRAFT") return 0;

    const deadline = parseDate(row.mym_deadline);
    if (!deadline || !asOfDate) return 0;

    return asOfDate.getTime() <= deadline.getTime() ? 1 : 0;
  }

  function rookieLike(raw) {
    const s = safeStr(raw).toLowerCase();
    return s === "r" || s.startsWith("r-") || s.includes("rookie");
  }

  function canRestructureRow(row) {
    const years = safeInt(row.contract_year);
    if (years <= 1 || years > 3) return false;
    if (safeInt(row.salary) <= 1000) return false;
    if (rookieLike(row.contract_status)) return false;
    return true;
  }

  function extractExtSuffix(contractInfo) {
    const s = safeStr(contractInfo);
    if (!s) return "";
    const m = s.match(/(?:^|\|)\s*(Ext:.*)$/i);
    return m ? safeStr(m[1]) : "";
  }

  function splitContractInfoBaseAndExt(contractInfo) {
    const s = safeStr(contractInfo);
    if (!s) return { base: "", ext: "" };
    const m = s.match(/^(.*?)(?:\|\s*)?(Ext:.*)$/i);
    if (!m) return { base: s, ext: "" };
    return { base: safeStr(m[1]).replace(/\|\s*$/, ""), ext: safeStr(m[2]) };
  }

  function parseMoneyToken(raw) {
    const s = safeStr(raw).replace(/,/g, "").trim();
    if (!s) return 0;
    const m = s.match(/^([0-9]+(?:\.[0-9]+)?)(K)?$/i);
    if (!m) return safeInt(s);
    const num = parseFloat(m[1]);
    if (isNaN(num)) return 0;
    return m[2] ? Math.round(num * 1000) : Math.round(num);
  }

  function roundToK(value) {
    const n = safeInt(value);
    if (n <= 0) return 0;
    return Math.ceil(n / 1000) * 1000;
  }

  function parseContractAmounts(contractInfo, years, fallbackSalary) {
    const base = splitContractInfoBaseAndExt(contractInfo).base;
    const tcvMatch = base.match(/TCV\s+([0-9]+(?:\.[0-9]+)?K?)/i);
    const y1Match = base.match(/Y1-([0-9]+(?:\.[0-9]+)?K?)/i);
    const y2Match = base.match(/Y2-([0-9]+(?:\.[0-9]+)?K?)/i);
    const y3Match = base.match(/Y3-([0-9]+(?:\.[0-9]+)?K?)/i);

    const fallback = Math.max(1000, roundToK(fallbackSalary));
    const y1Parsed = roundToK(parseMoneyToken(y1Match ? y1Match[1] : ""));
    const y2Parsed = roundToK(parseMoneyToken(y2Match ? y2Match[1] : ""));
    const y3Parsed = roundToK(parseMoneyToken(y3Match ? y3Match[1] : ""));
    const tcvParsed = roundToK(parseMoneyToken(tcvMatch ? tcvMatch[1] : ""));

    const y1 = y1Parsed || fallback;
    const y2 = years === 3 ? y2Parsed || fallback : y2Parsed;
    const y3 = years === 3 ? y3Parsed || fallback : 0;
    const tcvFromYears = y1 + (years === 3 ? y2 + y3 : y2 || fallback);
    const tcv = Math.max(years * 1000, tcvParsed || tcvFromYears);

    return { tcv, y1, y2, y3 };
  }

  function isStep1000(v) {
    const n = safeInt(v);
    return n > 0 && n % 1000 === 0;
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
      case "submitted":
        return (parseDate(r.submitted_at_utc) || new Date("1900-01-01")).getTime();
      case "player":
        return safeStr(r.player_name).toLowerCase();
      case "team":
        return safeStr(r.franchise_name).toLowerCase();
      case "pos":
        return safeStr(r.positional_grouping || r.position).toLowerCase();
      case "salary":
        return safeInt(r.salary);
      case "contractYear":
        return safeInt(r.contract_year);
      case "status":
        return safeStr(r.contract_status).toLowerCase();
      case "contractInfo":
        return safeStr(r.contract_info).toLowerCase();
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

  function clampInt(v, min, max) {
    const n = safeInt(v);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function updateTabPage(tabMode, page) {
    state.pageByTab[tabMode] = Math.max(1, safeInt(page) || 1);
  }

  function resetAllTablePages() {
    state.pageByTab.eligible = 1;
    state.pageByTab.submitted = 1;
  }

  function formatSubmittedValue(v) {
    const d = parseDate(v);
    if (!d) return { date: "N/A", time: "" };
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return { date: `${y}-${m}-${day}`, time: `${hh}:${mm}` };
  }

  function renderTable(rows, tabMode) {
    if (!rows.length) {
      return `<div class="ccc-tableWrap" style="padding:12px;">No rows.</div>`;
    }

    const isEligibleTab = tabMode === "eligible";
    const isSubmittedTab = tabMode === "submitted";
    const isRestructureMode = state.activeModule === "restructure";
    const showOverrideCols = !!state.commishMode;
    const pageSize = clampInt(state.pageSize || 50, 10, 500);
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pageRaw = state.pageByTab[tabMode] || 1;
    const pageNow = clampInt(pageRaw, 1, totalPages);
    if (pageNow !== pageRaw) updateTabPage(tabMode, pageNow);
    const start = (pageNow - 1) * pageSize;
    const pageRows = rows.slice(start, start + pageSize);
    const startLabel = totalRows ? start + 1 : 0;
    const endLabel = totalRows ? Math.min(start + pageSize, totalRows) : 0;

    const sortTh = (key, label, minWidthStyle, extraClass) => {
      const isSorted = sortState.tab === tabMode && sortState.key === key;
      const widthAttr = minWidthStyle ? ` style="${minWidthStyle}"` : "";
      const className = ["is-sortable", isSorted ? "is-sorted" : "", extraClass || ""]
        .join(" ")
        .trim();
      const ariaSort = isSorted ? (sortState.dir === "asc" ? "ascending" : "descending") : "none";
      return `<th data-sort="${key}" aria-sort="${ariaSort}" class="${className}"${widthAttr}>${label} <span class="sort">${sortIcon(
        tabMode,
        key
      )}</span></th>`;
    };

    const pager = `
      <div class="ccc-tableMeta">
        <div class="ccc-tableMetaInfo">Showing ${startLabel}-${endLabel} of ${totalRows}</div>
        <div class="ccc-tableMetaActions">
          <button type="button" class="ccc-pageBtn" data-page-tab="${tabMode}" data-page-action="prev" ${
      pageNow <= 1 ? "disabled" : ""
    }>Prev</button>
          <span class="ccc-pageLabel">Page ${pageNow} / ${totalPages}</span>
          <button type="button" class="ccc-pageBtn" data-page-tab="${tabMode}" data-page-action="next" ${
      pageNow >= totalPages ? "disabled" : ""
    }>Next</button>
        </div>
      </div>
    `;

    const head = `
      ${pager}
      <div class="ccc-tableWrap ccc-density-${htmlEsc(state.tableDensity || "regular")}" data-table="${tabMode}">
        <table class="ccc-table">
          <thead>
            <tr>
              ${
                isSubmittedTab
                  ? `
                ${sortTh("submitted", "Submitted", "min-width:130px;")}
                ${sortTh("team", "Team")}
                ${sortTh("player", "Player")}
                ${sortTh("pos", "Pos")}
                ${sortTh("salary", "Salary", "", "is-num")}
                ${sortTh("contractYear", "Years Remaining", "min-width:145px;", "is-num")}
                ${sortTh("status", "Status")}
                ${showOverrideCols ? `<th>Commish Override</th><th>Override As-Of</th>` : ``}
                <th style="min-width:260px;">Contract Info</th>
              `
                  : `
                ${isEligibleTab ? `<th style="min-width:140px;">Actions</th>` : ``}
                ${sortTh("player", "Player")}
                ${sortTh("pos", "Pos")}
                ${sortTh("salary", "Salary", "", "is-num")}
                ${
                  isRestructureMode
                    ? `
                ${sortTh("contractYear", "Years Remaining", "min-width:145px;", "is-num")}
                ${sortTh("status", "Status")}
                ${sortTh("contractInfo", "Contract Info", "min-width:260px;")}
                `
                    : `
                ${sortTh("acquired", "Acquired")}
                ${sortTh("deadline", "Deadline")}
                ${isEligibleTab ? `` : `<th style="min-width:320px;">Explanation</th>`}
                `
                }
              `
              }
            </tr>
          </thead>
          <tbody>
    `;

    if (isSubmittedTab) {
      const bodySubmitted = pageRows
        .map((r) => {
          const submittedFmt = formatSubmittedValue(r.submitted_at_utc);
          const submitted = `${htmlEsc(submittedFmt.date)}${
            submittedFmt.time ? `<div class="cell-sub">${htmlEsc(submittedFmt.time)}</div>` : ""
          }`;
          const team = htmlEsc(r.franchise_name || r.franchise_id || "");
          const player = htmlEsc(r.player_name || r.player_id);
          const posDisp = htmlEsc(r.position || "");
          const salary = safeInt(r.salary).toLocaleString();
          const cl = safeInt(r.contract_year) || "";
          const status = htmlEsc(r.contract_status || "");
          const override = safeInt(r.commish_override_flag) ? "Yes" : "No";
          const overrideAsOf = htmlEsc(r.override_as_of_date || "—");
          const info = htmlEsc(r.contract_info || "");
          const inferredTag = safeInt(r.inferred)
            ? `<span class="pill" style="margin-left:6px;">Inferred</span>`
            : "";
          return `
        <tr class="pos-${htmlEsc(posKeyFromRow(r))}">
          <td>${submitted}${inferredTag}</td>
          <td>${team}</td>
          <td class="playerCell">${player}</td>
          <td class="muted">${posDisp}</td>
          <td class="cell-num">${salary}</td>
          <td class="cell-num">${cl}</td>
          <td>${status}</td>
          ${showOverrideCols ? `<td>${override}</td><td class="muted">${overrideAsOf}</td>` : ``}
          <td class="explain">${info}</td>
        </tr>
      `;
        })
        .join("");

      return head + bodySubmitted + `</tbody></table></div>${pager}`;
    }

    const body = pageRows
      .map((r) => {
        const player = htmlEsc(r.player_name);
        const posDisp = htmlEsc(r.positional_grouping || r.position);
        const posKey = htmlEsc(posKeyFromRow(r));
        const salaryNum = safeInt(r.salary);
        const salary = salaryNum.toLocaleString();
        const acqType = safeStr(r.mym_acq_type);
        const contractYear = safeInt(r.contract_year) || "";
        const contractStatus = htmlEsc(r.contract_status || "");
        const contractInfo = htmlEsc(r.contract_info || "");

        const acquired = htmlEsc(fmtYMD(r.acquired_date));
        const deadline = htmlEsc(fmtYMD(r.mym_deadline));
        const expl = htmlEsc(r.rule_explanation || "");
        const extSuffix = extractExtSuffix(r.contract_info);

        const actions = isEligibleTab
          ? `
          <button
            type="button"
            class="ccc-btn ccc-btn-offer"
            ${isRestructureMode ? `data-restructure="1"` : `data-offer="1"`}
            data-player-id="${htmlEsc(r.player_id)}"
            data-player-name="${htmlEsc(r.player_name)}"
            data-pos="${htmlEsc(r.positional_grouping || r.position || "")}"
            data-salary="${salaryNum}"
            data-contract-year="${contractYear}"
            data-contract-status="${contractStatus}"
            data-contract-info="${contractInfo}"
            data-ext-suffix="${htmlEsc(extSuffix)}"
            data-franchise-id="${htmlEsc(pad4(r.franchise_id))}"
            data-franchise-name="${htmlEsc(r.franchise_name || "")}"
            data-acq-type="${htmlEsc(acqType)}"
            data-deadline="${htmlEsc(fmtYMD(r.mym_deadline))}"
          >${isRestructureMode ? "Restructure" : "Offer Contract"}</button>
        `
          : ``;

        return `
        <tr class="pos-${posKey}">
          ${isEligibleTab ? `<td>${actions}</td>` : ``}
          <td class="playerCell">${player}</td>
          <td class="muted">${posDisp}</td>
          <td class="cell-num">${salary}</td>
          ${
            isRestructureMode
              ? `
          <td class="cell-num">${contractYear}</td>
          <td>${contractStatus}</td>
          <td class="explain">${contractInfo}</td>
          `
              : `
          <td class="muted">${acquired}</td>
          <td class="muted">${deadline}</td>
          ${isEligibleTab ? `` : `<td class="explain">${expl}</td>`}
          `
          }
        </tr>
      `;
      })
      .join("");

    return head + body + `</tbody></table></div>${pager}`;
  }

  function renderSummary(teamName, rowsAll, rowsElig, used, remaining, asOfDate, showAsOfPill) {
    const isRestructureMode = state.activeModule === "restructure";

    const soonest = isRestructureMode
      ? null
      : rowsElig
          .map((r) => ({ r, d: parseDate(r.mym_deadline) }))
          .filter((x) => x.d)
          .sort((a, b) => a.d - b.d)[0];

    const seasonWindow = getRestructureSeasonWindow(state.selectedSeason);
    const soonestTxt = isRestructureMode
      ? seasonWindow
        ? seasonWindow.endYmd
        : "N/A"
      : soonest
      ? fmtYMD(soonest.r.mym_deadline)
      : "N/A";
    const asOfTxt = asOfDate ? fmtLocalYMDHM(asOfDate) : "";
    const snapshotLabel = isRestructureMode ? "Restructure Snapshot" : "MYM Snapshot";
    const usedLabel = isRestructureMode ? "Restructures Used" : "MYM Used";
    const remainingLabel = isRestructureMode ? "Restructures Remaining" : "MYM Remaining";
    const capHint = isRestructureMode ? "cap: 3 per offseason" : "cap: 5 per season";
    const soonestHint = isRestructureMode ? "offseason window closes" : "earliest eligible deadline";
    const deadlineLabel = isRestructureMode ? "Window Ends" : "Soonest Deadline";

    return `
      <div class="ccc-summaryTop">
        <div class="ccc-summaryTitle">${htmlEsc(teamName)} ${snapshotLabel}</div>
        <div class="muted" style="font-size:12px;">
          ${showAsOfPill ? `<span class="pill">As-Of: ${htmlEsc(asOfTxt)}</span>` : ``}
        </div>
      </div>

      <div class="ccc-kpis">
        <div class="kpi">
          <div class="label">Eligible Now</div>
          <div class="value">${rowsElig.length}</div>
          <div class="hint">out of ${rowsAll.length} players</div>
        </div>

        <div class="kpi">
          <div class="label">${deadlineLabel}</div>
          <div class="value">${htmlEsc(soonestTxt)}</div>
          <div class="hint">${soonestHint}</div>
        </div>

        <div class="kpi">
          <div class="label">${usedLabel}</div>
          <div class="value">${used}</div>
          <div class="hint">successful submissions</div>
        </div>

        <div class="kpi">
          <div class="label">${remainingLabel}</div>
          <div class="value">${remaining}</div>
          <div class="hint">${capHint}</div>
        </div>
      </div>
    `;
  }

  function buildTeamPositionBreakdown(eligibleRows, submittedRows) {
    const posOrder = ["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB"];
    const map = new Map();
    const upsert = (team, pos) => {
      const t = safeStr(team || "Unknown Team");
      const p = pos || "NA";
      const key = `${t}||${p}`;
      if (!map.has(key)) {
        map.set(key, {
          team: t,
          pos: p,
          eligible_count: 0,
          eligible_salary: 0,
          submitted_count: 0,
          submitted_salary: 0,
        });
      }
      return map.get(key);
    };

    (eligibleRows || []).forEach((r) => {
      const row = upsert(r.franchise_name || r.franchise_id, posKeyFromRow(r));
      row.eligible_count += 1;
      row.eligible_salary += safeInt(r.salary);
    });
    (submittedRows || []).forEach((r) => {
      const row = upsert(r.franchise_name || r.franchise_id, posKeyFromRow(r));
      row.submitted_count += 1;
      row.submitted_salary += safeInt(r.salary);
    });

    const out = Array.from(map.values());
    out.sort((a, b) => {
      const teamCmp = safeStr(a.team).localeCompare(safeStr(b.team));
      if (teamCmp !== 0) return teamCmp;
      const ia = posOrder.indexOf(a.pos);
      const ib = posOrder.indexOf(b.pos);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        if (ia !== ib) return ia - ib;
      }
      const ta = a.eligible_count + a.submitted_count;
      const tb = b.eligible_count + b.submitted_count;
      if (ta !== tb) return tb - ta;
      return a.pos.localeCompare(b.pos);
    });
    return out;
  }

  function renderSummaryPage(eligibleRows, submittedRows, teamName, positionLabel) {
    const eligibleCount = eligibleRows.length;
    const submittedCount = submittedRows.length;
    const eligibleSalary = eligibleRows.reduce((acc, r) => acc + safeInt(r.salary), 0);
    const submittedSalary = submittedRows.reduce((acc, r) => acc + safeInt(r.salary), 0);
    const rows = buildTeamPositionBreakdown(eligibleRows, submittedRows);
    const scopeTxt = positionLabel && positionLabel !== "__ALL_POS__" ? ` | Position: ${positionLabel}` : "";

    const top = `
      <div class="ccc-summaryTitle" style="margin:0 0 10px 2px;">${htmlEsc(teamName)} Summary${htmlEsc(
      scopeTxt
    )}</div>
      <div class="ccc-miniGrid">
        <div class="ccc-miniKpi"><div class="label">Eligible Players</div><div class="value">${eligibleCount}</div></div>
        <div class="ccc-miniKpi"><div class="label">Eligible Salary</div><div class="value">${eligibleSalary.toLocaleString()}</div></div>
        <div class="ccc-miniKpi"><div class="label">Submitted Players</div><div class="value">${submittedCount}</div></div>
        <div class="ccc-miniKpi"><div class="label">Submitted Salary</div><div class="value">${submittedSalary.toLocaleString()}</div></div>
      </div>
    `;

    if (!rows.length) {
      return `<div class="ccc-summaryPage">${top}<div class="ccc-tableWrap" style="padding:12px;">No summary rows.</div></div>`;
    }

    const body = rows
      .map(
        (r) => `
      <tr class="pos-${htmlEsc(r.pos)}">
        <td>${htmlEsc(r.team)}</td>
        <td>${htmlEsc(r.pos)}</td>
        <td>${safeInt(r.eligible_count)}</td>
        <td>${safeInt(r.eligible_salary).toLocaleString()}</td>
        <td>${safeInt(r.submitted_count)}</td>
        <td>${safeInt(r.submitted_salary).toLocaleString()}</td>
      </tr>`
      )
      .join("");

    return `
      <div class="ccc-summaryPage">
        ${top}
        <div class="ccc-tableWrap">
          <table class="ccc-table">
            <thead>
              <tr>
                <th>Team</th>
                <th>Position</th>
                <th>Eligible</th>
                <th>Eligible Salary</th>
                <th>Submitted</th>
                <th>Submitted Salary</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ======================================================
  // 8) STATE + TEAM LIST
  // ======================================================
  const state = {
    payload: { eligibility: [], usage: [], submissions: [], meta: {} },
    restructureSubmissions: [],
    isAdmin: false,
    canCommishMode: false,
    commishMode: false,
    adminReason: "",
    activeModule: "mym",
    selectedSeason: "",
    selectedTeam: "",
    selectedPosition: "__ALL_POS__",
    showAllTeams: false,
    pageSize: 50,
    tableDensity: "regular",
    pageByTab: { eligible: 1, submitted: 1 },
    detectedFranchiseId: "",
    asOfDate: null,
    asOfOverrideActive: false,
    commishPlayerRows: [],
    commishSelectedPlayerId: "",
    commishFormDirty: false,
    search: "",
    activeTab: "eligible",
    localOverrides: loadLocalOverrides(),
  };

  function normalizeSeasonValue(v) {
    const s = safeStr(v);
    const m = s.match(/\d{4}/);
    return m ? m[0] : s;
  }

  function buildSeasonList(eligibilityRows, submissionRows, restructureRows) {
    const set = new Set();
    (eligibilityRows || []).forEach((r) => {
      const s = normalizeSeasonValue(r.season);
      if (s) set.add(s);
    });
    (submissionRows || []).forEach((r) => {
      const s = normalizeSeasonValue(r.season);
      if (s) set.add(s);
    });
    (restructureRows || []).forEach((r) => {
      const s = normalizeSeasonValue(r.season);
      if (s) set.add(s);
    });
    return Array.from(set).sort((a, b) => safeInt(b) - safeInt(a));
  }

  function populateSeasonSelect(seasons, selectedSeason) {
    const sel = $("#seasonSelect");
    if (!sel) return;
    sel.innerHTML = "";
    const list = (seasons && seasons.length ? seasons : [selectedSeason || DEFAULT_YEAR]).filter(Boolean);
    list.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      opt.selected = s === selectedSeason;
      sel.appendChild(opt);
    });
  }

  function buildTeamList(rows, submittedRows, ownerFranchiseId) {
    const map = new Map();
    (rows || []).forEach((r) => {
      const id = pad4(r.franchise_id);
      const nm = safeStr(r.franchise_name);
      if (id && !map.has(id)) map.set(id, nm || id);
    });
    (submittedRows || []).forEach((r) => {
      const id = pad4(r.franchise_id);
      const nm = safeStr(r.franchise_name);
      if (id && !map.has(id)) map.set(id, nm || id);
    });

    const list = Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const ownerId = pad4(ownerFranchiseId);
    if (!ownerId) return list;

    const idx = list.findIndex((x) => x.id === ownerId);
    if (idx <= 0) return list;
    const owner = list[idx];
    const rest = list.slice(0, idx).concat(list.slice(idx + 1));
    return [owner, ...rest];
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

  function buildPositionList(eligibilityRows, submissionRows) {
    const set = new Set();
    (eligibilityRows || []).forEach((r) => {
      const p = posKeyFromRow(r);
      if (p) set.add(p);
    });
    (submissionRows || []).forEach((r) => {
      const p = posKeyFromRow(r);
      if (p) set.add(p);
    });

    const preferredOrder = ["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB"];
    const arr = Array.from(set);
    arr.sort((a, b) => {
      const ia = preferredOrder.indexOf(a);
      const ib = preferredOrder.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      return a.localeCompare(b);
    });
    return arr;
  }

  function populatePositionSelect(positions, selected) {
    const sel = $("#positionSelect");
    if (!sel) return;
    sel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "__ALL_POS__";
    allOpt.textContent = "All Positions";
    allOpt.selected = selected === "__ALL_POS__";
    sel.appendChild(allOpt);

    (positions || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      opt.selected = selected === p;
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

  function parseYMDDate(ymd) {
    const s = safeStr(ymd);
    if (!s) return null;
    const d = new Date(`${s}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }

  function getMymSeasonWindow(season) {
    const s = normalizeSeasonValue(season);
    if (!s) return null;
    const evt = MYM_EVENTS_BY_SEASON[s] || {};
    const deadlineYmd = safeStr(evt.contract_deadline) || `${s}-09-01`;
    const start = parseYMDDate(deadlineYmd);
    // League year rolls on March 1, so keep the current season active through end of February.
    const endExclusive = parseYMDDate(`${safeInt(s) + 1}-03-01`);
    if (!start || !endExclusive) return null;
    return { season: s, start, endExclusive, deadlineYmd };
  }

  function isMymActiveForSeason(season, nowDate) {
    const win = getMymSeasonWindow(season);
    if (!win) return false;
    const now = nowDate && !isNaN(nowDate.getTime()) ? nowDate : new Date();
    return now.getTime() >= win.start.getTime() && now.getTime() < win.endExclusive.getTime();
  }

  function getRestructureSeasonWindow(season) {
    const s = normalizeSeasonValue(season);
    if (!s) return null;
    const evt = MYM_EVENTS_BY_SEASON[s] || {};
    const start = parseYMDDate(`${s}-02-01`);
    const endYmd = safeStr(evt.contract_deadline) || `${s}-09-01`;
    const end = parseYMDDate(endYmd);
    if (!start || !end) return null;
    // Include contract deadline day.
    const dayAfterEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    return { season: s, start, endExclusive: dayAfterEnd, endYmd };
  }

  function isRestructureActiveForSeason(season, nowDate) {
    const win = getRestructureSeasonWindow(season);
    if (!win) return false;
    const now = nowDate && !isNaN(nowDate.getTime()) ? nowDate : new Date();
    return now.getTime() >= win.start.getTime() && now.getTime() < win.endExclusive.getTime();
  }

  function updateModuleStatusChips() {
    const season = normalizeSeasonValue(state.selectedSeason);
    const nowRef = new Date();
    const mymActive = isMymActiveForSeason(season, nowRef);
    const restructureActive = state.commishMode || isRestructureActiveForSeason(season, nowRef);
    const mymChip = $("#moduleMymChip");
    const restructureChip = $("#moduleRestructuresChip");

    if (mymChip) {
      mymChip.classList.toggle("disabled", !mymActive);
      mymChip.classList.toggle("primary", mymActive);
    }
    if (restructureChip) {
      restructureChip.classList.toggle("disabled", !restructureActive);
      restructureChip.classList.toggle("primary", restructureActive);
    }

    const setModuleState = (id, active) => {
      const el = $(id);
      if (!el) return;
      el.classList.toggle("disabled", !active);
      el.classList.toggle("primary", !!active);
    };

    // Placeholder scheduling statuses for upcoming modules.
    setModuleState("#moduleExtensionsChip", true);
    setModuleState("#moduleAuctionChip", restructureActive);
  }

  function renderEligibleAvailabilityNotice(season) {
    if (state.activeModule === "restructure") {
      if (state.commishMode) return "";
      if (isRestructureActiveForSeason(season, new Date())) return "";
      const win = getRestructureSeasonWindow(season);
      const endTxt = win ? win.endYmd : "contract deadline";
      return `<div class="ccc-eligWarn">Restructures Available Feb 1 Through ${htmlEsc(
        endTxt
      )}</div>`;
    }

    const s = normalizeSeasonValue(season);
    if (!s) return "";
    if (isMymActiveForSeason(s, new Date())) return "";
    const win = getMymSeasonWindow(s);
    const deadlineTxt = win ? win.deadlineYmd : "contract deadline";
    return `<div class="ccc-eligWarn">MYM Not Available Until After Contract Deadline Date (${htmlEsc(
      deadlineTxt
    )})</div>`;
  }

  function applyLocalOverrides(rows) {
    const overrides = state.localOverrides || {};
    rows.forEach((r) => {
      const ov = overrides[safeStr(r.player_id)];
      if (!ov) return;

      r.contract_status = safeStr(ov.contract_status || r.contract_status);
      if (safeInt(ov.contract_year) > 0) r.contract_year = safeInt(ov.contract_year);
      if (safeStr(ov.contract_info)) r.contract_info = safeStr(ov.contract_info);
      r.eligible_flag = 0;
      r.rule_explanation = "Not eligible. MYM contract already submitted.";
    });
  }

  function applyEffectiveEligibility(rows, asOfDate) {
    rows.forEach((r) => {
      r._eligibleEffective = safeInt(r.eligible_flag);
      if (hasSubmittedMYM(r)) r._eligibleEffective = 0;
      if (state.commishMode && asOfDate) {
        r._eligibleEffective = computeEligible(r, asOfDate);
      }
    });
  }

  function applyPostSubmitLocalUpdate(row, payload, out) {
    const pid = safeStr(row && row.player_id);
    if (!pid) return;

    const post = (out && out.postCheck) || {};
    const statusFinal = safeStr(post.contractStatus || payload.contract_status || "MYM");
    const yearFinal = safeInt(post.contractYear || payload.contract_year);
    const infoFinal = safeStr(post.contractInfo || payload.contract_info || "");

    let usageAdjusted = false;
    state.payload.eligibility.forEach((r) => {
      if (safeStr(r.player_id) !== pid) return;

      if (!r._mymJustSubmitted) {
        r._mymJustSubmitted = 1;
      }

      r.contract_status = statusFinal;
      if (yearFinal > 0) r.contract_year = yearFinal;
      if (infoFinal) r.contract_info = infoFinal;
      r.eligible_flag = 0;
      r.rule_explanation = "Not eligible. MYM contract already submitted.";

      if (!usageAdjusted) {
        const fid = pad4(r.franchise_id);
        const usageRow = state.payload.usage.find((u) => pad4(u.franchise_id) === fid);
        if (usageRow) {
          usageRow.mym_used = safeInt(usageRow.mym_used) + 1;
          usageRow.mym_remaining = Math.max(0, safeInt(usageRow.mym_remaining) - 1);
        }
        usageAdjusted = true;
      }
    });

    state.localOverrides[pid] = {
      contract_status: statusFinal,
      contract_year: yearFinal,
      contract_info: infoFinal,
      at: Date.now(),
    };
    saveLocalOverrides(state.localOverrides);

    const existingSubs = Array.isArray(state.payload.submissions)
      ? state.payload.submissions
      : [];
    const localSubmission = normalizeSubmissionRow({
      submission_id: `${safeStr(row.player_id)}-${Date.now()}`,
      league_id: payload.L || payload.leagueId || "",
      season: payload.YEAR || payload.year || row.season || "",
      franchise_id: row.franchise_id,
      franchise_name: row.franchise_name,
      player_id: row.player_id,
      player_name: row.player_name,
      position: row.positional_grouping || row.position,
      salary: payload.salary || row.salary,
      contract_year: yearFinal || payload.contract_year,
      contract_status: statusFinal,
      contract_info: infoFinal,
      submitted_at_utc: payload.submitted_at_utc || new Date().toISOString(),
      commish_override_flag: safeInt(payload.commish_override_flag) ? 1 : 0,
      override_as_of_date: safeStr(payload.override_as_of_date || ""),
      source: "local-submit",
    });
    state.payload.submissions = [localSubmission, ...existingSubs];
  }

  function applyPostRestructureLocalUpdate(row, payload, out) {
    const pid = safeStr(row && row.player_id);
    if (!pid) return;

    const post = (out && out.postCheck) || {};
    const salaryFinal = safeInt(post.salary || payload.salary || row.salary);
    const statusFinal = safeStr(post.contractStatus || payload.contract_status || row.contract_status);
    const yearFinal = safeInt(post.contractYear || payload.contract_year || row.contract_year);
    const infoFinal = safeStr(post.contractInfo || payload.contract_info || row.contract_info);

    state.payload.eligibility.forEach((r) => {
      if (safeStr(r.player_id) !== pid) return;
      r.salary = salaryFinal;
      if (yearFinal > 0) r.contract_year = yearFinal;
      if (statusFinal) r.contract_status = statusFinal;
      if (infoFinal) r.contract_info = infoFinal;
    });

    const existing = Array.isArray(state.restructureSubmissions)
      ? state.restructureSubmissions
      : [];
    const localSubmission = normalizeSubmissionRow({
      submission_id: `rs-${safeStr(row.player_id)}-${Date.now()}`,
      league_id: payload.L || payload.leagueId || "",
      season: payload.YEAR || payload.year || row.season || "",
      franchise_id: row.franchise_id,
      franchise_name: row.franchise_name,
      player_id: row.player_id,
      player_name: row.player_name,
      position: row.positional_grouping || row.position,
      salary: salaryFinal,
      contract_year: yearFinal,
      contract_status: statusFinal,
      contract_info: infoFinal,
      submitted_at_utc: payload.submitted_at_utc || new Date().toISOString(),
      commish_override_flag: safeInt(payload.commish_override_flag) ? 1 : 0,
      override_as_of_date: safeStr(payload.override_as_of_date || ""),
      source: "local-restructure-submit",
    });
    state.restructureSubmissions = [localSubmission, ...existing];
  }

  function computeSubmissionUsageByTeam(rows) {
    const map = new Map();
    (rows || []).forEach((r) => {
      const fid = pad4(r.franchise_id);
      if (!fid) return;
      map.set(fid, (map.get(fid) || 0) + 1);
    });
    return map;
  }

  function syncTabLabels() {
    const summaryTab = $(`.ccc-tab[data-tab="summary"]`);
    const eligibleTab = $(`.ccc-tab[data-tab="eligible"]`);
    const submittedTab = $(`.ccc-tab[data-tab="submitted"]`);
    if (summaryTab) summaryTab.textContent = "Summary";
    if (eligibleTab) eligibleTab.textContent = "Eligible";
    if (submittedTab) {
      submittedTab.textContent =
        state.activeModule === "restructure" ? "Restructure - Submitted" : "MYM - Submitted";
    }
  }

  function syncModuleChipSelection() {
    const mymChip = $("#moduleMymChip");
    const restructureChip = $("#moduleRestructuresChip");
    if (mymChip) mymChip.classList.toggle("is-selected", state.activeModule === "mym");
    if (restructureChip) {
      restructureChip.classList.toggle("is-selected", state.activeModule === "restructure");
    }
  }

  function buildCommishPlayerRows(seasonRows) {
    const out = (seasonRows || [])
      .filter((r) => safeInt(r.contract_year) > 0)
      .slice()
      .sort((a, b) => {
        const ta = safeStr(a.franchise_name || a.franchise_id).toLowerCase();
        const tb = safeStr(b.franchise_name || b.franchise_id).toLowerCase();
        if (ta !== tb) return ta.localeCompare(tb);
        return safeStr(a.player_name).toLowerCase().localeCompare(safeStr(b.player_name).toLowerCase());
      });
    return out;
  }

  function getCommishSelectedRow() {
    const pid = safeStr(state.commishSelectedPlayerId);
    return state.commishPlayerRows.find((r) => safeStr(r.player_id) === pid) || null;
  }

  function setCommishMessage(msg, isErr) {
    const el = $("#commishConsoleMsg");
    if (!el) return;
    if (!msg) {
      el.style.display = "none";
      el.textContent = "";
      el.classList.remove("ok");
      return;
    }
    el.style.display = "";
    el.textContent = msg;
    el.classList.toggle("ok", !isErr);
  }

  function loadCommishFormFromRow(row, force) {
    if (!row) return;
    if (state.commishFormDirty && !force) return;
    const salaryInput = $("#commishSalaryInput");
    const yearsInput = $("#commishYearsInput");
    const statusInput = $("#commishStatusInput");
    const infoInput = $("#commishInfoInput");
    if (salaryInput) salaryInput.value = String(safeInt(row.salary));
    if (yearsInput) yearsInput.value = String(Math.max(1, safeInt(row.contract_year)));
    if (statusInput) statusInput.value = safeStr(row.contract_status);
    if (infoInput) infoInput.value = safeStr(row.contract_info);
    state.commishFormDirty = false;
    setCommishMessage("", false);
  }

  function syncCommishConsole(seasonRows) {
    const consoleEl = $("#commishConsole");
    const playerSelect = $("#commishPlayerSelect");
    if (!consoleEl || !playerSelect) return;

    const isVisible = !!state.canCommishMode && !!state.commishMode;
    consoleEl.style.display = isVisible ? "" : "none";
    if (!isVisible) return;

    const rows = buildCommishPlayerRows(seasonRows);
    state.commishPlayerRows = rows;

    const currentPid = safeStr(state.commishSelectedPlayerId);
    let selectedPid = currentPid && rows.some((r) => safeStr(r.player_id) === currentPid)
      ? currentPid
      : rows[0]
      ? safeStr(rows[0].player_id)
      : "";
    state.commishSelectedPlayerId = selectedPid;

    playerSelect.innerHTML = "";
    rows.forEach((r) => {
      const opt = document.createElement("option");
      const team = safeStr(r.franchise_name || r.franchise_id);
      const pos = safeStr(r.positional_grouping || r.position || "");
      opt.value = safeStr(r.player_id);
      opt.textContent = `${team} | ${safeStr(r.player_name)} (${pos})`;
      opt.selected = opt.value === selectedPid;
      playerSelect.appendChild(opt);
    });
    playerSelect.disabled = rows.length === 0;

    const selectedRow = getCommishSelectedRow();
    if (selectedRow) {
      const forceLoad = safeStr(currentPid) !== safeStr(selectedPid);
      loadCommishFormFromRow(selectedRow, forceLoad);
    } else {
      loadCommishFormFromRow(
        {
          salary: 0,
          contract_year: 1,
          contract_status: "",
          contract_info: "",
        },
        true
      );
    }
  }

  async function submitCommishContractUpdate() {
    if (!state.canCommishMode || !state.commishMode) return;
    const row = getCommishSelectedRow();
    if (!row) {
      setCommishMessage("Select a player first.", true);
      return;
    }

    const salary = safeInt($("#commishSalaryInput") ? $("#commishSalaryInput").value : 0);
    const contractYear = safeInt($("#commishYearsInput") ? $("#commishYearsInput").value : 0);
    const contractStatus = safeStr($("#commishStatusInput") ? $("#commishStatusInput").value : "");
    const contractInfo = safeStr($("#commishInfoInput") ? $("#commishInfoInput").value : "");
    if (salary < 0 || contractYear <= 0 || !contractStatus || !contractInfo) {
      setCommishMessage("Fill salary, years remaining, contract status, and contract info.", true);
      return;
    }

    const L = getLeagueId() || DEFAULT_LEAGUE_ID;
    const YEAR = getYear() || DEFAULT_YEAR;
    const payload = {
      L: String(L),
      YEAR: String(YEAR),
      type: "MANUAL_CONTRACT_UPDATE",
      leagueId: String(L),
      year: String(YEAR),
      player_id: safeStr(row.player_id),
      player_name: safeStr(row.player_name),
      franchise_id: safeStr(row.franchise_id),
      franchise_name: safeStr(row.franchise_name),
      position: safeStr(row.positional_grouping || row.position),
      salary: salary,
      contract_year: contractYear,
      contract_status: contractStatus,
      contract_info: contractInfo,
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: state.asOfOverrideActive ? 1 : 0,
      override_as_of_date: state.asOfOverrideActive && state.asOfDate ? fmtLocalYMDHM(state.asOfDate) : "",
    };

    const btn = $("#commishApplyBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Applying...";
    }
    setCommishMessage("", false);

    try {
      const url =
        `${COMMISH_CONTRACT_UPDATE_URL}?L=${encodeURIComponent(L)}&YEAR=${encodeURIComponent(YEAR)}`;
      let res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const form = new URLSearchParams();
        Object.entries(payload).forEach(([k, v]) => form.set(k, String(v)));
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: form.toString(),
        });
      }

      const text = await res.text();
      let out = {};
      try {
        out = text ? JSON.parse(text) : {};
      } catch (_) {}

      if (!res.ok || out.ok !== true) {
        const msg =
          safeStr(out.reason) ||
          safeStr(out.error) ||
          safeStr(out.upstreamPreview).slice(0, 220) ||
          `Update failed (HTTP ${res.status})`;
        setCommishMessage(msg, true);
        return;
      }

      const post = (out && out.postCheck) || {};
      const salaryFinal = safeInt(post.salary || payload.salary);
      const yearFinal = safeInt(post.contractYear || payload.contract_year);
      const statusFinal = safeStr(post.contractStatus || payload.contract_status);
      const infoFinal = safeStr(post.contractInfo || payload.contract_info);

      state.payload.eligibility.forEach((r) => {
        if (safeStr(r.player_id) !== safeStr(row.player_id)) return;
        r.salary = salaryFinal;
        r.contract_year = yearFinal;
        r.contract_status = statusFinal;
        r.contract_info = infoFinal;
      });

      state.commishFormDirty = false;
      setCommishMessage(`Saved ${safeStr(row.player_name)} successfully.`, false);
      render();
    } catch (e) {
      setCommishMessage(safeStr(e && e.message ? e.message : e), true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Apply Manual Update";
      }
    }
  }

  function render() {
    const { eligibility, submissions, meta } = state.payload;

    const cccError = $("#cccError");
    const cccMeta = $("#cccMeta");
    const summary = $("#summary");
    const tabSummary = $("#tabSummary");
    const tabEligible = $("#tabEligible");
    const tabIneligible = $("#tabIneligible");
    const tabSubmitted = $("#tabSubmitted");

    if (cccError) cccError.textContent = "";

    const asOfDate =
      state.commishMode && state.asOfOverrideActive && state.asOfDate ? state.asOfDate : null;
    applyEffectiveEligibility(eligibility, asOfDate);

    const searchLower = safeStr(state.search).trim().toLowerCase();
    const season = normalizeSeasonValue(state.selectedSeason);
    const showAllTeams = !!state.showAllTeams;
    const selectedPosition = safeStr(state.selectedPosition || "__ALL_POS__");
    const selectedTeamId = pad4(state.selectedTeam);

    const seasonEligibility = eligibility.filter(
      (r) => !season || normalizeSeasonValue(r.season) === season
    );
    const seasonMymSubmissions = buildSubmittedRows(eligibility, submissions, meta).filter(
      (r) => !season || normalizeSeasonValue(r.season) === season
    );
    const seasonRestructureSubmissions = (state.restructureSubmissions || [])
      .map((r) => normalizeSubmissionRow(r))
      .filter((r) => !season || normalizeSeasonValue(r.season) === season);

    const teamFilteredEligibility = showAllTeams
      ? seasonEligibility
      : seasonEligibility.filter((r) => pad4(r.franchise_id) === selectedTeamId);

    const teamFilteredMymSubmissions = showAllTeams
      ? seasonMymSubmissions
      : seasonMymSubmissions.filter((r) => pad4(r.franchise_id) === selectedTeamId);
    const teamFilteredRestructureSubmissions = showAllTeams
      ? seasonRestructureSubmissions
      : seasonRestructureSubmissions.filter((r) => pad4(r.franchise_id) === selectedTeamId);

    const positionFilteredEligibility =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredEligibility
        : teamFilteredEligibility.filter((r) => posKeyFromRow(r) === selectedPosition);
    const positionFilteredMymSubmissions =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredMymSubmissions
        : teamFilteredMymSubmissions.filter((r) => posKeyFromRow(r) === selectedPosition);
    const positionFilteredRestructureSubmissions =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredRestructureSubmissions
        : teamFilteredRestructureSubmissions.filter((r) => posKeyFromRow(r) === selectedPosition);

    const scopedEligibility = searchLower
      ? positionFilteredEligibility.filter((r) =>
          safeStr(r.player_name).toLowerCase().includes(searchLower)
        )
      : positionFilteredEligibility.slice();
    const moduleSubmittedBase =
      state.activeModule === "restructure"
        ? positionFilteredRestructureSubmissions
        : positionFilteredMymSubmissions;

    const built = meta && meta.generated_at ? safeStr(meta.generated_at) : "";
    const minSeason = meta && meta.min_season ? safeStr(meta.min_season) : "";

    if (cccMeta) {
      cccMeta.textContent =
        `Season: ${season || "?"} | module: ${
          state.activeModule === "restructure" ? "Restructure" : "MYM"
        }` +
        (built ? ` | built: ${built}` : "") +
        (minSeason ? ` | min season: ${minSeason}` : "") +
        (state.commishMode && state.adminReason ? ` | ${state.adminReason}` : "");
    }

    const restructureActiveNow =
      state.commishMode || isRestructureActiveForSeason(season, new Date());
    const restructureUsageByTeam = computeSubmissionUsageByTeam(seasonRestructureSubmissions);
    const eligibleRowsRaw =
      state.activeModule === "restructure"
        ? scopedEligibility.filter((r) => {
            if (!canRestructureRow(r)) return false;
            if (!restructureActiveNow) return false;
            const fid = pad4(r.franchise_id);
            return (restructureUsageByTeam.get(fid) || 0) < RESTRUCTURE_CAP_PER_TEAM;
          })
        : scopedEligibility.filter((r) => safeInt(r._eligibleEffective) === 1);

    const eligibleRows = sortRows(
      eligibleRowsRaw,
      sortState.tab === "eligible"
        ? sortState.key
        : state.activeModule === "restructure"
        ? "salary"
        : "acquired",
      sortState.tab === "eligible" ? sortState.dir : "desc"
    );

    const submittedRowsRaw = searchLower
      ? moduleSubmittedBase.filter((r) => safeStr(r.player_name).toLowerCase().includes(searchLower))
      : moduleSubmittedBase.slice();

    const submittedRows = sortRows(
      submittedRowsRaw,
      sortState.tab === "submitted" ? sortState.key : "submitted",
      sortState.tab === "submitted" ? sortState.dir : "desc"
    );

    const teamNameSource =
      (positionFilteredEligibility[0] && positionFilteredEligibility[0].franchise_name) ||
      (moduleSubmittedBase[0] && moduleSubmittedBase[0].franchise_name) ||
      "";
    const teamName = showAllTeams ? "All Teams" : safeStr(teamNameSource || "Team");

    const usedCount = moduleSubmittedBase.length;
    const uniqueTeamsInSeason = new Set(
      seasonEligibility.map((r) => pad4(r.franchise_id)).filter(Boolean)
    ).size;
    const capPerTeam =
      state.activeModule === "restructure" ? RESTRUCTURE_CAP_PER_TEAM : SEASON_CAP_PER_TEAM;
    const capTotal = showAllTeams
      ? Math.max(0, uniqueTeamsInSeason * capPerTeam)
      : capPerTeam;
    const remainingCount = Math.max(0, capTotal - usedCount);

    syncTabLabels();
    syncModuleChipSelection();
    syncCommishConsole(seasonEligibility);
    if (summary) {
      summary.innerHTML = renderSummary(
        teamName,
        positionFilteredEligibility,
        eligibleRows,
        usedCount,
        remainingCount,
        asOfDate,
        !!asOfDate
      );
    }
    if (tabSummary) {
      tabSummary.innerHTML = renderSummaryPage(
        eligibleRows,
        submittedRowsRaw,
        teamName,
        selectedPosition
      );
    }
    if (tabEligible) {
      tabEligible.innerHTML = renderEligibleAvailabilityNotice(season) + renderTable(eligibleRows, "eligible");
    }
    if (tabIneligible) tabIneligible.innerHTML = "";
    if (tabSubmitted) tabSubmitted.innerHTML = renderTable(submittedRows, "submitted");
    updateModuleStatusChips();
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
      if (state.commishMode && state.asOfOverrideActive && state.asOfDate) {
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
  const playerStatus = safeStr(row.player_status || row.status).toLowerCase();
  const rookieFromStatus =
    playerStatus === "r" ||
    playerStatus.startsWith("r-") ||
    playerStatus.includes("rookie");
  const rookieFromAcqType = safeStr(row.mym_acq_type).toLowerCase().includes("rookie");
  const rookieFromNameTag = /\(R\)/i.test(safeStr(row.player_name));
  const isRookie = rookieFromStatus || rookieFromAcqType || rookieFromNameTag;

  // Keep payload keys aligned with the Worker/MFL contract expectations.
  const payload = {
    L: String(L),
    YEAR: String(YEAR),
    aav: safeInt(calc.aav),
    contract_info: String(calc.contractInfo),
    contract_status: isRookie ? "MYM - Rookie" : "MYM - Vet",
    contract_year: safeInt(years),
    guaranteed: safeInt(calc.gtd),
    leagueId: String(L),
    franchise_id: safeStr(row.franchise_id),
    franchise_name: safeStr(row.franchise_name),
    player_name: safeStr(row.player_name),
    player_status: safeStr(row.player_status || row.status),
    player_id: String(row.player_id),
    position: safeStr(row.positional_grouping || row.position),
    salary: safeInt(salary),
    submitted_at_utc: new Date().toISOString(),
    commish_override_flag: state.commishMode && state.asOfOverrideActive && state.asOfDate ? 1 : 0,
    override_as_of_date:
      state.commishMode && state.asOfOverrideActive && state.asOfDate
        ? fmtLocalYMDHM(state.asOfDate)
        : "",
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

    applyPostSubmitLocalUpdate(row, payload, out);
    closeMYMModal();
    render();
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

  const restructureModalState = {
    open: false,
    row: null,
    years: 2,
    extSuffix: "",
    calc: null,
  };

  function ensureRestructureModalExists() {
    const modal = $("#restructureModal");
    if (!modal) throw new Error("Missing #restructureModal in HTML.");
    return modal;
  }

  function calcRestructureOffer(years, tcvRaw, y1Raw, y2Raw, extSuffix) {
    const yearsInt = safeInt(years) >= 3 ? 3 : 2;
    const tcv = safeInt(tcvRaw);
    const y1 = safeInt(y1Raw);
    const y2Input = safeInt(y2Raw);
    const errors = [];

    const minTcv = yearsInt === 2 ? 2000 : 3000;
    if (tcv < minTcv || !isStep1000(tcv)) {
      errors.push(`TCV must be in 1,000 increments and at least ${minTcv.toLocaleString()}.`);
    }
    if (!isStep1000(y1)) {
      errors.push("Year 1 must be in 1,000 increments.");
    }
    const minY1 = Math.ceil((tcv * 0.2) / 1000) * 1000;
    if (y1 < minY1) {
      errors.push(`Year 1 must be at least 20% of TCV (${minY1.toLocaleString()}).`);
    }

    let y2 = 0;
    let y3 = 0;
    if (yearsInt === 2) {
      y2 = tcv - y1;
      if (!isStep1000(y2) || y2 < 1000) {
        errors.push("Year 2 must be at least 1,000 after applying Year 1.");
      }
    } else {
      y2 = y2Input;
      if (!isStep1000(y2) || y2 < 1000) {
        errors.push("Year 2 must be at least 1,000 and in 1,000 increments.");
      }
      y3 = tcv - y1 - y2;
      if (!isStep1000(y3) || y3 < 1000) {
        errors.push("Year 3 must be at least 1,000 after Year 1 + Year 2.");
      }
    }

    if (errors.length) {
      return { ok: false, error: errors[0], years: yearsInt, tcv, y1, y2, y3 };
    }

    const aav = Math.round(tcv / yearsInt);
    const gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - y1);
    const yearParts = [`Y1-${formatK(y1)}`, `Y2-${formatK(y2)}`];
    if (yearsInt === 3) yearParts.push(`Y3-${formatK(y3)}`);

    const parts = [
      `CL ${yearsInt}`,
      `TCV ${formatK(tcv)}`,
      `AAV ${formatK(aav)}`,
      yearParts.join(", "),
      `GTD: ${formatK(gtd)}`,
    ];
    if (safeStr(extSuffix)) parts.push(safeStr(extSuffix));

    return {
      ok: true,
      years: yearsInt,
      tcv,
      y1,
      y2,
      y3,
      aav,
      gtd,
      contractInfo: parts.join("| "),
    };
  }

  function renderRestructureModalSummary() {
    const row = restructureModalState.row;
    if (!row) return null;

    const tcvInput = $("#rsTcvInput");
    const y1Input = $("#rsYear1Input");
    const y2Input = $("#rsYear2Input");
    const y3Input = $("#rsYear3Input");
    const err = $("#rsModalErr");
    const submitBtn = $("#rsSubmitBtn");
    const years = restructureModalState.years;

    if (y2Input) y2Input.disabled = years === 2;

    const calc = calcRestructureOffer(
      years,
      tcvInput ? tcvInput.value : 0,
      y1Input ? y1Input.value : 0,
      y2Input ? y2Input.value : 0,
      restructureModalState.extSuffix
    );
    restructureModalState.calc = calc.ok ? calc : null;

    if (calc.ok) {
      if (y2Input && years === 2) y2Input.value = String(calc.y2);
      if (y3Input) y3Input.value = years === 3 ? String(calc.y3) : "";
      $("#rsYears").textContent = String(calc.years);
      $("#rsTCV").textContent = safeInt(calc.tcv).toLocaleString();
      $("#rsAAV").textContent = safeInt(calc.aav).toLocaleString();
      $("#rsGTD").textContent = safeInt(calc.gtd).toLocaleString();
      $("#rsContractInfo").textContent = calc.contractInfo;
      if (err) {
        err.style.display = "none";
        err.textContent = "";
      }
      if (submitBtn) submitBtn.disabled = false;
      return calc;
    }

    $("#rsYears").textContent = String(years);
    $("#rsTCV").textContent = "—";
    $("#rsAAV").textContent = "—";
    $("#rsGTD").textContent = "—";
    $("#rsContractInfo").textContent = "—";
    if (y3Input) y3Input.value = "";
    if (err) {
      err.style.display = "";
      err.textContent = calc.error || "Invalid restructure values.";
    }
    if (submitBtn) submitBtn.disabled = true;
    return null;
  }

  function openRestructureModal(row) {
    ensureRestructureModalExists();
    const years = safeInt(row.contract_year) >= 3 ? 3 : 2;
    const parsed = parseContractAmounts(row.contract_info, years, safeInt(row.salary) || 1000);
    const tcv = Math.max(years * 1000, parsed.tcv);
    const y1 = Math.max(1000, parsed.y1 || safeInt(row.salary) || 1000);
    const y2Default =
      years === 3
        ? Math.max(1000, parsed.y2 || safeInt(row.salary) || 1000)
        : Math.max(1000, parsed.y2 || tcv - y1);

    restructureModalState.open = true;
    restructureModalState.row = row;
    restructureModalState.years = years;
    restructureModalState.extSuffix = extractExtSuffix(row.contract_info);
    restructureModalState.calc = null;

    const title = $("#rsModalTitle");
    if (title) title.textContent = `Restructure Contract - ${safeStr(row.player_name)}`;
    const sub = $("#rsModalSub");
    if (sub) {
      sub.textContent =
        `Current CL: ${safeInt(row.contract_year)} | Current Salary: ${safeInt(row.salary).toLocaleString()} | Team: ${safeStr(
          row.franchise_name || row.franchise_id
        )}`;
    }
    const extBadge = $("#rsExtBadge");
    if (extBadge) {
      if (restructureModalState.extSuffix) {
        extBadge.style.display = "";
        extBadge.textContent = `Preserved: ${restructureModalState.extSuffix}`;
      } else {
        extBadge.style.display = "none";
        extBadge.textContent = "";
      }
    }

    $("#rsTcvInput").value = String(tcv);
    $("#rsYear1Input").value = String(y1);
    $("#rsYear2Input").value = String(y2Default);
    $("#rsYear3Input").value = "";

    renderRestructureModalSummary();

    const modal = $("#restructureModal");
    modal.classList.add("is-open");
    document.body.classList.add("ccc-modalOpen");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeRestructureModal() {
    const modal = $("#restructureModal");
    if (!modal) return;
    modal.classList.remove("is-open");
    document.body.classList.remove("ccc-modalOpen");
    modal.setAttribute("aria-hidden", "true");
    restructureModalState.open = false;
    restructureModalState.row = null;
    restructureModalState.calc = null;
  }

  async function submitRestructureContract() {
    const row = restructureModalState.row;
    const calc = renderRestructureModalSummary();
    if (!row || !calc) return;

    const season = normalizeSeasonValue(state.selectedSeason || getYear() || DEFAULT_YEAR);
    const fid = pad4(row.franchise_id);
    const usedCount = (state.restructureSubmissions || [])
      .map((r) => normalizeSubmissionRow(r))
      .filter(
        (r) => normalizeSeasonValue(r.season) === season && pad4(r.franchise_id) === fid
      ).length;
    if (usedCount >= RESTRUCTURE_CAP_PER_TEAM && !state.commishMode) {
      const capErr = $("#rsModalErr");
      if (capErr) {
        capErr.style.display = "";
        capErr.textContent = "Restructure cap reached (3 per offseason for this franchise).";
      }
      return;
    }

    const L = getLeagueId() || DEFAULT_LEAGUE_ID;
    const YEAR = getYear() || DEFAULT_YEAR;
    const btn = $("#rsSubmitBtn");
    const err = $("#rsModalErr");
    if (err) {
      err.style.display = "none";
      err.textContent = "";
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Submitting...";
    }

    const payload = {
      L: String(L),
      YEAR: String(YEAR),
      leagueId: String(L),
      year: String(YEAR),
      type: "RESTRUCTURE",
      player_id: safeStr(row.player_id),
      player_name: safeStr(row.player_name),
      franchise_id: safeStr(row.franchise_id),
      franchise_name: safeStr(row.franchise_name),
      position: safeStr(row.positional_grouping || row.position),
      salary: safeInt(calc.y1),
      contract_year: safeInt(calc.years),
      contract_status: safeStr(row.contract_status || "Veteran"),
      contract_info: safeStr(calc.contractInfo),
      tcv: safeInt(calc.tcv),
      aav: safeInt(calc.aav),
      guaranteed: safeInt(calc.gtd),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: state.commishMode && state.asOfOverrideActive && state.asOfDate ? 1 : 0,
      override_as_of_date:
        state.commishMode && state.asOfOverrideActive && state.asOfDate
          ? fmtLocalYMDHM(state.asOfDate)
          : "",
    };

    console.log("[Restructure submit payload]", payload);

    try {
      const url =
        `${OFFER_RESTRUCTURE_URL}?L=${encodeURIComponent(L)}&YEAR=${encodeURIComponent(YEAR)}`;
      let res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const form = new URLSearchParams();
        Object.entries(payload).forEach(([k, v]) => form.set(k, String(v)));
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: form.toString(),
        });
      }

      const text = await res.text();
      let out = {};
      try {
        out = text ? JSON.parse(text) : {};
      } catch (_) {}

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
        return;
      }

      if (out && out.preCheck) console.log("[Restructure preCheck]", out.preCheck);
      if (out && out.postCheck) console.log("[Restructure postCheck]", out.postCheck);
      if (out && out.submitDebug) console.log("[Restructure submitDebug]", out.submitDebug);

      applyPostRestructureLocalUpdate(row, payload, out);
      closeRestructureModal();
      render();
    } catch (e) {
      if (err) {
        err.style.display = "";
        err.textContent = e && e.message ? e.message : String(e);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Submit Restructure";
      }
    }
  }

  // ======================================================
  // 9) LOAD
  // ======================================================
  async function load() {
    try {
      must("#cccMeta");
      must("#tabSummary");
      must("#tabEligible");
      must("#tabSubmitted");
      must("#seasonSelect");
      must("#teamSelect");
      must("#positionSelect");
      must("#showAllTeamsChk");
      must("#pageSizeSelect");
      must("#densitySelect");
      must("#commishConsole");
      must("#commishPlayerSelect");
      must("#commishSalaryInput");
      must("#commishYearsInput");
      must("#commishStatusInput");
      must("#commishInfoInput");
      must("#commishReloadBtn");
      must("#commishApplyBtn");
      must("#commishConsoleMsg");
      must("#commishModeWrap");
      must("#commishModeChk");
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
      must("#restructureModal");
      must("#rsTcvInput");
      must("#rsYear1Input");
      must("#rsYear2Input");
      must("#rsSubmitBtn");

      $("#cccMeta").textContent = "Loading MYM data…";

      const bust = (MYM_JSON_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const subBust =
        (MYM_SUBMISSIONS_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const restructureBust =
        (RESTRUCTURE_SUBMISSIONS_URL.includes("?") ? "&" : "?") + "v=" + Date.now();

      const [res, subRes, restructureSubRes] = await Promise.all([
        fetch(MYM_JSON_URL + bust, { cache: "no-store" }),
        fetch(MYM_SUBMISSIONS_URL + subBust, { cache: "no-store" }).catch(() => null),
        fetch(RESTRUCTURE_SUBMISSIONS_URL + restructureBust, { cache: "no-store" }).catch(
          () => null
        ),
      ]);
      if (!res.ok) throw new Error("MYM JSON HTTP " + res.status);

      const raw = await res.json();
      state.payload = normalizePayload(raw);
      let subRows = [];
      if (subRes && subRes.ok) {
        try {
          const subRaw = await subRes.json();
          subRows = normalizeSubmissions(subRaw);
        } catch (e) {}
      }
      state.payload.submissions = subRows;
      let restructureRows = [];
      if (restructureSubRes && restructureSubRes.ok) {
        try {
          const restructureRaw = await restructureSubRes.json();
          restructureRows = normalizeSubmissions(restructureRaw);
        } catch (e) {}
      }
      state.restructureSubmissions = restructureRows;
      applyLocalOverrides(state.payload.eligibility);

      state.detectedFranchiseId = detectFranchiseId();

      const workerAdmin = await getAdminFlagFromWorker();
      const browserAdmin = await getAdminFlagFromBrowser(workerAdmin.L, workerAdmin.YEAR);
      const admin = browserAdmin.ok ? browserAdmin : workerAdmin;

      // Safety: only grant commish tools when current browser login proves commish access.
      state.isAdmin = !!(browserAdmin.ok && browserAdmin.isAdmin);
      state.canCommishMode = !!(browserAdmin.ok && browserAdmin.isAdmin);
      state.commishMode = state.canCommishMode ? true : false;
      state.adminReason = state.canCommishMode
        ? safeStr(admin.reason || "")
        : safeStr(browserAdmin.reason || "No private owner data visible (owner mode)");

      const commishWrap = $("#commishModeWrap");
      const commishChk = $("#commishModeChk");
      if (commishWrap) commishWrap.style.display = state.canCommishMode ? "flex" : "none";
      if (commishChk) commishChk.checked = !!state.commishMode;

      $("#adminBadge").style.display = state.commishMode ? "" : "none";
      $("#adminControls").style.display = state.commishMode ? "flex" : "none";

      if (state.canCommishMode) {
        const savedAsOf = loadAsOfOverrideState();
        if (savedAsOf && savedAsOf.asOfDate) {
          state.asOfDate = savedAsOf.asOfDate;
          state.asOfOverrideActive = !!savedAsOf.active;
        } else {
          const now = new Date();
          state.asOfDate = now;
          state.asOfOverrideActive = false;
        }
        $("#asOfInput").value = fmtForDatetimeLocal(state.asOfDate);
      } else {
        state.asOfDate = null;
        state.asOfOverrideActive = false;
        clearAsOfOverrideState();
        $("#asOfInput").value = "";
      }

      const seasons = buildSeasonList(
        state.payload.eligibility,
        state.payload.submissions,
        state.restructureSubmissions
      );
      const requestedSeason = normalizeSeasonValue(getYear() || DEFAULT_YEAR);
      const seasonSelected = seasons.includes(requestedSeason)
        ? requestedSeason
        : seasons[0] || requestedSeason;
      state.selectedSeason = seasonSelected;
      populateSeasonSelect(seasons, state.selectedSeason);

      const seasonRows = state.payload.eligibility.filter(
        (r) => normalizeSeasonValue(r.season) === state.selectedSeason
      );
      const seasonSubmissionRows = state.payload.submissions.filter(
        (r) => normalizeSeasonValue(r.season) === state.selectedSeason
      );
      const seasonRestructureRows = (state.restructureSubmissions || []).filter(
        (r) => normalizeSeasonValue(r.season) === state.selectedSeason
      );
      const mergedSubmissionRows = seasonSubmissionRows.concat(seasonRestructureRows);
      const teams = buildTeamList(seasonRows, mergedSubmissionRows, state.detectedFranchiseId);
      const detected = teams.some((t) => t.id === state.detectedFranchiseId)
        ? state.detectedFranchiseId
        : teams[0]
        ? teams[0].id
        : "";
      state.selectedTeam = detected;
      state.showAllTeams = !!state.canCommishMode;
      const showAllTeamsChk = $("#showAllTeamsChk");
      if (showAllTeamsChk) showAllTeamsChk.checked = !!state.showAllTeams;
      const teamSelect = $("#teamSelect");
      if (teamSelect) teamSelect.disabled = !!state.showAllTeams;

      populateTeamSelect(teams, state.selectedTeam);
      const positions = buildPositionList(seasonRows, mergedSubmissionRows);
      state.selectedPosition = "__ALL_POS__";
      populatePositionSelect(positions, state.selectedPosition);
      const positionSelect = $("#positionSelect");
      if (positionSelect) positionSelect.disabled = false;

      const pageSizeSelect = $("#pageSizeSelect");
      if (pageSizeSelect) {
        state.pageSize = clampInt(pageSizeSelect.value || state.pageSize, 10, 500);
        pageSizeSelect.value = String(state.pageSize);
      }
      const densitySelect = $("#densitySelect");
      if (densitySelect) {
        const densityVal = safeStr(densitySelect.value || "regular");
        state.tableDensity =
          densityVal === "compact" || densityVal === "relaxed" ? densityVal : "regular";
        densitySelect.value = state.tableDensity;
      }

      resetAllTablePages();
      setTab("eligible");

      // default sort per tab
      sortState.tab = "eligible";
      sortState.key = "acquired";
      sortState.dir = "desc";

      render();

      return {
        ok: true,
        built: safeStr((state.payload.meta && state.payload.meta.generated_at) || ""),
        count: Array.isArray(state.payload.eligibility) ? state.payload.eligibility.length : 0,
      };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const cccError = $("#cccError");
      const cccMeta = $("#cccMeta");
      if (cccMeta) cccMeta.textContent = "";
      if (cccError) cccError.textContent = "Could not load MYM dashboard: " + msg;
      console.error(e);
      return { ok: false, message: msg };
    }
  }

  async function handleRosterRefreshClick() {
    const btn = $("#refreshBtn");
    const beforeBuilt = safeStr((state.payload.meta && state.payload.meta.generated_at) || "");
    const label = btn ? btn.textContent : "Roster Refresh";

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Refreshing...";
    }

    try {
      const trigger = await triggerRosterRefreshFromGit();
      if (!trigger.ok) {
        alert(`Roster refresh failed.\n${trigger.message}`);
        return;
      }

      if (btn) btn.textContent = "Refreshing...";

      const waited = await waitForRosterBuildChange(beforeBuilt, 240000, 5000);
      if (!waited.ok || !waited.out || !waited.out.ok) {
        const msg = safeStr((waited && waited.message) || "Refresh queued but reload failed.");
        alert(`Roster refresh queued.\n${msg}`);
        return;
      }

      const afterBuilt = safeStr(waited.out.built || "");
      const count = safeInt(waited.out.count);
      const changed = waited.changed;

      if (changed) {
        alert(`Roster refresh complete.\nUpdated build: ${afterBuilt}\nPlayers loaded: ${count}`);
      } else {
        const builtTxt = afterBuilt ? `\nCurrent build: ${afterBuilt}` : "";
        alert(
          `Roster refresh was queued, but no new build was detected yet.\n` +
            `Please try again in about a minute.${builtTxt}`
        );
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  async function triggerRosterRefreshFromGit() {
    const L = getLeagueId() || DEFAULT_LEAGUE_ID;
    const YEAR = getYear() || DEFAULT_YEAR;
    const url =
      `${ROSTER_REFRESH_URL}?L=${encodeURIComponent(L)}&YEAR=${encodeURIComponent(YEAR)}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const text = await res.text();
      let out = {};
      try {
        out = text ? JSON.parse(text) : {};
      } catch (_) {}

      if (!res.ok || out.ok !== true || out.queued !== true) {
        const notQueuedHint =
          out && out.ok === true && out.queued !== true
            ? "Worker is not on the latest refresh endpoint. Deploy worker updates first."
            : "";
        const msg =
          safeStr(out.reason) ||
          notQueuedHint ||
          (text ? text.slice(0, 240) : "") ||
          `HTTP ${res.status}`;
        return { ok: false, message: msg };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: safeStr(e && e.message ? e.message : e) };
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForRosterBuildChange(beforeBuilt, timeoutMs, pollMs) {
    const started = Date.now();
    let lastOut = null;

    // Give GitHub Actions a moment to start before polling.
    await sleep(5000);

    while (Date.now() - started < timeoutMs) {
      const out = await load();
      if (out && out.ok) {
        lastOut = out;
        const afterBuilt = safeStr(out.built || "");
        const changed = beforeBuilt ? !!afterBuilt && afterBuilt !== beforeBuilt : !!afterBuilt;
        if (changed) return { ok: true, out, changed: true };
      }
      await sleep(pollMs);
    }

    return { ok: true, out: lastOut, changed: false };
  }

  // ======================================================
  // 10) TABS + EVENTS
  // ======================================================
  function setTab(tab) {
    state.activeTab = tab;

    const tabSummary = $("#tabSummary");
    const tabEligible = $("#tabEligible");
    const tabIneligible = $("#tabIneligible");
    const tabSubmitted = $("#tabSubmitted");

    if (tabSummary) tabSummary.style.display = tab === "summary" ? "" : "none";
    if (tabEligible) tabEligible.style.display = tab === "eligible" ? "" : "none";
    if (tabIneligible) tabIneligible.style.display = tab === "ineligible" ? "" : "none";
    if (tabSubmitted) tabSubmitted.style.display = tab === "submitted" ? "" : "none";

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
    const moduleMymChip = $("#moduleMymChip");
    if (moduleMymChip)
      moduleMymChip.addEventListener("click", () => {
        state.activeModule = "mym";
        sortState.tab = "eligible";
        sortState.key = "acquired";
        sortState.dir = "desc";
        resetAllTablePages();
        render();
      });

    const moduleRestructuresChip = $("#moduleRestructuresChip");
    if (moduleRestructuresChip)
      moduleRestructuresChip.addEventListener("click", () => {
        state.activeModule = "restructure";
        sortState.tab = "eligible";
        sortState.key = "salary";
        sortState.dir = "desc";
        resetAllTablePages();
        render();
      });

    // Tabs
    $$(".ccc-tab").forEach((btn) =>
      btn.addEventListener("click", () => {
        setTab(btn.dataset.tab);
        render();
      })
    );

    // Filters
    const seasonSelect = $("#seasonSelect");
    if (seasonSelect)
      seasonSelect.addEventListener("change", (e) => {
        state.selectedSeason = normalizeSeasonValue(e.target.value);
        resetAllTablePages();
        const seasonRows = state.payload.eligibility.filter(
          (r) => normalizeSeasonValue(r.season) === state.selectedSeason
        );
        const seasonSubmissionRows = (state.payload.submissions || []).filter(
          (r) => normalizeSeasonValue(r.season) === state.selectedSeason
        );
        const seasonRestructureRows = (state.restructureSubmissions || []).filter(
          (r) => normalizeSeasonValue(r.season) === state.selectedSeason
        );
        const mergedSubmissionRows = seasonSubmissionRows.concat(seasonRestructureRows);
        const teams = buildTeamList(
          seasonRows,
          mergedSubmissionRows,
          state.detectedFranchiseId
        );
        const stillValid = teams.some((t) => t.id === state.selectedTeam);
        if (!stillValid) state.selectedTeam = teams[0] ? teams[0].id : "";
        populateTeamSelect(teams, state.selectedTeam);
        const positions = buildPositionList(seasonRows, mergedSubmissionRows);
        if (state.selectedPosition !== "__ALL_POS__" && !positions.includes(state.selectedPosition)) {
          state.selectedPosition = "__ALL_POS__";
        }
        populatePositionSelect(positions, state.selectedPosition);
        render();
      });

    const showAllTeamsChk = $("#showAllTeamsChk");
    if (showAllTeamsChk)
      showAllTeamsChk.addEventListener("change", (e) => {
        state.showAllTeams = !!e.target.checked;
        resetAllTablePages();
        const sel = $("#teamSelect");
        if (sel) sel.disabled = state.showAllTeams;
        render();
      });

    const teamSelect = $("#teamSelect");
    if (teamSelect)
      teamSelect.addEventListener("change", (e) => {
        state.selectedTeam = e.target.value;
        state.showAllTeams = false;
        resetAllTablePages();
        const showAll = $("#showAllTeamsChk");
        if (showAll) showAll.checked = false;
        render();
      });

    const positionSelect = $("#positionSelect");
    if (positionSelect)
      positionSelect.addEventListener("change", (e) => {
        state.selectedPosition = safeStr(e.target.value || "__ALL_POS__");
        resetAllTablePages();
        render();
      });

    const commishPlayerSelect = $("#commishPlayerSelect");
    if (commishPlayerSelect)
      commishPlayerSelect.addEventListener("change", (e) => {
        state.commishSelectedPlayerId = safeStr(e.target.value || "");
        state.commishFormDirty = false;
        const row = getCommishSelectedRow();
        if (row) loadCommishFormFromRow(row, true);
      });

    ["#commishSalaryInput", "#commishYearsInput", "#commishStatusInput", "#commishInfoInput"].forEach(
      (sel) => {
        const el = $(sel);
        if (!el) return;
        el.addEventListener("input", () => {
          state.commishFormDirty = true;
          setCommishMessage("", false);
        });
      }
    );

    const commishReloadBtn = $("#commishReloadBtn");
    if (commishReloadBtn)
      commishReloadBtn.addEventListener("click", () => {
        const row = getCommishSelectedRow();
        if (row) loadCommishFormFromRow(row, true);
      });

    const commishApplyBtn = $("#commishApplyBtn");
    if (commishApplyBtn)
      commishApplyBtn.addEventListener("click", () => {
        submitCommishContractUpdate();
      });

    const commishModeChk = $("#commishModeChk");
    if (commishModeChk)
      commishModeChk.addEventListener("change", (e) => {
        if (!state.canCommishMode) return;
        state.commishMode = !!e.target.checked;
        const adminBadge = $("#adminBadge");
        const adminControls = $("#adminControls");
        if (adminBadge) adminBadge.style.display = state.commishMode ? "" : "none";
        if (adminControls) adminControls.style.display = state.commishMode ? "flex" : "none";
        render();
      });

    const searchBox = $("#searchBox");
    if (searchBox)
      searchBox.addEventListener("input", (e) => {
        state.search = e.target.value;
        resetAllTablePages();
        render();
      });

    const clearBtn = $("#clearBtn");
    if (clearBtn)
      clearBtn.addEventListener("click", () => {
        $("#searchBox").value = "";
        state.search = "";
        resetAllTablePages();
        render();
      });

    const pageSizeSelect = $("#pageSizeSelect");
    if (pageSizeSelect)
      pageSizeSelect.addEventListener("change", (e) => {
        state.pageSize = clampInt(e.target.value || state.pageSize, 10, 500);
        e.target.value = String(state.pageSize);
        resetAllTablePages();
        render();
      });

    const densitySelect = $("#densitySelect");
    if (densitySelect)
      densitySelect.addEventListener("change", (e) => {
        const density = safeStr(e.target.value || "regular");
        state.tableDensity =
          density === "compact" || density === "relaxed" ? density : "regular";
        e.target.value = state.tableDensity;
        render();
      });

    const refreshBtn = $("#refreshBtn");
    if (refreshBtn) {
      refreshBtn.textContent = "Roster Refresh";
      refreshBtn.addEventListener("click", () => handleRosterRefreshClick());
    }

    // Admin as-of
    const asOfInput = $("#asOfInput");
    if (asOfInput)
      asOfInput.addEventListener("change", () => {
        if (!state.canCommishMode || !state.commishMode) return;
        const v = asOfInput.value;
        const d = v ? new Date(v) : new Date();
        state.asOfDate = isNaN(d.getTime()) ? new Date() : d;
        state.asOfOverrideActive = true;
        saveAsOfOverrideState(state.asOfDate, state.asOfOverrideActive);
        render();
      });

    const asOfResetBtn = $("#asOfResetBtn");
    if (asOfResetBtn)
      asOfResetBtn.addEventListener("click", () => {
        if (!state.canCommishMode || !state.commishMode) return;
        const now = new Date();
        state.asOfDate = now;
        state.asOfOverrideActive = false;
        $("#asOfInput").value = fmtForDatetimeLocal(now);
        saveAsOfOverrideState(state.asOfDate, state.asOfOverrideActive);
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

    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target && e.target.closest ? e.target.closest(".ccc-pageBtn") : null;
        if (!btn) return;
        const tab = safeStr(btn.getAttribute("data-page-tab"));
        const action = safeStr(btn.getAttribute("data-page-action"));
        if (!tab || !action) return;
        if (action === "prev") {
          updateTabPage(tab, (state.pageByTab[tab] || 1) - 1);
        } else if (action === "next") {
          updateTabPage(tab, (state.pageByTab[tab] || 1) + 1);
        }
        render();
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

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-restructure='1']") : null;
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const row = {
          player_id: btn.getAttribute("data-player-id"),
          player_name: btn.getAttribute("data-player-name"),
          salary: safeInt(btn.getAttribute("data-salary")),
          contract_year: safeInt(btn.getAttribute("data-contract-year")),
          contract_status: safeStr(btn.getAttribute("data-contract-status")),
          contract_info: safeStr(btn.getAttribute("data-contract-info")),
          franchise_id: btn.getAttribute("data-franchise-id"),
          franchise_name: btn.getAttribute("data-franchise-name"),
          position: safeStr(btn.getAttribute("data-pos")),
        };

        openRestructureModal(row);
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

    const restructureModal = $("#restructureModal");
    if (restructureModal) {
      restructureModal.addEventListener("click", (e) => {
        const close = e.target && e.target.getAttribute && e.target.getAttribute("data-close");
        if (close === "1") closeRestructureModal();
      });
    }

    // Escape closes modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const modalElMym = $("#mymModal");
        const modalElRes = $("#restructureModal");
        if (modalElMym && modalElMym.classList.contains("is-open")) closeMYMModal();
        if (modalElRes && modalElRes.classList.contains("is-open")) closeRestructureModal();
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

    ["#rsTcvInput", "#rsYear1Input", "#rsYear2Input"].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener("input", () => renderRestructureModalSummary());
    });

    const rsSubmitBtn = $("#rsSubmitBtn");
    if (rsSubmitBtn) rsSubmitBtn.addEventListener("click", () => submitRestructureContract());
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
