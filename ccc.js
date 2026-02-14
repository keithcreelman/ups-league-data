(function () {
  "use strict";

  // ======================================================
  // 1) CONFIG
  // ======================================================
  const MYM_JSON_URL = "https://keithcreelman.github.io/ups-league-data/mym_dashboard.json";
  const MYM_SUBMISSIONS_URL = "https://keithcreelman.github.io/ups-league-data/mym_submissions.json";
  const RESTRUCTURE_SUBMISSIONS_URL =
    "https://keithcreelman.github.io/ups-league-data/restructure_submissions.json";
  const TAG_TRACKING_URL = "https://keithcreelman.github.io/ups-league-data/tag_tracking.json";
  const SEASON_CAP_PER_TEAM = 5;
  const RESTRUCTURE_CAP_PER_TEAM = 3;
  const MYM_EVENTS_BY_SEASON = {
    "2024": { contract_deadline: "2024-09-01", season_complete: "2024-12-30" },
    "2025": { contract_deadline: "2025-08-31", season_complete: "2025-12-29" },
    "2026": { contract_deadline: "2026-09-06", season_complete: "2026-12-29" },
  };
  const EXTENSION_RATES_BY_SEASON = {
    "2024": { QB: { 1: 10000, 2: 20000 }, RB: { 1: 10000, 2: 20000 }, WR: { 1: 10000, 2: 20000 }, TE: { 1: 10000, 2: 20000 }, DL: { 1: 3000, 2: 5000 }, LB: { 1: 3000, 2: 5000 }, DB: { 1: 3000, 2: 5000 }, PK: { 1: 3000, 2: 5000 }, P: { 1: 3000, 2: 5000 } },
    "2025": { QB: { 1: 10000, 2: 20000 }, RB: { 1: 10000, 2: 20000 }, WR: { 1: 10000, 2: 20000 }, TE: { 1: 10000, 2: 20000 }, DL: { 1: 3000, 2: 5000 }, LB: { 1: 3000, 2: 5000 }, DB: { 1: 3000, 2: 5000 }, PK: { 1: 3000, 2: 5000 }, P: { 1: 3000, 2: 5000 } },
  };
  const EXT_OWNER_BY_NICKNAME = {
    uw: "0001",
    lh: "0006",
    cbp: "0002",
    cleon: "0011",
    sex: "0007",
    gride: "0003",
    hammer: "0005",
    bb: "0010",
    ctown: "0009",
    chivalry: "0009",
    pg: "0004",
    creel: "0008",
    hawks: "0012",
    hood: "0099",
    mafia: "0099",
    blake: "0010",
  };
  const EXT_PRIMARY_NICK_BY_FRANCHISE = {
    "0001": "UW",
    "0006": "LH",
    "0002": "CBP",
    "0011": "Cleon",
    "0007": "Sex",
    "0003": "Gride",
    "0005": "Hammer",
    "0010": "BB",
    "0009": "C-Town",
    "0004": "PG",
    "0008": "Creel",
    "0012": "Hawks",
  };
  const MFL_API_BASE = "https://api.myfantasyleague.com";
  const TEAM_COLOR_OVERRIDES = {
    "0001": { h: 48, s: 88, l: 50 }, // L.A. Looks
    "0002": { h: 170, s: 82, l: 44 }, // CBP
    "0003": { h: 210, s: 90, l: 45 }, // Gride
    "0005": { h: 120, s: 80, l: 42 }, // HammerTime
    "0009": { h: 270, s: 82, l: 50 }, // C-Town Chivalry
    "0010": { h: 5, s: 90, l: 50 }, // Blake Bombers
    "0011": { h: 310, s: 80, l: 48 }, // Cleon Ca$h
    "0012": { h: 28, s: 92, l: 50 }, // Hawks
  };

  // Cloudflare Worker: { ok:true, isAdmin:true/false, reason:"...", emailCount:n }
  const ADMIN_WORKER_URL = "https://ups-league-data.keith-creelman.workers.dev/";

  // Fallbacks if page URL lacks ?L= or YEAR=
  const DEFAULT_LEAGUE_ID = "74598";
  const DEFAULT_YEAR = "2025";
  const COMMISH_FRANCHISE_ID = "0008";
  const FORCE_SEASON_ROLLOVER = true;

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

  function getEffectiveNow(season) {
    if (state && state.commishMode && state.asOfOverrideActive && state.asOfDate) {
      return new Date(state.asOfDate.getTime());
    }
    if (!FORCE_SEASON_ROLLOVER) return new Date();
    const seasonKey = normalizeSeasonValue(season || getYear() || DEFAULT_YEAR);
    const evt = MYM_EVENTS_BY_SEASON[seasonKey] || null;
    const seasonComplete = evt ? parseYMDDate(evt.season_complete) : null;
    const nowActual = new Date();
    if (!seasonComplete || nowActual.getTime() <= endOfDay(seasonComplete).getTime()) {
      return nowActual;
    }
    const seasonNum = safeInt(seasonKey);
    const year = seasonNum ? seasonNum + 1 : new Date().getFullYear();
    return new Date(year, 2, 1, 12, 0, 0);
  }

  function getAvailabilitySeason(baseSeason) {
    const override =
      state && state.commishMode ? safeStr(state.asOfSeasonOverride || "") : "";
    return override || safeStr(baseSeason);
  }

  function getBaseSeasonValue(baseSeason) {
    const override =
      state && state.commishMode ? safeStr(state.asOfSeasonOverride || "") : "";
    const season =
      override || safeStr(baseSeason || (state && state.selectedSeason) || DEFAULT_YEAR);
    return normalizeSeasonValue(season || DEFAULT_YEAR);
  }

  function getContractSeasonValue(baseSeason) {
    const override =
      state && state.commishMode ? safeStr(state.asOfSeasonOverride || "") : "";
    if (override) return normalizeSeasonValue(override);
    const base = normalizeSeasonValue(
      baseSeason || (state && state.selectedSeason) || DEFAULT_YEAR
    );
    const meta = state && state.tagTrackingMeta ? state.tagTrackingMeta : null;
    const metaSeason = safeInt(meta && meta.season);
    const trackSeason = safeInt(meta && meta.tracking_for_season);
    const baseInt = safeInt(base);
    if (metaSeason && trackSeason && baseInt && metaSeason === baseInt) {
      return String(trackSeason);
    }
    return base;
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

  function fmtYMDDate(d) {
    if (!d || isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function addDays(d, days) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + days);
    return out;
  }

  function endOfDay(d) {
    if (!d || isNaN(d.getTime())) return null;
    const out = new Date(d.getTime());
    out.setHours(23, 59, 59, 999);
    return out;
  }

  function getMemorialDay(year) {
    if (!year) return null;
    const d = new Date(year, 4, 31);
    const day = d.getDay();
    const offset = (day + 6) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }

  function getTagDeadlineInfo(season) {
    const s = safeInt(normalizeSeasonValue(season));
    if (!s) return null;
    const year = s + 1;
    const memorial = getMemorialDay(year);
    if (!memorial) return null;
    const rookieDraft = addDays(memorial, -1);
    const tagDeadline = addDays(memorial, -4);
    return { year, memorial, rookieDraft, tagDeadline };
  }

  function isTagDeadlinePassed(season) {
    const info = getTagDeadlineInfo(season);
    if (!info || !info.tagDeadline) return false;
    const end = new Date(info.tagDeadline.getTime());
    end.setHours(23, 59, 59, 999);
    return getEffectiveNow(season).getTime() > end.getTime();
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
  const LOCAL_TAG_SELECTIONS_KEY = "ccc_tag_selections_v1";
  const LOCAL_TAG_SUBMISSIONS_KEY = "ccc_tag_submissions_v1";
  const LOCAL_EXTENSION_SELECTIONS_KEY = "ccc_extension_selections_v1";
  const LOCAL_EXTENSION_SUBMISSIONS_KEY = "ccc_extension_submissions_v1";
  const LOCAL_PPG_SETTINGS_KEY = "ccc_ppg_settings_v1";
  const LOCAL_THEME_KEY = "ccc_theme_v1";
  const LOCAL_HIGHLIGHT_KEY = "ccc_row_highlight_v1";
  const LOCAL_DEFAULT_FILTERS_KEY = "ccc_default_filters_v1";
  const SESSION_DEV_NOTICE_KEY = "ccc_dev_notice_seen_v1";
  const LOCAL_ASOF_SEASON_KEY = "ccc_asof_season_v1";

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

  function loadTagSelections() {
    try {
      const raw = localStorage.getItem(LOCAL_TAG_SELECTIONS_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveTagSelections(selections) {
    try {
      localStorage.setItem(LOCAL_TAG_SELECTIONS_KEY, JSON.stringify(selections || {}));
    } catch (e) {}
  }

  function loadTagSubmissions() {
    try {
      const raw = localStorage.getItem(LOCAL_TAG_SUBMISSIONS_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveTagSubmissions(submissions) {
    try {
      localStorage.setItem(LOCAL_TAG_SUBMISSIONS_KEY, JSON.stringify(submissions || {}));
    } catch (e) {}
  }

  function loadExtensionSelections() {
    try {
      const raw = localStorage.getItem(LOCAL_EXTENSION_SELECTIONS_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveExtensionSelections(selections) {
    try {
      localStorage.setItem(LOCAL_EXTENSION_SELECTIONS_KEY, JSON.stringify(selections || {}));
    } catch (e) {}
  }

  function loadExtensionSubmissions() {
    try {
      const raw = localStorage.getItem(LOCAL_EXTENSION_SUBMISSIONS_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveExtensionSubmissions(submissions) {
    try {
      localStorage.setItem(LOCAL_EXTENSION_SUBMISSIONS_KEY, JSON.stringify(submissions || {}));
    } catch (e) {}
  }

  function loadPpgSettings() {
    try {
      const raw = localStorage.getItem(LOCAL_PPG_SETTINGS_KEY);
      if (!raw) return { minGames: 8, enabled: true };
      const obj = JSON.parse(raw);
      const minGames = clampInt(obj && obj.minGames ? obj.minGames : 8, 1, 18);
      const enabled = obj && obj.enabled !== undefined ? !!obj.enabled : true;
      return { minGames, enabled };
    } catch (e) {
      return { minGames: 8, enabled: true };
    }
  }

  function loadThemeSetting() {
    try {
      const raw = localStorage.getItem(LOCAL_THEME_KEY);
      const v = safeStr(raw).toLowerCase();
      if (v === "light" || v === "dark" || v === "auto") return v;
    } catch (_) {}
    return "auto";
  }

  function saveThemeSetting(theme) {
    try {
      localStorage.setItem(LOCAL_THEME_KEY, safeStr(theme || "auto"));
    } catch (_) {}
  }

  function applyThemeSetting(theme) {
    const t = safeStr(theme).toLowerCase() || "auto";
    const app = $("#cccApp");
    if (app) app.setAttribute("data-theme", t);
    const sel = $("#themeSelect");
    if (sel) sel.value = t;
    $$("[data-admin-theme]").forEach((el) => {
      if (el) el.value = t;
    });
  }

  function normalizeHighlightMode(mode) {
    const v = safeStr(mode).toLowerCase();
    return v === "team" ? "team" : "position";
  }

  function loadHighlightSettings() {
    try {
      const raw = localStorage.getItem(LOCAL_HIGHLIGHT_KEY);
      if (!raw) return { enabled: true, mode: "position", byModule: {} };
      const obj = JSON.parse(raw);
      const enabled = obj && obj.enabled !== undefined ? !!obj.enabled : true;
      const mode = normalizeHighlightMode(obj && obj.mode ? obj.mode : "position");
      const byModuleRaw = obj && typeof obj.byModule === "object" ? obj.byModule : {};
      const byModule = {};
      Object.keys(byModuleRaw || {}).forEach((key) => {
        const entry = byModuleRaw[key];
        if (!entry || typeof entry !== "object") return;
        byModule[key] = {
          enabled: entry.enabled !== undefined ? !!entry.enabled : enabled,
          mode: normalizeHighlightMode(entry.mode || mode),
        };
      });
      return { enabled, mode, byModule };
    } catch (e) {
      return { enabled: true, mode: "position", byModule: {} };
    }
  }

  function saveHighlightSettings(enabled, mode, byModule) {
    try {
      localStorage.setItem(
        LOCAL_HIGHLIGHT_KEY,
        JSON.stringify({
          enabled: !!enabled,
          mode: normalizeHighlightMode(mode || "position"),
          byModule: byModule || {},
        })
      );
    } catch (e) {}
  }

  function normalizeDefaultFilters(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const teamId = safeStr(obj.teamId || obj.team_id || "");
    const positionRaw = safeStr(obj.position || obj.pos || "__ALL_POS__");
    const position = positionRaw ? positionRaw : "__ALL_POS__";
    const rawSize = clampInt(obj.pageSize || obj.page_size || 50, 10, 500);
    const pageSize = [25, 50, 100].includes(rawSize) ? rawSize : 50;
    return { teamId, position, pageSize };
  }

  function loadDefaultFilters() {
    try {
      const raw = localStorage.getItem(LOCAL_DEFAULT_FILTERS_KEY);
      if (!raw) return { teamId: "", position: "__ALL_POS__", pageSize: 50 };
      const obj = JSON.parse(raw);
      return normalizeDefaultFilters(obj);
    } catch (e) {
      return { teamId: "", position: "__ALL_POS__", pageSize: 50 };
    }
  }

  function saveDefaultFilters(filters) {
    try {
      const data = normalizeDefaultFilters(filters || {});
      localStorage.setItem(LOCAL_DEFAULT_FILTERS_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function getHighlightSettingsForModule(moduleKey) {
    const key = safeStr(moduleKey || "").toLowerCase();
    const defEnabled =
      state && state.highlightDefault ? !!state.highlightDefault.enabled : true;
    const defMode = normalizeHighlightMode(
      state && state.highlightDefault ? state.highlightDefault.mode : "position"
    );
    if (!key || !state || !state.highlightByModule) {
      return { enabled: defEnabled, mode: defMode };
    }
    const entry = state.highlightByModule[key];
    if (!entry) return { enabled: defEnabled, mode: defMode };
    return {
      enabled: entry.enabled !== undefined ? !!entry.enabled : defEnabled,
      mode: normalizeHighlightMode(entry.mode || defMode),
    };
  }

  function rememberHighlightForModule(moduleKey) {
    const key = safeStr(moduleKey || "").toLowerCase();
    if (!key) return;
    if (!state.highlightByModule) state.highlightByModule = {};
    const entry = {
      enabled: !!state.rowHighlightEnabled,
      mode: normalizeHighlightMode(state.rowHighlightMode),
    };
    state.highlightByModule[key] = entry;
    state.highlightDefault = entry;
    saveHighlightSettings(state.highlightDefault.enabled, state.highlightDefault.mode, state.highlightByModule);
  }

  function setHighlightForModule(moduleKey) {
    const settings = getHighlightSettingsForModule(moduleKey);
    state.rowHighlightEnabled = settings.enabled;
    state.rowHighlightMode = settings.mode;
    applyHighlightSetting();
  }

  function applyHighlightSetting() {
    const app = $("#cccApp");
    const enabled = !!state.rowHighlightEnabled;
    const mode = normalizeHighlightMode(state.rowHighlightMode);
    const appliesToTagTracking = state.activeModule === "tag" && state.activeTab === "eligible";
    if (app) app.setAttribute("data-highlight", appliesToTagTracking && enabled ? mode : "none");
    const chk = $("#rowHighlightChk");
    if (chk) {
      chk.checked = enabled;
      chk.disabled = !appliesToTagTracking;
    }
    const sel = $("#rowHighlightModeSelect");
    if (sel) {
      sel.value = mode;
      sel.disabled = !appliesToTagTracking || !enabled;
    }
    const seg = $("#rowHighlightSeg");
    if (seg) {
      seg.querySelectorAll(".seg").forEach((btn) => {
        const isActive = btn.getAttribute("data-highlight") === mode;
        btn.classList.toggle("is-active", isActive);
        btn.disabled = !appliesToTagTracking || !enabled;
      });
    }
  }

  function loadAsOfSeasonOverride() {
    try {
      const raw = localStorage.getItem(LOCAL_ASOF_SEASON_KEY);
      const v = safeStr(raw);
      if (v && /\d{4}/.test(v)) return v;
    } catch (_) {}
    return "";
  }

  function saveAsOfSeasonOverride(value) {
    try {
      localStorage.setItem(LOCAL_ASOF_SEASON_KEY, safeStr(value || ""));
    } catch (_) {}
  }

  function savePpgSettings(settings) {
    try {
      localStorage.setItem(
        LOCAL_PPG_SETTINGS_KEY,
        JSON.stringify({
          minGames: clampInt(settings && settings.minGames ? settings.minGames : 8, 1, 18),
          enabled: settings && settings.enabled !== undefined ? !!settings.enabled : true,
        })
      );
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
    const readCookies = () => {
      const out = {};
      const raw = safeStr(document.cookie || "");
      if (!raw) return out;
      raw.split(";").forEach((part) => {
        const p = safeStr(part).trim();
        if (!p) return;
        const idx = p.indexOf("=");
        const key = idx >= 0 ? p.slice(0, idx).trim() : p;
        const val = idx >= 0 ? p.slice(idx + 1).trim() : "";
        if (!key) return;
        out[key] = val;
      });
      return out;
    };

    const readFromUrl = (urlText) => {
      if (!urlText) return "";
      const u = new URL(urlText, window.location.origin);
      const qs = u.searchParams;
      const cand =
        qs.get("FRANCHISE_ID") ||
        qs.get("FRANCHISEID") ||
        qs.get("franchise_id") ||
        qs.get("FRANCHISE") ||
        qs.get("F") ||
        qs.get("FR") ||
        "";
      const byQuery = pad4(cand);
      if (byQuery) return byQuery;

      const p = safeStr(u.pathname || "");
      const m = p.match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
      return m ? pad4(m[1]) : "";
    };

    try {
      const fromSelf = readFromUrl(window.location.href);
      if (fromSelf) return fromSelf;
      const fromReferrer = readFromUrl(document.referrer || "");
      if (fromReferrer) return fromReferrer;

      const cookies = readCookies();
      const leagueHint = safeStr(getLeagueId() || cookies.MFL_LAST_LEAGUE_ID || DEFAULT_LEAGUE_ID);
      const popups = Object.keys(cookies).map((k) => {
        const m = k.match(/^MFLPlayerPopup_(\d{4})_(\d+)_([0-9]{4})$/i);
        if (!m) return null;
        return {
          key: k,
          season: safeInt(m[1]),
          leagueId: safeStr(m[2]),
          franchiseId: pad4(m[3]),
        };
      }).filter(Boolean);
      const filtered = popups
        .filter((x) => x.franchiseId && x.franchiseId !== "0000")
        .filter((x) => !leagueHint || x.leagueId === leagueHint);
      if (filtered.length) {
        filtered.sort((a, b) => b.season - a.season || b.key.localeCompare(a.key));
        return filtered[0].franchiseId;
      }

      return "";
    } catch (e) {
      return "";
    }
  }

  function isAdminDebugEnabled() {
    try {
      const u = new URL(window.location.href);
      const v = safeStr(
        u.searchParams.get("DEBUG_ADMIN") || u.searchParams.get("DEBUG") || ""
      ).toLowerCase();
      return v === "1" || v === "true" || v === "yes" || v === "on";
    } catch (e) {
      return false;
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

  function normalizeTagRows(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(normalizeTagRow);
    if (raw && typeof raw === "object") {
      const rows = Array.isArray(raw.rows)
        ? raw.rows
        : Array.isArray(raw.tag_tracking)
        ? raw.tag_tracking
        : [];
      return rows.map(normalizeTagRow);
    }
    return [];
  }

  function normalizeTagRow(r) {
    return {
      league_id: safeStr(r.league_id || r.L || r.leagueId),
      season: normalizeSeasonValue(r.season || r.year),
      franchise_id: pad4(r.franchise_id || r.franchiseId),
      franchise_name: safeStr(r.franchise_name || r.franchiseName),
      player_id: safeStr(r.player_id || r.playerId || r.id),
      player_name: safeStr(r.player_name || r.playerName || r.name),
      position: safeStr(r.position),
      positional_grouping: safeStr(r.positional_grouping || r.pos_group || r.pos),
      salary: safeInt(r.salary),
      aav: safeInt(r.aav),
      contract_year: safeInt(r.contract_year),
      contract_status: safeStr(r.contract_status),
      contract_info: safeStr(r.contract_info),
      points_total: Number(r.points_total || 0),
      points_per_game: Number(r.points_per_game || r.ppg || 0),
      games_played: safeInt(r.games_played || r.games || 0),
      ppg_rank: safeInt(r.ppg_rank || r.ppgRank || 0),
      ppg_min_games: safeInt(r.ppg_min_games || r.ppgMinGames || 0),
      pos_rank: safeInt(r.pos_rank),
      tag_tier: safeInt(r.tag_tier),
      tag_rank_band: safeStr(r.tag_rank_band),
      tag_base_bid: safeInt(r.tag_base_bid),
      tag_bid: safeInt(r.tag_bid || r.tag_salary),
      tag_salary: safeInt(r.tag_salary),
      tag_bid_bump_applied: safeInt(r.tag_bid_bump_applied),
      prior_aav_week1: safeInt(r.prior_aav_week1),
      tag_side: safeStr(r.tag_side),
      tag_limit_per_side: safeInt(r.tag_limit_per_side || 1),
      is_tag_eligible: safeInt(r.is_tag_eligible || 0),
      eligibility_reason: safeStr(r.eligibility_reason),
      tag_formula: safeStr(r.tag_formula),
      tracking_context: safeStr(r.tracking_context || "in-season"),
      scoring_weeks_used: safeStr(r.scoring_weeks_used),
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
  function getBrowserMflUserId() {
    try {
      const c = safeStr(document.cookie || "");
      const m = c.match(/(?:^|;\s*)MFL_USER_ID=([^;]+)/i);
      return safeStr(m ? m[1] : "");
    } catch (e) {
      return "";
    }
  }

  async function getAdminFlagFromWorker() {
    let L = getLeagueId();
    let YEAR = getYear();

    if (!L) L = DEFAULT_LEAGUE_ID;
    if (!YEAR) YEAR = DEFAULT_YEAR;

    const params = [
      `L=${encodeURIComponent(L)}`,
      `YEAR=${encodeURIComponent(YEAR)}`,
      `_${Date.now()}`,
    ];
    const userCookie = getBrowserMflUserId();
    if (userCookie) params.push(`MFL_USER_ID=${encodeURIComponent(userCookie)}`);
    const apiKey = typeof window.apiKey === "string" ? safeStr(window.apiKey) : "";
    if (apiKey) params.push(`APIKEY=${encodeURIComponent(apiKey)}`);
    const url = `${ADMIN_WORKER_URL}?${params.join("&")}`;

    try {
      const res = await fetch(url, { cache: "no-store" });
      const j = await res.json();

      return {
        ok: !!j.ok,
        isAdmin: !!j.isAdmin,
        reason: safeStr(j.reason || ""),
        emailCount: safeInt(j.emailCount || 0),
        commishFranchiseId: pad4(j.commishFranchiseId || j.commish_franchise_id || ""),
        sessionKnown: !!j.sessionKnown,
        sessionMatch: !!j.sessionMatch,
        L,
        YEAR,
      };
    } catch (e) {
      return {
        ok: false,
        isAdmin: false,
        reason: `Worker check failed: ${e && e.message ? e.message : e}`,
        commishFranchiseId: "",
        sessionKnown: false,
        sessionMatch: false,
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
    const host = safeStr((window && window.location && window.location.hostname) || "").toLowerCase();
    const onMflHost = host.endsWith(".myfantasyleague.com") || host === "myfantasyleague.com";
    if (!onMflHost) {
      return {
        ok: false,
        isAdmin: false,
        reason: "Admin check requires MFL page session",
        emailCount: 0,
        L,
        YEAR,
        source: "browser",
      };
    }

    const url = `${window.location.origin}/${encodeURIComponent(
      YEAR
    )}/export?TYPE=league&L=${encodeURIComponent(L)}&JSON=1&_=${Date.now()}`;

    try {
      const res = await fetch(url, {
        cache: "no-store",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        const parsed = parseLeagueAdminFromData(data);
        return {
          ...parsed,
          L,
          YEAR,
          source: "browser",
        };
      }
    } catch (e) {}

    return {
      ok: false,
      isAdmin: false,
      reason: "Could not verify commish mode from current MFL session",
      emailCount: 0,
      L,
      YEAR,
      source: "browser",
    };
  }

  function parseMyFranchiseId(data) {
    const cand =
      (data &&
        (data?.franchise?.id ||
          data?.myfranchise?.id ||
          data?.myfranchise?.franchise?.id ||
          data?.franchise?.franchise_id ||
          data?.myfranchise?.franchise_id ||
          data?.franchise_id ||
          data?.franchiseId)) ||
      "";
    return pad4(cand);
  }

  async function resolveCurrentFranchiseId(leagueId, year, existingId) {
    const existing = pad4(existingId);
    if (existing) return existing;

    const L = safeStr(leagueId || getLeagueId() || DEFAULT_LEAGUE_ID);
    const YEAR = safeStr(year || getYear() || DEFAULT_YEAR);
    const candidates = [];

    if (window && window.location && window.location.origin) {
      candidates.push(
        `${window.location.origin}/${encodeURIComponent(
          YEAR
        )}/export?TYPE=myfranchise&L=${encodeURIComponent(L)}&JSON=1&_=${Date.now()}`
      );
    }
    if (typeof window.apiKey === "string" && window.apiKey.trim()) {
      candidates.push(
        `https://api.myfantasyleague.com/${encodeURIComponent(
          YEAR
        )}/export?TYPE=myfranchise&L=${encodeURIComponent(L)}&APIKEY=${encodeURIComponent(
          window.apiKey.trim()
        )}&JSON=1&_=${Date.now()}`
      );
    }

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) continue;
        const data = await res.json();
        const fid = parseMyFranchiseId(data);
        if (fid) return fid;
      } catch (e) {}
    }
    return "";
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
    const raw = safeStr(
      r.positional_grouping || r.position || r.pos || r.position_abbr || r.position_code
    )
      .toUpperCase()
      .trim();
    const p = raw.replace(/[^A-Z]/g, "");
    if (p === "K" || p === "PK") return "PK";
    if (p === "P" || p === "PN" || p === "PNTR") return "P";
    if (p === "DE" || p === "DT" || p === "DL") return "DL";
    if (p === "CB" || p === "S" || p === "DB" || p === "SAF") return "DB";
    if (["QB", "RB", "WR", "TE", "PK", "P", "DL", "LB", "DB"].includes(p)) return p;
    return p || "NA";
  }

  function safeClassToken(token) {
    return safeStr(token).replace(/[^a-zA-Z0-9_-]/g, "");
  }

  function buildRowClass(row, posOverride) {
    const posVal = safeClassToken(posOverride || posKeyFromRow(row) || row.pos || "");
    const fid = safeClassToken(pad4(row && row.franchise_id ? row.franchise_id : ""));
    const classes = [];
    if (posVal) classes.push(`pos-${posVal}`);
    if (fid) classes.push(`team-${fid}`);
    return classes.join(" ");
  }

  function canManageTagForFranchise(franchiseId) {
    if (state.commishMode) return true;
    const currentFid = pad4(state.detectedFranchiseId || state.selectedTeam || "");
    if (!currentFid) return false;
    return pad4(franchiseId) === currentFid;
  }

  function hashToHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) % 360;
    }
    return h;
  }

  function hslToRgb(h, s, l) {
    const sat = s / 100;
    const light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = light - c / 2;
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (h >= 0 && h < 60) {
      r1 = c;
      g1 = x;
    } else if (h < 120) {
      r1 = x;
      g1 = c;
    } else if (h < 180) {
      g1 = c;
      b1 = x;
    } else if (h < 240) {
      g1 = x;
      b1 = c;
    } else if (h < 300) {
      r1 = x;
      b1 = c;
    } else {
      r1 = c;
      b1 = x;
    }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
    };
  }

  function computeTeamHue(franchiseId, franchiseName) {
    const fid = safeStr(franchiseId);
    const name = safeStr(franchiseName);
    const n = safeInt(fid);
    if (n > 0) {
      const base = (n * 137.508) % 360;
      const tweak = name ? (hashToHue(name) % 20) - 10 : 0;
      return (base + tweak + 360) % 360;
    }
    return hashToHue(name || fid);
  }

  function getTeamRgb(franchiseId, franchiseName) {
    const fid = safeStr(franchiseId);
    const name = safeStr(franchiseName);
    if (!fid && !name) return null;
    const hue = computeTeamHue(fid, name);
    return hslToRgb(hue, 82, 50);
  }

  function buildTeamPalette() {
    const hues = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
    const lights = [44, 62];
    const sat = 85;
    const out = [];
    lights.forEach((l) => {
      hues.forEach((h) => {
        out.push({ h, s: sat, l });
      });
    });
    return out;
  }

  function colorDistance(a, b) {
    const diff = Math.abs(a.h - b.h);
    const hueDiff = Math.min(diff, 360 - diff) / 180;
    const lightDiff = Math.abs(a.l - b.l) / 100;
    const satDiff = Math.abs(a.s - b.s) / 100;
    return hueDiff * 0.75 + lightDiff * 0.2 + satDiff * 0.05;
  }

  function assignTeamColors(teams, usedColors) {
    const palette = buildTeamPalette();
    const assigned = Array.isArray(usedColors) ? usedColors.slice() : [];
    const map = {};
    const list = (teams || [])
      .map((t) => ({
        id: pad4(t.id || t.franchise_id),
        name: safeStr(t.name || t.franchise_name || ""),
      }))
      .filter((t) => t.id)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    list.forEach((team) => {
      let bestIdx = -1;
      let bestScore = -1;
      const seed = (hashToHue(team.id + team.name) % 360) / 360;
      palette.forEach((color, idx) => {
        let minDist = assigned.length
          ? Math.min(...assigned.map((c) => colorDistance(color, c)))
          : 1;
        const bias = (1 - Math.abs(color.h / 360 - seed)) * 0.01;
        const score = minDist + bias;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      });
      const chosen = bestIdx >= 0 ? palette.splice(bestIdx, 1)[0] : null;
      if (chosen) {
        const rgb = hslToRgb(chosen.h, chosen.s, chosen.l);
        map[team.id] = rgb;
        assigned.push(chosen);
      }
    });
    return map;
  }

  function buildTeamColorMap(eligibilityRows, submissionRows, tagRows) {
    const map = new Map();
    const add = (r) => {
      const id = pad4(r.franchise_id);
      if (!id) return;
      if (!map.has(id)) map.set(id, safeStr(r.franchise_name || ""));
    };
    (eligibilityRows || []).forEach(add);
    (submissionRows || []).forEach(add);
    (tagRows || []).forEach(add);
    const list = Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    const overrides = {};
    const used = [];
    list.forEach((t) => {
      const ov = TEAM_COLOR_OVERRIDES[pad4(t.id)];
      if (ov) {
        overrides[pad4(t.id)] = hslToRgb(ov.h, ov.s, ov.l);
        used.push({ h: ov.h, s: ov.s, l: ov.l });
      }
    });
    const remaining = list.filter((t) => !TEAM_COLOR_OVERRIDES[pad4(t.id)]);
    const assigned = assignTeamColors(remaining, used);
    return { ...assigned, ...overrides };
  }

  function buildTeamStyle(rowOrId, franchiseName) {
    let fid = "";
    let name = "";
    if (rowOrId && typeof rowOrId === "object") {
      fid = safeStr(rowOrId.franchise_id);
      name = safeStr(rowOrId.franchise_name);
    } else {
      fid = safeStr(rowOrId);
      name = safeStr(franchiseName);
    }
    const mapped = state && state.teamColorMap ? state.teamColorMap[pad4(fid)] : null;
    const rgb = mapped || getTeamRgb(fid, name);
    if (!rgb) return "";
    return `--team-rgb:${rgb.r},${rgb.g},${rgb.b};`;
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
      case "aav":
        return safeInt(r.aav);
      case "points":
        return Number(r.points_total || 0);
      case "ppg":
        return Number(r.points_per_game || 0);
      case "ppgRank": {
        const v = safeInt(r._ppg_rank || r.ppg_rank);
        return v > 0 ? v : 99999;
      }
      case "tagRank":
        return safeInt(r.pos_rank || 99999);
      case "tagTier":
        return safeInt(r.tag_tier || 99999);
      case "tagSalary":
        return safeInt(r.tag_salary);
      case "tagBid":
        return safeInt(r.tag_bid || r.tag_salary);
      case "priorAav":
        return safeInt(r.prior_aav_week1 || r.aav);
      case "tagFormula":
        return safeStr(r.tag_formula).toLowerCase();
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
      if (state.activeModule === "tag" && key === "player") {
        const nameA = safeStr(ra.player_name).toLowerCase();
        const nameB = safeStr(rb.player_name).toLowerCase();
        const nameCmp = compareVals(nameA, nameB, dir);
        if (nameCmp !== 0) return nameCmp;
        const bidA = safeInt(ra.tag_bid || ra.tag_salary || 0);
        const bidB = safeInt(rb.tag_bid || rb.tag_salary || 0);
        const bidCmp = compareVals(bidA, bidB, dir);
        if (bidCmp !== 0) return bidCmp;
      }
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
    if (state.activeModule === "tag") {
      return renderTagTable(rows, tabMode);
    }
    if (state.activeModule === "extensions") {
      if (tabMode === "submitted") return renderExtensionsSubmittedPage(state.selectedSeason);
      return renderExtensionsTable(rows, tabMode);
    }

    if (!rows.length) {
      return `<div class="ccc-tableWrap" style="padding:12px;">No rows.</div>`;
    }

    const isEligibleTab = tabMode === "eligible";
    const isSubmittedTab = tabMode === "submitted";
    const isRestructureMode = state.activeModule === "restructure";
    const showOverrideCols = !!state.commishMode;
    const baseSeason = state.calendarBaseSeason || getBaseSeasonValue(state.selectedSeason);
    const nowRef = state.calendarNow || getEffectiveNow(baseSeason);
    const mymActionsOpen =
      state.activeModule !== "mym"
        ? true
        : state.commishMode || isMymActiveForSeason(baseSeason, nowRef);
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
                ${showOverrideCols ? `<th>Admin Override</th><th>Override As-Of</th>` : ``}
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
          const posKey = posKeyFromRow(r);
          const rowClass = buildRowClass(r, posKey);
          const rowStyle = buildTeamStyle(r);
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
        <tr class="${rowClass}"${rowStyle ? ` style="${rowStyle}"` : ""}>
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
        const posKeyRaw = posKeyFromRow(r);
        const posKey = htmlEsc(posKeyRaw);
        const rowClass = buildRowClass(r, posKeyRaw);
        const rowStyle = buildTeamStyle(r);
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

        const actionDisabled = !isRestructureMode && !mymActionsOpen;
        const actionLabel = isRestructureMode
          ? "Restructure"
          : mymActionsOpen
          ? "Offer Contract"
          : "MYM Closed";
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
            ${actionDisabled ? "disabled" : ""}
            ${actionDisabled ? `title="MYM is not available right now"` : ""}
          >${actionLabel}</button>
        `
          : ``;

        return `
        <tr class="${rowClass}"${rowStyle ? ` style="${rowStyle}"` : ""}>
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

    const seasonWindow = getRestructureSeasonWindow(
      state.calendarBaseSeason || state.selectedSeason
    );
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
    const upsert = (teamId, teamName, pos) => {
      const id = pad4(teamId);
      const name = safeStr(teamName || teamId || "Unknown Team");
      const p = pos || "NA";
      const key = `${id || name}||${p}`;
      if (!map.has(key)) {
        map.set(key, {
          team: name,
          team_id: id,
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
      const row = upsert(r.franchise_id, r.franchise_name || r.franchise_id, posKeyFromRow(r));
      row.eligible_count += 1;
      row.eligible_salary += safeInt(r.salary);
    });
    (submittedRows || []).forEach((r) => {
      const row = upsert(r.franchise_id, r.franchise_name || r.franchise_id, posKeyFromRow(r));
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

    const groupMap = new Map();
    rows.forEach((r) => {
      const key = r.team_id || r.team;
      let group = groupMap.get(key);
      if (!group) {
        group = {
          team: r.team,
          team_id: r.team_id,
          rows: [],
          eligible_count: 0,
          eligible_salary: 0,
          submitted_count: 0,
          submitted_salary: 0,
        };
        groupMap.set(key, group);
      }
      group.rows.push(r);
      group.eligible_count += safeInt(r.eligible_count);
      group.eligible_salary += safeInt(r.eligible_salary);
      group.submitted_count += safeInt(r.submitted_count);
      group.submitted_salary += safeInt(r.submitted_salary);
    });

    const groups = Array.from(groupMap.values()).sort((a, b) =>
      safeStr(a.team).localeCompare(safeStr(b.team))
    );

    const body = groups
      .map((g) => {
        const rowStyle = buildTeamStyle(g.team_id, g.team);
        const detailRows = g.rows
          .map((r) => {
            const rowClass = buildRowClass({ franchise_id: g.team_id }, r.pos);
            const styleAttr = rowStyle ? ` style="${rowStyle}"` : "";
            return `
            <tr class="${rowClass}"${styleAttr}>
              <td>${htmlEsc(r.pos)}</td>
              <td>${safeInt(r.eligible_count)}</td>
              <td>${safeInt(r.eligible_salary).toLocaleString()}</td>
              <td>${safeInt(r.submitted_count)}</td>
              <td>${safeInt(r.submitted_salary).toLocaleString()}</td>
            </tr>`;
          })
          .join("");

        const summaryStyle = rowStyle ? ` style="${rowStyle}"` : "";
        return `
        <details class="ccc-summaryGroup">
          <summary>
            <div class="ccc-summaryRow"${summaryStyle}>
              <div class="ccc-summaryTeam">${htmlEsc(g.team)}</div>
              <div class="ccc-summaryStat"><span class="label">Eligible</span><span class="value">${safeInt(
          g.eligible_count
        )}</span></div>
              <div class="ccc-summaryStat"><span class="label">Eligible $</span><span class="value">${safeInt(
          g.eligible_salary
        ).toLocaleString()}</span></div>
              <div class="ccc-summaryStat"><span class="label">Submitted</span><span class="value">${safeInt(
          g.submitted_count
        )}</span></div>
              <div class="ccc-summaryStat"><span class="label">Submitted $</span><span class="value">${safeInt(
          g.submitted_salary
        ).toLocaleString()}</span></div>
            </div>
          </summary>
          <div class="ccc-tableWrap">
            <table class="ccc-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Eligible</th>
                  <th>Eligible Salary</th>
                  <th>Submitted</th>
                  <th>Submitted Salary</th>
                </tr>
              </thead>
              <tbody>${detailRows}</tbody>
            </table>
          </div>
        </details>
        `;
      })
      .join("");

    return `
      <div class="ccc-summaryPage">
        ${top}
        ${body}
      </div>
    `;
  }

  function buildRestructureSummaryByPos(eligibleRows, submittedRows) {
    const map = new Map();
    const upsert = (pos) => {
      const key = safeStr(pos || "NA");
      let rec = map.get(key);
      if (!rec) {
        rec = {
          pos: key,
          eligible: 0,
          eligible2: 0,
          eligible3: 0,
          eligibleSalary: 0,
          eligibleSalary2: 0,
          eligibleSalary3: 0,
          submitted: 0,
          submittedSalary: 0,
        };
        map.set(key, rec);
      }
      return rec;
    };

    (eligibleRows || []).forEach((r) => {
      const pos = posKeyFromRow(r);
      const rec = upsert(pos);
      const salary = safeInt(r.salary);
      const years = safeInt(r.contract_year);
      rec.eligible += 1;
      rec.eligibleSalary += salary;
      if (years === 2) {
        rec.eligible2 += 1;
        rec.eligibleSalary2 += salary;
      } else if (years === 3) {
        rec.eligible3 += 1;
        rec.eligibleSalary3 += salary;
      }
    });

    (submittedRows || []).forEach((r) => {
      const pos = posKeyFromRow(r);
      const rec = upsert(pos);
      rec.submitted += 1;
      rec.submittedSalary += safeInt(r.salary);
    });

    const ordered = orderPositions(Array.from(map.keys()));
    return ordered.map((p) => map.get(p)).filter(Boolean);
  }

  function renderRestructureSummaryPage(eligibleRows, submittedRows, teamName, positionLabel) {
    const eligibleCount = eligibleRows.length;
    const submittedCount = submittedRows.length;
    const eligibleSalary = eligibleRows.reduce((acc, r) => acc + safeInt(r.salary), 0);
    const submittedSalary = submittedRows.reduce((acc, r) => acc + safeInt(r.salary), 0);
    const rows = buildRestructureSummaryByPos(eligibleRows, submittedRows);
    const scopeTxt =
      positionLabel && positionLabel !== "__ALL_POS__" ? ` | Position: ${positionLabel}` : "";

    const top = `
      <div class="ccc-summaryTitle" style="margin:0 0 10px 2px;">${htmlEsc(teamName)} Restructure Summary${htmlEsc(
      scopeTxt
    )}</div>
      <div class="ccc-miniGrid">
        <div class="ccc-miniKpi"><div class="label">Eligible Players</div><div class="value">${eligibleCount}</div></div>
        <div class="ccc-miniKpi"><div class="label">Eligible Salary</div><div class="value">${eligibleSalary.toLocaleString()}</div></div>
        <div class="ccc-miniKpi"><div class="label">Submitted</div><div class="value">${submittedCount}</div></div>
        <div class="ccc-miniKpi"><div class="label">Submitted Salary</div><div class="value">${submittedSalary.toLocaleString()}</div></div>
      </div>
    `;

    if (!rows.length) {
      return `<div class="ccc-summaryPage">${top}<div class="ccc-tableWrap" style="padding:12px;">No summary rows.</div></div>`;
    }

    const body = rows
      .map((r) => {
        const rowClass = buildRowClass(r, r.pos);
        return `
          <tr class="${rowClass}">
            <td>${htmlEsc(r.pos)}</td>
            <td>${r.eligible}</td>
            <td>${r.eligible2}</td>
            <td>${r.eligible3}</td>
            <td>${safeInt(r.eligibleSalary).toLocaleString()}</td>
            <td>${safeInt(r.eligibleSalary2).toLocaleString()}</td>
            <td>${safeInt(r.eligibleSalary3).toLocaleString()}</td>
            <td>${r.submitted}</td>
            <td>${safeInt(r.submittedSalary).toLocaleString()}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="ccc-summaryPage">
        ${top}
        <div class="ccc-tableWrap">
          <table class="ccc-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Eligible</th>
                <th>Eligible 2Y</th>
                <th>Eligible 3Y</th>
                <th>Eligible Salary</th>
                <th>Eligible Salary 2Y</th>
                <th>Eligible Salary 3Y</th>
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

  function renderMymSubmissionSeasonControls(options, selected) {
    const list = Array.isArray(options) ? options.filter(Boolean) : [];
    if (!list.length) return "";
    const opts = list
      .map((s) => {
        const val = htmlEsc(s);
        const isSel = normalizeSeasonValue(s) === normalizeSeasonValue(selected);
        return `<option value="${val}"${isSel ? " selected" : ""}>${val}</option>`;
      })
      .join("");

    return `
      <div class="ccc-summaryControls">
        <span class="ccc-navTitle">Submission Season</span>
        <select class="ccc-select" data-mym-submission-season="1">${opts}</select>
      </div>
    `;
  }

  function buildTagIneligibleOneYearRows(rows) {
    const list = (rows || []).filter((r) => {
      if (safeInt(r.contract_year) !== 1) return false;
      if (safeInt(r.is_tag_eligible) === 1) return false;
      const text = `${safeStr(r.eligibility_reason)} ${safeStr(r.contract_status)} ${safeStr(
        r.contract_info
      )}`.toLowerCase();
      return /(tag|superflex|keeper|auction)/.test(text);
    });
    list.sort((a, b) => {
      const fa = safeStr(a.franchise_name || a.franchise_id);
      const fb = safeStr(b.franchise_name || b.franchise_id);
      if (fa !== fb) return fa.localeCompare(fb);
      return safeStr(a.player_name).localeCompare(safeStr(b.player_name));
    });
    return list;
  }

  function renderTagIneligibleList(rows) {
    if (!rows.length) return "";
    const body = rows
      .map(
        (r) => `
      <tr class="${buildRowClass(r, posKeyFromRow(r))}"${buildTeamStyle(r) ? ` style="${buildTeamStyle(r)}"` : ""}>
        <td>${htmlEsc(r.franchise_name || r.franchise_id)}</td>
        <td class="playerCell">${htmlEsc(r.player_name)}</td>
        <td>${htmlEsc(posKeyFromRow(r))}</td>
        <td class="explain">${htmlEsc(r.eligibility_reason || r.contract_status || "Ineligible")}</td>
      </tr>
    `
      )
      .join("");
    return `
      <div class="ccc-summary" style="margin-top:10px;">
        <div class="ccc-summaryTop">
          <div class="ccc-summaryTitle">Tag Ineligible (1-Year Cohort)</div>
        </div>
        <div class="muted" style="margin:4px 0 10px 0;">Previously tagged players and superflex keeper exceptions.</div>
        <div class="ccc-tableWrap">
          <table class="ccc-table">
            <thead><tr><th>Team</th><th>Player</th><th>Pos</th><th>Reason</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderTagSummary(teamName, rows, season, selectedTeamId, showAllTeams, allRows) {
    const count = rows.length;
    const tier1 = rows.filter((r) => safeInt(r.tag_tier) === 1).length;
    const tier2 = rows.filter((r) => safeInt(r.tag_tier) === 2).length;
    const tier3 = rows.filter((r) => safeInt(r.tag_tier) === 3).length;
    const deadlineInfo = getTagDeadlineInfo(season);

    let selectionsHtml = "";
    if (!showAllTeams && selectedTeamId) {
      const selections = getTagSelectionsForTeam(season, selectedTeamId);
      if (selections.length) {
        const selectionItems = selections
          .map(
            (sel) => `
              <span class="pill">${htmlEsc(sel.side)}: ${htmlEsc(sel.player_name)} (${htmlEsc(
              sel.pos
            )})</span>
              <button type="button" class="ccc-pageBtn" data-tag-clear="1" data-tag-key="${htmlEsc(
                sel.key
              )}">Clear</button>
            `
          )
          .join("");
        selectionsHtml = `
          <div class="muted" style="font-size:12px; margin-top:8px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
            <span style="font-weight:900; color: rgba(233,238,249,.8);">Selected Tags</span>
            ${selectionItems}
          </div>
        `;
      }
    }
    const clearLocalHtml = state.commishMode
      ? `<div style="margin-top:10px;"><button type="button" class="ccc-pageBtn" data-tag-clear-all="1">Clear Local Tag Selections</button></div>`
      : "";
    const ineligibleRows = buildTagIneligibleOneYearRows(allRows || rows);
    const ineligibleHtml = renderTagIneligibleList(ineligibleRows);

    return `
      <div class="ccc-summaryTop">
        <div class="ccc-summaryTitle">${htmlEsc(teamName)} Tag Tracking Snapshot</div>
      </div>
      <div class="ccc-kpis">
        <div class="kpi">
          <div class="label">Total Players</div>
          <div class="value">${count}</div>
          <div class="hint">snapshot excludes currently tagged or ineligible players</div>
        </div>
        <div class="kpi">
          <div class="label">Players by Tier</div>
          <div class="value">
            <button type="button" class="ccc-pageBtn" data-tag-tier-summary="1">
              Tier 1 - ${tier1} | Tier 2 - ${tier2} | Tier 3 - ${tier3}
            </button>
          </div>
          <div class="hint">tier counts across tag pool</div>
        </div>
        ${
          deadlineInfo
            ? `
        <div class="kpi">
          <div class="label">Tag Deadline</div>
          <div class="value">${htmlEsc(fmtYMDDate(deadlineInfo.tagDeadline))}</div>
          <div class="hint">tag window close</div>
        </div>
        `
            : ""
        }
      </div>
      ${selectionsHtml}
      ${clearLocalHtml}
      ${ineligibleHtml}
    `;
  }

  const TAG_TIER_RULES = {
    QB: [
      { tier: 1, avg_min: 1, avg_max: 5, label: "Avg Top 1-5 QB AAV" },
      { tier: 2, avg_min: 6, avg_max: 15, label: "Avg Top 6-15 QB AAV" },
      { tier: 3, avg_min: 16, avg_max: 24, label: "Avg Top 16-24 QB AAV" },
    ],
    RB: [
      { tier: 1, avg_min: 1, avg_max: 4, label: "Avg Top 1-4 RB AAV" },
      { tier: 2, avg_min: 5, avg_max: 8, label: "Avg Top 5-8 RB AAV" },
      { tier: 3, avg_min: 9, avg_max: 31, label: "Avg Top 9-31 RB AAV" },
    ],
    WR: [
      { tier: 1, avg_min: 1, avg_max: 6, label: "Avg Top 1-6 WR AAV" },
      { tier: 2, avg_min: 7, avg_max: 14, label: "Avg Top 7-14 WR AAV" },
      { tier: 3, avg_min: 15, avg_max: 40, label: "Avg Top 15-40 WR AAV" },
    ],
    TE: [
      { tier: 1, avg_min: 1, avg_max: 3, label: "Avg Top 1-3 TE AAV" },
      { tier: 2, avg_min: 4, avg_max: 6, label: "Avg Top 4-6 TE AAV" },
      { tier: 3, avg_min: 7, avg_max: 13, label: "Avg Top 7-13 TE AAV" },
    ],
    DL: [
      { tier: 1, avg_min: 1, avg_max: 6, label: "Avg Top 1-6 DL AAV" },
      { tier: 2, avg_min: 7, avg_max: 12, label: "Avg Top 7-12 DL AAV" },
    ],
    LB: [
      { tier: 1, avg_min: 1, avg_max: 6, label: "Avg Top 1-6 LB AAV" },
      { tier: 2, avg_min: 7, avg_max: 12, label: "Avg Top 7-12 LB AAV" },
    ],
    DB: [
      { tier: 1, avg_min: 1, avg_max: 6, label: "Avg Top 1-6 DB AAV" },
      { tier: 2, avg_min: 7, avg_max: 12, label: "Avg Top 7-12 DB AAV" },
    ],
    PK: [{ tier: 1, avg_min: null, avg_max: null, label: "K/P rule: prior AAV + 1,000" }],
  };

  const TAG_POS_ORDER = ["QB", "RB", "WR", "TE", "DL", "DB", "LB", "P", "PK"];
  const TAG_OFFENSE_POS = new Set(["QB", "RB", "WR", "TE"]);

  function normalizeTagSummarySide(value) {
    const v = safeStr(value).toUpperCase();
    if (v === "OFFENSE" || v === "OFF") return "OFFENSE";
    if (v === "DEFENSE" || v === "DEF" || v === "IDP" || v === "IDP_K") return "DEFENSE";
    return "ALL";
  }

  function tagRowMatchesSide(row, side) {
    const normalized = normalizeTagSummarySide(side);
    if (normalized === "ALL") return true;
    const rowSide = safeStr(row.tag_side).toUpperCase();
    if (normalized === "OFFENSE") return rowSide === "OFFENSE";
    return rowSide !== "OFFENSE";
  }

  function posMatchesSide(pos, side) {
    const normalized = normalizeTagSummarySide(side);
    if (normalized === "ALL") return true;
    const key = safeStr(pos).toUpperCase();
    const isOffense = TAG_OFFENSE_POS.has(key);
    return normalized === "OFFENSE" ? isOffense : !isOffense;
  }

  function orderPositions(list) {
    const unique = Array.from(new Set((list || []).map((p) => safeStr(p).toUpperCase()).filter(Boolean)));
    const ordered = TAG_POS_ORDER.filter((p) => unique.includes(p));
    const rest = unique.filter((p) => !TAG_POS_ORDER.includes(p)).sort();
    return ordered.concat(rest);
  }

  function computePpgRanks(tagRows, poolRows, minGamesEnabled, minGames) {
    const pool =
      Array.isArray(poolRows) && poolRows.length ? poolRows : Array.isArray(tagRows) ? tagRows : [];
    const byPos = new Map();
    pool.forEach((r) => {
      const pos = safeStr(
        r.positional_grouping || r.positional_group || r.pos_group || r.position
      ).toUpperCase();
      if (!pos) return;
      const list = byPos.get(pos) || [];
      list.push(r);
      byPos.set(pos, list);
    });

    const rankMap = new Map();
    byPos.forEach((list) => {
      const eligible = list.filter((r) => {
        const games = safeInt(r.games_played);
        if (games <= 0) return false;
        if (minGamesEnabled && games < minGames) return false;
        return true;
      });

      eligible.sort((a, b) => {
        const ppgDiff = Number(b.points_per_game || 0) - Number(a.points_per_game || 0);
        if (ppgDiff !== 0) return ppgDiff;
        const ptsDiff = Number(b.points_total || 0) - Number(a.points_total || 0);
        if (ptsDiff !== 0) return ptsDiff;
        return safeStr(a.player_name).localeCompare(safeStr(b.player_name));
      });

      eligible.forEach((r, idx) => {
        const pid = safeStr(r.player_id || r.id);
        if (pid) rankMap.set(pid, idx + 1);
      });
    });

    (tagRows || []).forEach((r) => {
      const pid = safeStr(r.player_id || r.id);
      r._ppg_rank = pid && rankMap.has(pid) ? rankMap.get(pid) : 0;
      r._ppg_min_games = minGames;
      r._ppg_min_enabled = !!minGamesEnabled;
    });
  }

  function buildTagBreakdownByPos(rows) {
    const byPos = new Map();
    (rows || []).forEach((r) => {
      const pos = safeStr(r.positional_grouping || r.position || "NA").toUpperCase();
      const rec = byPos.get(pos) || { pos, count: 0, total: 0, tier1: 0, tier2: 0, tier3: 0 };
      rec.count += 1;
      rec.total += safeInt(r.tag_bid || r.tag_salary);
      const t = safeInt(r.tag_tier);
      if (t === 1) rec.tier1 += 1;
      else if (t === 2) rec.tier2 += 1;
      else if (t === 3) rec.tier3 += 1;
      byPos.set(pos, rec);
    });
    const ordered = orderPositions(Array.from(byPos.keys()));
    return ordered.map((pos) => byPos.get(pos)).filter(Boolean);
  }

  function buildTagBreakdownByTeam(rows) {
    const byTeam = new Map();
    (rows || []).forEach((r) => {
      const team = safeStr(r.franchise_name || r.franchise_id || "Team");
      const rec = byTeam.get(team) || { team, count: 0, total: 0, tier1: 0, tier2: 0, tier3: 0 };
      rec.count += 1;
      rec.total += safeInt(r.tag_bid || r.tag_salary);
      const t = safeInt(r.tag_tier);
      if (t === 1) rec.tier1 += 1;
      else if (t === 2) rec.tier2 += 1;
      else if (t === 3) rec.tier3 += 1;
      byTeam.set(team, rec);
    });
    return Array.from(byTeam.values()).sort((a, b) => safeStr(a.team).localeCompare(safeStr(b.team)));
  }

  function renderTagCalcBreakdown(calcBreakdown, sideFilter, fallbackRows) {
    const normalizedSide = normalizeTagSummarySide(sideFilter);
    const breakdown =
      calcBreakdown && typeof calcBreakdown === "object"
        ? calcBreakdown.positions || calcBreakdown
        : null;

    if (breakdown && typeof breakdown === "object" && Object.keys(breakdown).length) {
      const positions = orderPositions(Object.keys(breakdown)).filter((p) =>
        posMatchesSide(p, normalizedSide)
      );
      if (!positions.length) return "";

      const posBlocks = positions
        .map((pos) => {
          const posData = breakdown[pos] || {};
          const tiers = (posData.tiers || []).map((tier) => {
            const tierNum = safeInt(tier.tier || tier.tier_num);
            const label = safeStr(tier.label || tier.rule_label || tier.ruleLabel);
            const baseBid = safeInt(tier.base_bid || tier.baseBid);
            const players = Array.isArray(tier.players) ? tier.players : [];
            const playerLines = players.length
              ? players
                  .map((p) => {
                    const rank = safeInt(p.rank);
                    const name = htmlEsc(p.player_name || p.playerName || "");
                    const aav = safeInt(p.aav).toLocaleString();
                    const rankTxt = rank ? `#${rank} ` : "";
                    return `<div class="ccc-calcRow">${rankTxt}${name} — AAV ${aav}</div>`;
                  })
                  .join("")
              : `<div class="ccc-calcRow">No players in range.</div>`;
            const baseTxt = baseBid ? ` | Base ${baseBid.toLocaleString()}` : "";
            const labelTxt = label ? ` — ${htmlEsc(label)}` : "";
            return `
              <details class="ccc-calcTier">
                <summary>Tier ${tierNum || ""}${labelTxt}${baseTxt}</summary>
                <div class="ccc-calcPlayers">${playerLines}</div>
              </details>
            `;
          });

          return `
            <details class="ccc-calcPos">
              <summary>${htmlEsc(pos)}</summary>
              ${tiers.join("")}
            </details>
          `;
        })
        .join("");

      return `
        <div class="ccc-calcBreakdown">
          ${posBlocks}
        </div>
      `;
    }

    const rows = (fallbackRows || []).filter((r) => tagRowMatchesSide(r, normalizedSide));
    const byPos = new Map();
    rows.forEach((r) => {
      const pos = safeStr(r.positional_grouping || r.position).toUpperCase();
      if (!TAG_TIER_RULES[pos]) return;
      const list = byPos.get(pos) || [];
      list.push(r);
      byPos.set(pos, list);
    });
    if (!byPos.size) return "";

    const positions = orderPositions(Array.from(byPos.keys()));

    const posBlocks = positions
      .map((pos) => {
        const list = byPos.get(pos) || [];
        const ranked = list
          .map((r) => ({
            row: r,
            calcAav: safeInt(r.prior_aav_week1 || r.aav),
          }))
          .sort(
            (a, b) =>
              b.calcAav - a.calcAav ||
              safeStr(a.row.player_name).localeCompare(safeStr(b.row.player_name))
          )
          .map((rec, idx) => ({ ...rec, rank: idx + 1 }));

        const tiers = (TAG_TIER_RULES[pos] || []).map((rule) => {
          let players = ranked;
          if (rule.avg_min) {
            const start = Math.max(1, rule.avg_min);
            const end = rule.avg_max ? rule.avg_max : ranked.length;
            players = ranked.filter((p) => p.rank >= start && p.rank <= end);
          }
          const baseBid = players.reduce((acc, p) => {
            const bid = safeInt(p.row.tag_base_bid || p.row.tag_salary);
            return bid > acc ? bid : acc;
          }, 0);
          const playerLines = players.length
            ? players
                .map((p) => {
                  const name = htmlEsc(p.row.player_name || "");
                  const aav = safeInt(p.calcAav).toLocaleString();
                  return `<div class="ccc-calcRow">#${p.rank} ${name} — AAV ${aav}</div>`;
                })
                .join("")
            : `<div class="ccc-calcRow">No players in range.</div>`;
          const baseTxt = baseBid ? ` | Base ${baseBid.toLocaleString()}` : "";
          return `
            <details class="ccc-calcTier">
              <summary>Tier ${rule.tier} — ${htmlEsc(rule.label)}${baseTxt}</summary>
              <div class="ccc-calcPlayers">${playerLines}</div>
            </details>
          `;
        });

        return `
          <details class="ccc-calcPos">
            <summary>${htmlEsc(pos)}</summary>
            ${tiers.join("")}
          </details>
        `;
      })
      .join("");

    return `
      <div class="ccc-calcBreakdown">
        ${posBlocks}
      </div>
    `;
  }

  function renderTagSummaryPage(rows, teamName, view, calcOpen, meta, sideFilter, calcRows) {
    const normalizedSide = normalizeTagSummarySide(sideFilter);
    const filteredRows = (rows || []).filter((r) => tagRowMatchesSide(r, normalizedSide));
    const viewLabel = view === "team" ? "By Team" : "By Position";
    const sideLabel =
      normalizedSide === "OFFENSE"
        ? "Offense"
        : normalizedSide === "DEFENSE"
        ? "Defense/ST"
        : "All Players";
    const controls = `
      <div class="ccc-summaryControls">
        <span class="ccc-navTitle">Summary View</span>
        <button type="button" class="ccc-pageBtn ${view === "pos" ? "is-active" : ""}" data-tag-summary-view="pos" aria-pressed="${view === "pos" ? "true" : "false"}">By Position</button>
        <button type="button" class="ccc-pageBtn ${view === "team" ? "is-active" : ""}" data-tag-summary-view="team" aria-pressed="${view === "team" ? "true" : "false"}">By Team</button>
        <span class="ccc-navTitle" style="margin-left:6px;">Scope</span>
        <button type="button" class="ccc-pageBtn ${normalizedSide === "ALL" ? "is-active" : ""}" data-tag-summary-side="all" aria-pressed="${normalizedSide === "ALL" ? "true" : "false"}">All</button>
        <button type="button" class="ccc-pageBtn ${normalizedSide === "OFFENSE" ? "is-active" : ""}" data-tag-summary-side="offense" aria-pressed="${normalizedSide === "OFFENSE" ? "true" : "false"}">Offense</button>
        <button type="button" class="ccc-pageBtn ${normalizedSide === "DEFENSE" ? "is-active" : ""}" data-tag-summary-side="defense" aria-pressed="${normalizedSide === "DEFENSE" ? "true" : "false"}">Defense/ST</button>
      </div>
    `;

    const top = `
      <div class="ccc-summaryTitle" style="margin:0 0 10px 2px;">${htmlEsc(
        teamName
      )} Tag Summary ${htmlEsc(viewLabel)} (${htmlEsc(sideLabel)})</div>
      ${controls}
      <div class="ccc-miniGrid">
        <div class="ccc-miniKpi"><div class="label">Players Tracked</div><div class="value">${filteredRows.length}</div></div>
      </div>
    `;

    if (!filteredRows.length) {
      return `<div class="ccc-summaryPage">${top}<div class="ccc-tableWrap" style="padding:12px;">No tag tracking rows.</div></div>`;
    }

    const canTagFromSummary = (r) => {
      if (!canManageTagForFranchise(r.franchise_id)) return false;
      return true;
    };

    const renderSummaryTagButton = (r) => {
      const season = normalizeSeasonValue(r.season || state.selectedSeason);
      const side = safeStr(r.tag_side || "OFFENSE");
      const limit = Math.max(1, safeInt(r.tag_limit_per_side || 1));
      const key = buildTagSelectionKey(season, r.franchise_id, side);
      const selected = state.tagSelections[key];
      const isSelected = !!selected && safeStr(selected.player_id) === safeStr(r.player_id);
      const isLocked = !state.commishMode && !!selected && !isSelected && limit <= 1;
      const tagLabel = isSelected ? "Selected" : isLocked ? "Locked" : "Tag";
      return `
        <button
          type="button"
          class="ccc-btn ccc-btn-tag${isSelected ? " is-selected" : ""}"
          data-tag-action="1"
          data-tag-side="${htmlEsc(side)}"
          data-tag-limit="${limit}"
          data-season="${htmlEsc(season)}"
          data-franchise-id="${htmlEsc(pad4(r.franchise_id))}"
          data-franchise-name="${htmlEsc(r.franchise_name || "")}"
          data-player-id="${htmlEsc(r.player_id)}"
          data-player-name="${htmlEsc(r.player_name)}"
          data-pos="${htmlEsc(posKeyFromRow(r))}"
          ${isLocked ? "disabled" : ""}
        >${tagLabel}</button>
      `;
    };

    if (view === "team") {
      const groupMap = new Map();
      filteredRows.forEach((r) => {
        const team = safeStr(r.franchise_name || r.franchise_id || "Team");
        const teamId = pad4(r.franchise_id);
        const key = teamId || team;
        let group = groupMap.get(key);
        if (!group) {
          group = {
            team,
            team_id: teamId,
            rows: new Map(),
            count: 0,
            tier1: 0,
            tier2: 0,
            tier3: 0,
          };
          groupMap.set(key, group);
        }
        const pos = safeStr(r.positional_grouping || r.position || "NA").toUpperCase();
        let rec = group.rows.get(pos);
        if (!rec) {
          rec = { pos, count: 0, tier1: 0, tier2: 0, tier3: 0, players: [] };
          group.rows.set(pos, rec);
        }
        rec.count += 1;
        rec.players.push(r);
        const t = safeInt(r.tag_tier);
        if (t === 1) rec.tier1 += 1;
        else if (t === 2) rec.tier2 += 1;
        else if (t === 3) rec.tier3 += 1;

        group.count += 1;
        if (t === 1) group.tier1 += 1;
        else if (t === 2) group.tier2 += 1;
        else if (t === 3) group.tier3 += 1;
      });

      const groups = Array.from(groupMap.values()).sort((a, b) =>
        safeStr(a.team).localeCompare(safeStr(b.team))
      );

      const body = groups
        .map((g) => {
          const rowStyle = buildTeamStyle(g.team_id, g.team);
          const summaryStyle = rowStyle ? ` style="${rowStyle}"` : "";
          const positions = orderPositions(Array.from(g.rows.keys()));
          const detailRows = positions
            .map((pos) => {
              const r = g.rows.get(pos);
              if (!r) return "";
              const rowClass = buildRowClass({ franchise_id: g.team_id }, r.pos);
              const styleAttr = rowStyle ? ` style="${rowStyle}"` : "";
              const players = (r.players || [])
                .slice()
                .sort(
                  (a, b) =>
                    safeInt(b.points_total) - safeInt(a.points_total) ||
                    safeStr(a.player_name).localeCompare(safeStr(b.player_name))
                )
                .map((p) => {
                  const canTag = canTagFromSummary(p);
                  const action = canTag ? renderSummaryTagButton(p) : "";
                  return `
                    <tr class="${buildRowClass(p, posKeyFromRow(p))}"${styleAttr}>
                      <td class="playerCell">${htmlEsc(p.player_name)}</td>
                      <td>${htmlEsc(posKeyFromRow(p))}</td>
                      <td class="cell-num">${safeInt(p.tag_tier) || "—"}</td>
                      <td class="cell-num">${safeInt(p.tag_bid || p.tag_salary).toLocaleString()}</td>
                      <td>${action}</td>
                    </tr>
                  `;
                })
                .join("");
              return `
            <tr class="${rowClass}"${styleAttr}>
              <td>${htmlEsc(r.pos)}</td>
              <td>${r.count}</td>
              <td>${r.tier1}</td>
              <td>${r.tier2}</td>
              <td>${r.tier3}</td>
            </tr>
            <tr class="${rowClass}"${styleAttr}>
              <td colspan="5">
                <details class="ccc-summaryPlayers">
                  <summary>Players (${r.count})</summary>
                  <div class="ccc-tableWrap ccc-summary-force-team" style="margin-top:8px;">
                    <table class="ccc-table">
                      <thead>
                        <tr><th>Player</th><th>Pos</th><th>Tier</th><th>Tag $</th><th>Action</th></tr>
                      </thead>
                      <tbody>${players}</tbody>
                    </table>
                  </div>
                </details>
              </td>
            </tr>`;
            })
            .join("");

          return `
        <details class="ccc-summaryGroup">
          <summary>
            <div class="ccc-summaryRow"${summaryStyle}>
              <div class="ccc-summaryTeam">${htmlEsc(g.team)}</div>
              <div class="ccc-summaryStat"><span class="label">Tracked</span><span class="value">${g.count}</span></div>
              <div class="ccc-summaryStat"><span class="label">Tier 1</span><span class="value">${g.tier1}</span></div>
              <div class="ccc-summaryStat"><span class="label">Tier 2</span><span class="value">${g.tier2}</span></div>
              <div class="ccc-summaryStat"><span class="label">Tier 3</span><span class="value">${g.tier3}</span></div>
            </div>
          </summary>
          <div class="ccc-tableWrap ccc-summary-force-team">
            <table class="ccc-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Tracked</th>
                  <th>Tier 1</th>
                  <th>Tier 2</th>
                  <th>Tier 3</th>
                </tr>
              </thead>
              <tbody>${detailRows}</tbody>
            </table>
          </div>
        </details>
        `;
        })
        .join("");

      return `
      <div class="ccc-summaryPage">
        ${top}
        ${body}
      </div>
    `;
    }

    const posMap = new Map();
    filteredRows.forEach((r) => {
      const pos = safeStr(r.positional_grouping || r.position || "NA").toUpperCase();
      let rec = posMap.get(pos);
      if (!rec) {
        rec = { pos, count: 0, tier1: 0, tier2: 0, tier3: 0, players: [] };
        posMap.set(pos, rec);
      }
      rec.count += 1;
      rec.players.push(r);
      const t = safeInt(r.tag_tier);
      if (t === 1) rec.tier1 += 1;
      else if (t === 2) rec.tier2 += 1;
      else if (t === 3) rec.tier3 += 1;
    });
    const rowsOut = orderPositions(Array.from(posMap.keys()))
      .map((k) => posMap.get(k))
      .filter(Boolean);
    const body = rowsOut
      .map((r) => {
        const rowClass = buildRowClass(r, r.pos);
        const players = (r.players || [])
          .slice()
          .sort(
            (a, b) =>
              safeInt(b.points_total) - safeInt(a.points_total) ||
              safeStr(a.player_name).localeCompare(safeStr(b.player_name))
          )
          .map((p) => {
            const canTag = canTagFromSummary(p);
            const action = canTag ? renderSummaryTagButton(p) : "";
            return `
              <tr class="${buildRowClass(p, posKeyFromRow(p))}">
                <td class="playerCell">${htmlEsc(p.player_name)}</td>
                <td>${htmlEsc(p.franchise_name || p.franchise_id)}</td>
                <td class="cell-num">${safeInt(p.tag_tier) || "—"}</td>
                <td class="cell-num">${safeInt(p.tag_bid || p.tag_salary).toLocaleString()}</td>
                <td>${action}</td>
              </tr>
            `;
          })
          .join("");
        return `
          <tr class="${rowClass}">
            <td>${htmlEsc(r.pos)}</td>
            <td>${r.count}</td>
            <td>${r.tier1}</td>
            <td>${r.tier2}</td>
            <td>${r.tier3}</td>
          </tr>
          <tr class="${rowClass}">
            <td colspan="5">
              <details class="ccc-summaryPlayers">
                <summary>Players (${r.count})</summary>
                <div class="ccc-tableWrap ccc-summary-force-pos" style="margin-top:8px;">
                  <table class="ccc-table">
                    <thead>
                      <tr><th>Player</th><th>Team</th><th>Tier</th><th>Tag $</th><th>Action</th></tr>
                    </thead>
                    <tbody>${players}</tbody>
                  </table>
                </div>
              </details>
            </td>
          </tr>
        `;
      })
      .join("");

    const headerLabel = "Position";

    return `
      <div class="ccc-summaryPage">
        ${top}
        <div class="ccc-tableWrap ccc-summary-force-pos">
          <table class="ccc-table">
            <thead>
              <tr>
                <th>${headerLabel}</th>
                <th>Tracked</th>
                <th>Tier 1</th>
                <th>Tier 2</th>
                <th>Tier 3</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function buildTagSubmissionSeasonList(defaultSeason) {
    const set = new Set();
    Object.values(state.tagSubmissions || {}).forEach((s) => {
      const season = normalizeSeasonValue(s && s.season);
      if (season) set.add(season);
    });
    const list = Array.from(set).sort((a, b) => safeInt(b) - safeInt(a));
    const def = normalizeSeasonValue(defaultSeason);
    if (def && !list.includes(def)) list.unshift(def);
    return list.length ? list : def ? [def] : [];
  }

  function renderTagCostCalcPage(meta, sideFilter, calcRows) {
    const normalizedSide = normalizeTagSummarySide(sideFilter);
    const sideLabel =
      normalizedSide === "OFFENSE"
        ? "Offense"
        : normalizedSide === "DEFENSE"
        ? "Defense/ST"
        : "All Players";
    const controls = `
      <div class="ccc-summaryControls" style="margin-bottom:10px;">
        <span class="ccc-navTitle">Scope</span>
        <button type="button" class="ccc-pageBtn ${normalizedSide === "ALL" ? "is-active" : ""}" data-tag-summary-side="all" aria-pressed="${normalizedSide === "ALL" ? "true" : "false"}">All</button>
        <button type="button" class="ccc-pageBtn ${normalizedSide === "OFFENSE" ? "is-active" : ""}" data-tag-summary-side="offense" aria-pressed="${normalizedSide === "OFFENSE" ? "true" : "false"}">Offense</button>
        <button type="button" class="ccc-pageBtn ${normalizedSide === "DEFENSE" ? "is-active" : ""}" data-tag-summary-side="defense" aria-pressed="${normalizedSide === "DEFENSE" ? "true" : "false"}">Defense/ST</button>
      </div>
    `;
    const calcData =
      meta && typeof meta === "object"
        ? meta.calc_breakdown || meta.calcBreakdown || null
        : null;
    const calcHtml = calcData
      ? renderTagCalcBreakdown(calcData, normalizedSide, calcRows || [])
      : "";
    const body = calcHtml || `<div class="ccc-tableWrap" style="padding:12px;">No calc data.</div>`;
    return `
      <div class="ccc-summaryPage">
        <div class="ccc-summaryTitle" style="margin:0 0 10px 2px;">Cost Calc Breakdown (${htmlEsc(
          sideLabel
        )})</div>
        ${controls}
        ${body}
      </div>
    `;
  }

  function renderTagFinalizedSubmissionsPage(defaultSeason) {
    const seasonList = buildTagSubmissionSeasonList(defaultSeason);
    const fallbackSeason = normalizeSeasonValue(defaultSeason);
    if (!state.tagSubmissionSeason || !seasonList.includes(state.tagSubmissionSeason)) {
      state.tagSubmissionSeason = seasonList[0] || fallbackSeason || "";
    }
    const selectedSeason = state.tagSubmissionSeason;
    let rows = Object.values(state.tagSubmissions || {}).filter(
      (s) => normalizeSeasonValue(s && s.season) === selectedSeason
    );
    const selectedTeamId = state && state.showAllTeams ? "__ALL__" : pad4(state.selectedTeam);
    if (selectedTeamId && selectedTeamId !== "__ALL__") {
      rows = rows.filter((r) => pad4(r.franchise_id) === selectedTeamId);
    }
    const posFilter = safeStr(state && state.selectedPosition);
    if (posFilter && posFilter !== "__ALL_POS__") {
      rows = rows.filter((r) => posKeyFromRow(r) === posFilter);
    }

    const seasonOptions = seasonList
      .map(
        (s) =>
          `<option value="${htmlEsc(s)}" ${s === selectedSeason ? "selected" : ""}>${htmlEsc(
            s
          )}</option>`
      )
      .join("");

    const header = `
      <div class="ccc-summaryControls" style="margin-bottom:10px;">
        <span class="ccc-navTitle">Finalized Submissions</span>
        <label class="ccc-field">
          Season
          <select class="ccc-select" data-tag-submission-season="1">
            ${seasonOptions}
          </select>
        </label>
      </div>
    `;

    if (!rows.length) {
      return `${header}<div class="ccc-tableWrap" style="padding:12px;">No submissions for ${htmlEsc(
        selectedSeason || ""
      )}.</div>`;
    }

    const body = rows
      .sort((a, b) => {
        const da = parseDate(a.submitted_at_utc) || new Date(0);
        const db = parseDate(b.submitted_at_utc) || new Date(0);
        return db - da;
      })
      .map((r) => {
        const submittedFmt = formatSubmittedValue(r.submitted_at_utc);
        const submitted = `${htmlEsc(submittedFmt.date)}${
          submittedFmt.time ? `<div class="cell-sub">${htmlEsc(submittedFmt.time)}</div>` : ""
        }`;
        return `
          <tr>
            <td>${submitted}</td>
            <td>${htmlEsc(r.franchise_name || r.franchise_id || "")}</td>
            <td class="playerCell">${htmlEsc(r.player_name || "")}</td>
            <td class="muted">${htmlEsc(r.pos || "")}</td>
            <td>${htmlEsc(r.side || "")}</td>
            <td class="cell-num">${getTagSalaryForSubmission(r).toLocaleString()}</td>
          </tr>
        `;
      })
      .join("");

    return `
      ${header}
      <div class="ccc-tableWrap">
        <table class="ccc-table">
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Team</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Side</th>
              <th>Salary</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
  }

  function buildExtensionPreview(row, yearsToAdd, customYearSalaries) {
    const salaryNow = safeInt(row && row.salary);
    const years = Math.max(1, Math.min(2, safeInt(yearsToAdd) || 1));
    const season = normalizeSeasonValue(state.selectedSeason || row.season || DEFAULT_YEAR);
    const expiredRookie = isExpiredRookieRow(row);
    const pos = posKeyFromRow(row);
    const raise = getExtensionRate(pos, season, years);
    const nextSeason = String(safeInt(season) + 1 || safeInt(DEFAULT_YEAR) + 1);
    const secondSeason = String(safeInt(season) + 2 || safeInt(DEFAULT_YEAR) + 2);

    let yearSalaries = [];
    if (expiredRookie) {
      const defaultAav = roundToK(salaryNow + raise);
      const y1Raw = customYearSalaries && customYearSalaries[0] ? safeInt(customYearSalaries[0]) : defaultAav;
      const y1 = Math.max(1000, roundToK(y1Raw));
      if (years === 1) {
        yearSalaries = [y1];
      } else {
        const y2Raw = customYearSalaries && customYearSalaries[1] ? safeInt(customYearSalaries[1]) : defaultAav;
        const y2 = Math.max(1000, roundToK(y2Raw));
        yearSalaries = [y1, y2];
      }
    } else {
      const extAav = Math.max(1000, roundToK(salaryNow + raise));
      yearSalaries = [salaryNow];
      for (let i = 0; i < years; i++) yearSalaries.push(extAav);
    }

    const totalYears = yearSalaries.length;
    const tcv = yearSalaries.reduce((a, b) => a + safeInt(b), 0);
    const y1 = safeInt(yearSalaries[0] || 0);
    const minY1 = Math.max(1000, roundToK(Math.ceil((tcv * 0.2) / 1000) * 1000));
    const minY1Violation = expiredRookie && totalYears > 1 && y1 < minY1;
    const gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - y1);

    const lines = [];
    if (expiredRookie) {
      lines.push(`Current Season (${season}): ${safeInt(yearSalaries[0]).toLocaleString()}`);
      if (totalYears > 1) lines.push(`${nextSeason}: ${safeInt(yearSalaries[1]).toLocaleString()}`);
    } else {
      lines.push(`Current Season (${season}): ${safeInt(yearSalaries[0]).toLocaleString()} (unchanged)`);
      lines.push(`${nextSeason}: ${safeInt(yearSalaries[1]).toLocaleString()}`);
      if (totalYears > 2) lines.push(`${secondSeason}: ${safeInt(yearSalaries[2]).toLocaleString()}`);
    }
    lines.push(`TCV: ${tcv.toLocaleString()} | GTD: ${gtd.toLocaleString()}`);
    lines.push(`Raise Applied (${years}Y): +${raise.toLocaleString()}`);
    if (minY1Violation) lines.push(`ERROR: Year 1 must be at least ${minY1.toLocaleString()} (20% of TCV, rounded up).`);

    const yearParts = yearSalaries.map((v, i) => `Y${i + 1}-${formatK(v)}`).join(", ");
    const ownerNick = getOwnerExtensionNickname(row && row.franchise_id);
    const contractInfo = `CL ${totalYears}| TCV ${formatK(tcv)}| AAV ${formatK(
      Math.round(tcv / Math.max(1, totalYears))
    )}| ${yearParts}| GTD: ${formatK(gtd)}| Ext +${years}Y${ownerNick ? `| Ext: ${ownerNick}` : ""}`;

    return {
      yearsToAdd: years,
      expiredRookie,
      totalYears,
      yearSalaries,
      tcv,
      gtd,
      raise,
      minY1Violation,
      minY1,
      lines,
      payload: {
        type: "EXTENSION",
        league_id: safeStr(getLeagueId() || DEFAULT_LEAGUE_ID),
        season,
        franchise_id: pad4(row.franchise_id),
        franchise_name: safeStr(row.franchise_name || row.franchise_id),
        player_id: safeStr(row.player_id),
        player_name: safeStr(row.player_name),
        pos,
        current_salary: salaryNow,
        years_to_add: years,
        contract_year: totalYears,
        salary: safeInt(yearSalaries[0] || 0),
        contract_status: "Extension",
        contract_info: contractInfo,
      },
    };
  }

  function projectExtensionRowForward(row) {
    if (!row) return null;
    const years = safeInt(row.contract_year);
    const expired = isExpiredRookieRow(row);
    if (years <= 0) return expired ? { ...row, contract_year: 0 } : null;
    if (years === 1) {
      // 1-year non-expired contracts roll off; expired rookies remain as extension-eligible cohort.
      return expired ? { ...row, contract_year: 0 } : null;
    }

    const parsed = parseContractAmounts(row.contract_info, years, safeInt(row.salary) || 1000);
    const nextSalary = safeInt(parsed.y2 || row.salary);
    return {
      ...row,
      contract_year: Math.max(0, years - 1),
      salary: nextSalary > 0 ? nextSalary : safeInt(row.salary),
      _rolled_forward: 1,
    };
  }

  function projectExtensionRowsForSeason(rows, baseSeason, contractSeason) {
    const base = safeInt(normalizeSeasonValue(baseSeason));
    const contract = safeInt(normalizeSeasonValue(contractSeason));
    if (!base || !contract || contract <= base) return rows.slice();
    const out = [];
    (rows || []).forEach((r) => {
      const p = projectExtensionRowForward(r);
      if (p) out.push(p);
    });
    return out;
  }

  function renderExtensionsSummary(teamName, rows) {
    const eligible = rows.filter((r) => getExtensionEligibility(r, 1).ok).length;
    return `
      <div class="ccc-summaryTop">
        <div class="ccc-summaryTitle">${htmlEsc(teamName)} Extension Snapshot</div>
      </div>
      <div class="ccc-kpis">
        <div class="kpi"><div class="label">Total Players</div><div class="value">${rows.length}</div></div>
        <div class="kpi"><div class="label">Extension Eligible</div><div class="value">${eligible}</div><div class="hint">1-year deals or expired rookies, not already extended by current owner</div></div>
      </div>
    `;
  }

  function renderExtensionsSubmittedPage(defaultSeason) {
    const season = normalizeSeasonValue(defaultSeason || state.selectedSeason);
    let rows = Object.values(state.extensionSubmissions || {}).filter(
      (s) => normalizeSeasonValue(s && s.season) === season
    );
    const selectedTeamId = state && state.showAllTeams ? "__ALL__" : pad4(state.selectedTeam);
    if (selectedTeamId && selectedTeamId !== "__ALL__") {
      rows = rows.filter((r) => pad4(r.franchise_id) === selectedTeamId);
    }
    if (!rows.length) {
      return `<div class="ccc-tableWrap" style="padding:12px;">No extension submissions for ${htmlEsc(
        season
      )}.</div>`;
    }
    const body = rows
      .sort(
        (a, b) => (parseDate(b.submitted_at_utc) || new Date(0)) - (parseDate(a.submitted_at_utc) || new Date(0))
      )
      .map((r) => {
        const submittedFmt = formatSubmittedValue(r.submitted_at_utc);
        const submitted = `${htmlEsc(submittedFmt.date)}${
          submittedFmt.time ? `<div class="cell-sub">${htmlEsc(submittedFmt.time)}</div>` : ""
        }`;
        const style = buildTeamStyle(r);
        return `
          <tr class="${buildRowClass(r, posKeyFromRow(r))}"${style ? ` style="${style}"` : ""}>
            <td>${submitted}</td>
            <td>${htmlEsc(r.franchise_name || r.franchise_id)}</td>
            <td class="playerCell">${htmlEsc(r.player_name)}</td>
            <td>${htmlEsc(posKeyFromRow(r))}</td>
            <td class="cell-num">${safeInt(r.current_salary || r.salary).toLocaleString()}</td>
            <td class="cell-num">${safeInt(r.years_to_add)}</td>
            <td class="explain">${htmlEsc(r.contract_info || "")}</td>
          </tr>
        `;
      })
      .join("");
    return `<div class="ccc-tableWrap"><table class="ccc-table"><thead><tr><th>Submitted</th><th>Team</th><th>Player</th><th>Pos</th><th>Current Salary</th><th>Add Years</th><th>Preview</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function getExtensionEligibility(row, yearsToAdd) {
    const season = normalizeSeasonValue(row && row.season ? row.season : state.selectedSeason);
    if (!canExtendRow(row)) return { ok: false, reason: "Not extension-eligible by contract status." };
    if (isExtendedByCurrentOwner(row)) {
      return { ok: false, reason: "Already extended by current owner." };
    }
    const deadline = getExtensionDeadlineDateForRow(row, season);
    const now = state.calendarNow || getEffectiveNow(season);
    if (deadline && !state.commishMode && now.getTime() > endOfDay(deadline).getTime()) {
      return { ok: false, reason: `Deadline passed (${fmtYMDDate(deadline)}).`, deadline };
    }
    const years = Math.max(1, Math.min(2, safeInt(yearsToAdd) || 1));
    const projectedYears = isExpiredRookieRow(row) ? years : safeInt(row.contract_year) + years;
    if (projectedYears >= 3 && isNonRookieContract(row)) {
      const current = countTeamThreeYearNonRookieContracts(row.franchise_id, season);
      const projected = current + (safeInt(row.contract_year) >= 3 ? 0 : 1);
      if (projected > 6) {
        return {
          ok: false,
          reason: `3-year non-rookie cap exceeded (${projected}/6).`,
          deadline,
        };
      }
    }
    return { ok: true, reason: "", deadline };
  }

  function renderExtensionsTable(rows, tabMode) {
    if (!rows.length) return `<div class="ccc-tableWrap" style="padding:12px;">No rows.</div>`;
    const pageSize = clampInt(state.pageSize || 50, 10, 500);
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const pageRaw = state.pageByTab[tabMode] || 1;
    const pageNow = clampInt(pageRaw, 1, totalPages);
    if (pageNow !== pageRaw) updateTabPage(tabMode, pageNow);
    const start = (pageNow - 1) * pageSize;
    const pageRows = rows.slice(start, start + pageSize);
    const body = pageRows
      .map((r) => {
        const own = canManageTagForFranchise(r.franchise_id);
        const baseCheck = getExtensionEligibility(r, 1);
        const canExtend = own && baseCheck.ok;
        const lockReason = baseCheck.reason || "";
        const btn = canExtend
          ? `<button type="button" class="ccc-btn ccc-btn-offer" data-extension-action="1" data-season="${htmlEsc(
              normalizeSeasonValue(r.season || state.selectedSeason)
            )}" data-franchise-id="${htmlEsc(pad4(r.franchise_id))}" data-franchise-name="${htmlEsc(
              safeStr(r.franchise_name || r.franchise_id)
            )}" data-player-id="${htmlEsc(
              r.player_id
            )}" data-player-name="${htmlEsc(r.player_name)}" data-pos="${htmlEsc(
              posKeyFromRow(r)
            )}" data-salary="${safeInt(r.salary)}" data-contract-year="${safeInt(
              r.contract_year
            )}" data-contract-status="${htmlEsc(safeStr(r.contract_status))}" data-contract-info="${htmlEsc(
              safeStr(r.contract_info)
            )}" data-acquired-date="${htmlEsc(safeStr(r.acquired_date))}" data-mym-deadline="${htmlEsc(
              safeStr(r.mym_deadline)
            )}" data-acq-type="${htmlEsc(safeStr(r.mym_acq_type))}">Extend</button>`
          : `<span class="muted">${htmlEsc(lockReason || "—")}</span>`;
        const style = buildTeamStyle(r);
        return `
          <tr class="${buildRowClass(r, posKeyFromRow(r))}"${style ? ` style="${style}"` : ""}>
            <td>${btn}</td>
            <td class="playerCell">${htmlEsc(r.player_name)}</td>
            <td>${htmlEsc(posKeyFromRow(r))}</td>
            <td class="cell-num">${safeInt(r.salary).toLocaleString()}</td>
            <td class="cell-num">${safeInt(r.contract_year)}</td>
            <td>${htmlEsc(r.contract_status || "")}</td>
            <td class="explain">${htmlEsc(r.contract_info || "")}</td>
          </tr>
        `;
      })
      .join("");
    return `
      <div class="ccc-tableWrap"><table class="ccc-table"><thead><tr><th>Action</th><th>Player</th><th>Pos</th><th>Current Salary</th><th>Years Remaining</th><th>Status</th><th>Contract Info</th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="ccc-tableMeta">
        <div class="ccc-tableMetaInfo">Showing ${totalRows ? start + 1 : 0}-${Math.min(
      start + pageSize,
      totalRows
    )} of ${totalRows}</div>
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
  }

  function renderCommishModulePage() {
    const canCommish = !!state.canCommishMode;
    const season = normalizeSeasonValue(state.selectedSeason);
    const seasonRows = state.payload.eligibility.filter(
      (r) => normalizeSeasonValue(r.season) === season
    );
    const seasonSubmissionRows = state.payload.submissions.filter(
      (r) => normalizeSeasonValue(r.season) === season
    );
    const seasonRestructureRows = (state.restructureSubmissions || []).filter(
      (r) => normalizeSeasonValue(r.season) === season
    );
    const seasonTagRows = (state.tagTrackingRows || []).filter(
      (r) => normalizeSeasonValue(r.season) === season
    );
    const mergedSubmissionRows = seasonSubmissionRows.concat(seasonRestructureRows, seasonTagRows);
    const teams = buildTeamList(seasonRows, mergedSubmissionRows, state.detectedFranchiseId || "");
    const positions = buildPositionList(seasonRows, mergedSubmissionRows);
    const defaults = normalizeDefaultFilters(state.defaultFilters || {});
    const detectedTeamId = safeStr(state.detectedFranchiseId || "");
    const defaultTeamPref = defaults.teamId
      ? defaults.teamId
      : state.canCommishMode
      ? "__ALL__"
      : detectedTeamId;
    const themeVal = safeStr(state.theme || "auto").toLowerCase();

    const teamOptions = teams
      .map((t, idx) => {
        if (!t || !t.id) return "";
        const isSelected = defaultTeamPref ? defaultTeamPref === t.id : idx === 0;
        return `<option value="${htmlEsc(t.id)}"${isSelected ? " selected" : ""}>${htmlEsc(
          t.name || t.id
        )}</option>`;
      })
      .join("");
    const allSelected = defaultTeamPref === "__ALL__";
    const teamSelect = `
      <option value="__ALL__"${allSelected ? " selected" : ""}>All Teams</option>
      ${teamOptions}
    `;

    const posOptions = ["__ALL_POS__", ...positions]
      .map((p) => {
        const label = p === "__ALL_POS__" ? "All Positions" : p;
        const isSelected = defaults.position ? defaults.position === p : p === "__ALL_POS__";
        return `<option value="${htmlEsc(p)}"${isSelected ? " selected" : ""}>${htmlEsc(
          label
        )}</option>`;
      })
      .join("");

    const rowOptions = [25, 50, 100]
      .map((n) => {
        const isSelected = defaults.pageSize === n;
        return `<option value="${n}"${isSelected ? " selected" : ""}>${n}</option>`;
      })
      .join("");

    const adminPanel = `
      <div class="ccc-adminPanel ccc-adminPanel--hero" style="display:block;">
        <div class="ccc-adminTitle">Admin Controls</div>
        <div class="ccc-adminGrid">
          <button id="refreshBtn" class="ccc-btn" type="button" data-admin-action="refresh">Refresh (use if rosters are not refreshed)</button>
          <div class="ccc-field">
            Theme
            <select id="themeSelect" class="ccc-select" data-admin-theme="1">
              <option value="auto"${themeVal === "auto" ? " selected" : ""}>Auto</option>
              <option value="light"${themeVal === "light" ? " selected" : ""}>Light</option>
              <option value="dark"${themeVal === "dark" ? " selected" : ""}>Dark</option>
            </select>
          </div>
          <div class="ccc-field">
            Default Team
            <select class="ccc-select" data-admin-default="team">${teamSelect}</select>
          </div>
          <div class="ccc-field">
            Default Position
            <select class="ccc-select" data-admin-default="position">${posOptions}</select>
          </div>
          <div class="ccc-field">
            Default Rows
            <select class="ccc-select" data-admin-default="rows">${rowOptions}</select>
          </div>
          <button class="ccc-btn" type="button" data-admin-action="bug" disabled title="Coming soon">Report a Bug (coming soon)</button>
        </div>
      </div>
    `;

    const toggleAttrs = canCommish
      ? ""
      : "disabled title='Admin console is commissioner-only'";
    const consoleBlock = `
      <div class="ccc-adminConsoleCard">
        <div class="ccc-adminConsoleTitle">Admin Console</div>
        <div class="muted" style="margin-bottom:10px;">Manual contract update tool (commissioner-only).</div>
        <button type="button" class="ccc-pageBtn" data-commish-console-toggle="1" ${toggleAttrs}>
          ${state.commishConsoleOpen ? "Hide" : "Show"} Admin Console
        </button>
      </div>
    `;

    return `
      <div class="ccc-summaryPage">
        ${adminPanel}
        ${consoleBlock}
      </div>
    `;
  }

  function renderTagTable(rows, tabMode) {
    if (tabMode === "submitted") {
      return `<div class="ccc-tableWrap" style="padding:12px;">Tag submissions are coming next. Tracking is live now.</div>`;
    }

    if (!rows.length) {
      return `<div class="ccc-tableWrap" style="padding:12px;">No rows.</div>`;
    }

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
    const baseSeason = state.calendarBaseSeason || getBaseSeasonValue(state.selectedSeason);
    const nowRef = state.calendarNow || getEffectiveNow(baseSeason);
    const tagWindowOpen = state.commishMode || isTagActiveForSeason(baseSeason, nowRef);

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

    const ppgControls =
      tabMode === "eligible"
        ? `
      <div class="ccc-summaryControls">
        <span class="ccc-navTitle">PPG Rank Settings</span>
        <label class="ccc-check">
          <input type="checkbox" data-ppg-enabled="1" ${state.ppgMinGamesEnabled ? "checked" : ""} />
          PPG Min Games
        </label>
        <label class="ccc-field">
          Min
          <input type="number" class="ccc-input" data-ppg-min="1" min="1" max="18" value="${clampInt(
            state.ppgMinGames || 8,
            1,
            18
          )}" ${state.ppgMinGamesEnabled ? "" : "disabled"} />
        </label>
      </div>
    `
        : "";

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

    const body = pageRows
      .map((r) => {
        const season = normalizeSeasonValue(r.season || state.selectedSeason);
        const side = safeStr(r.tag_side || "OFFENSE");
        const limit = Math.max(1, safeInt(r.tag_limit_per_side || 1));
        const key = buildTagSelectionKey(season, r.franchise_id, side);
        const canTag = canManageTagForFranchise(r.franchise_id);
        const selected = state.tagSelections[key];
        const isSelected = !!selected && safeStr(selected.player_id) === safeStr(r.player_id);
        const lockEnforced = !state.commishMode;
        const isLocked = lockEnforced && !!selected && !isSelected && limit <= 1;
        const submission = state.tagSubmissions[key];
        const isSubmitted =
          !!submission && safeStr(submission.player_id) === safeStr(r.player_id);
        const tagClosed = !tagWindowOpen && !state.commishMode;
        const tagLabel = tagClosed
          ? isSubmitted
            ? "Submitted"
            : "Tag Closed"
          : isSelected
          ? "Selected"
          : isLocked
          ? "Locked"
          : "Tag";
        const tagBtnClass = `ccc-btn ccc-btn-tag${isSelected ? " is-selected" : ""}`;
        const submittedTag = isSubmitted
          ? `<div class="cell-sub">Submitted</div>`
          : ``;
        const tagDisabled = tagClosed || isLocked;
        const tagTitle = tagClosed
          ? "Tagging window is closed"
          : isLocked
          ? `Tag already used for ${side}`
          : "";
        const tagTitleEsc = tagTitle ? htmlEsc(tagTitle) : "";
        const tagBtn = canTag
          ? `
          <button
            type="button"
            class="${tagBtnClass}"
            data-tag-action="1"
            data-tag-side="${htmlEsc(side)}"
            data-tag-limit="${limit}"
            data-season="${htmlEsc(season)}"
            data-franchise-id="${htmlEsc(pad4(r.franchise_id))}"
            data-franchise-name="${htmlEsc(r.franchise_name || "")}"
            data-player-id="${htmlEsc(r.player_id)}"
            data-player-name="${htmlEsc(r.player_name)}"
            data-pos="${htmlEsc(posKeyFromRow(r))}"
            ${tagDisabled ? `disabled` : ``}
            ${tagTitleEsc ? `title="${tagTitleEsc}"` : ``}
          >${tagLabel}</button>
        `
          : `<span class="muted">—</span>`;
        const posKeyRaw = posKeyFromRow(r);
        const posKey = htmlEsc(posKeyRaw);
        const gamesPlayed = safeInt(r.games_played);
        const ppg = Number(r.points_per_game || 0);
        const ppgDisplay = gamesPlayed > 0 ? ppg.toFixed(1) : "—";
        const ppgRank = safeInt(r._ppg_rank || r.ppg_rank);
        const minGames = state.ppgMinGamesEnabled ? state.ppgMinGames : 0;
        let ppgRankCell = "";
        if (gamesPlayed <= 0) {
          ppgRankCell = `N/A<div class="cell-sub">no games played</div>`;
        } else if (state.ppgMinGamesEnabled && gamesPlayed < minGames) {
          ppgRankCell = `N/A<div class="cell-sub">min ${minGames} games</div>`;
        } else if (ppgRank > 0) {
          ppgRankCell = String(ppgRank);
        } else {
          ppgRankCell = "N/A";
        }
        const rowClass = buildRowClass(r, posKeyRaw);
        const rowStyle = buildTeamStyle(r);
        return `
          <tr class="${rowClass}"${rowStyle ? ` style="${rowStyle}"` : ""}>
            <td>${tagBtn}${submittedTag}</td>
            <td class="cell-num">${safeInt(r.tag_tier) || "—"}</td>
            <td class="cell-num">${safeInt(r.tag_bid || r.tag_salary).toLocaleString()}</td>
            <td>${htmlEsc(r.franchise_name || r.franchise_id)}</td>
            <td>${htmlEsc(posKeyFromRow(r))}</td>
            <td class="playerCell">${htmlEsc(r.player_name)}</td>
            <td class="cell-num">${safeInt(r.aav).toLocaleString()}</td>
            <td class="cell-num">${Number(r.points_total || 0).toFixed(1)}</td>
            <td class="cell-num">${safeInt(r.pos_rank) || "—"}</td>
            <td class="cell-num">${ppgDisplay}</td>
            <td class="cell-num">${ppgRankCell}</td>
            <td class="muted">${htmlEsc(r.tag_formula || "")}</td>
          </tr>
        `;
      })
      .join("");

    return `
      ${ppgControls}
      ${pager}
      <div class="ccc-tableWrap ccc-density-${htmlEsc(state.tableDensity || "regular")}" data-table="${tabMode}">
        <table class="ccc-table">
          <thead>
            <tr>
              <th style="min-width:120px;">Tag</th>
              ${sortTh("tagTier", "Tier", "", "is-num")}
              ${sortTh("tagBid", "Tag $", "min-width:120px;", "is-num")}
              ${sortTh("team", "Tm")}
              ${sortTh("pos", "Pos")}
              ${sortTh("player", "Player")}
              ${sortTh("aav", "AAV", "", "is-num")}
              ${sortTh("points", "Pts", "", "is-num")}
              ${sortTh("tagRank", "Pos Rk", "", "is-num")}
              ${sortTh("ppg", "PPG", "", "is-num")}
              ${sortTh("ppgRank", "PPG Rk", "", "is-num")}
              ${sortTh("tagFormula", "Calc", "min-width:160px;")}
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${pager}
    `;
  }

  // ======================================================
  // 8) STATE + TEAM LIST
  // ======================================================
  const initialPpgSettings = loadPpgSettings();
  const initialThemeSetting = loadThemeSetting();
  const initialHighlightSettings = loadHighlightSettings();
  const initialHighlightDefault = {
    enabled: initialHighlightSettings.enabled,
    mode: normalizeHighlightMode(initialHighlightSettings.mode),
  };
  const initialHighlightByModule = initialHighlightSettings.byModule || {};
  const initialDefaultFilters = loadDefaultFilters();
  const initialAsOfSeasonOverride = loadAsOfSeasonOverride();
  const state = {
    payload: { eligibility: [], usage: [], submissions: [], meta: {} },
    restructureSubmissions: [],
    tagTrackingRows: [],
    tagTrackingMeta: {},
    isAdmin: false,
    canCommishMode: false,
    commishMode: false,
    commishConsoleOpen: false,
    adminReason: "",
    activeModule: "",
    selectedSeason: "",
    selectedTeam: "",
    selectedPosition: "__ALL_POS__",
    showAllTeams: false,
    pageSize: initialDefaultFilters.pageSize,
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
    availabilitySeason: "",
    calendarBaseSeason: "",
    calendarContractSeason: "",
    calendarNow: null,
    teamColorMap: {},
    localOverrides: loadLocalOverrides(),
    tagSelections: loadTagSelections(),
    tagSubmissions: loadTagSubmissions(),
    extensionSelections: loadExtensionSelections(),
    extensionSubmissions: loadExtensionSubmissions(),
    tagSummaryView: "pos",
    tagSummarySide: "ALL",
    tagCalcOpen: false,
    tagSubmissionSeason: "",
    ppgMinGames: initialPpgSettings.minGames,
    ppgMinGamesEnabled: initialPpgSettings.enabled,
    theme: initialThemeSetting,
    defaultFilters: initialDefaultFilters,
    highlightDefault: initialHighlightDefault,
    highlightByModule: initialHighlightByModule,
    rowHighlightEnabled: initialHighlightDefault.enabled,
    rowHighlightMode: initialHighlightDefault.mode,
    asOfSeasonOverride: initialAsOfSeasonOverride,
    asOfDraft: null,
    adminDebug: null,
    mymDeadlineBySeason: {},
    mymDeadlineFetch: {},
    commishViewMode: "A",
    lastOwnerTeam: "",
    mymSubmissionSeason: "",
    filtersByModule: {},
  };

  function currentFilterSnapshot() {
    return {
      selectedTeam: safeStr(state.selectedTeam || ""),
      showAllTeams: !!state.showAllTeams,
      selectedPosition: safeStr(state.selectedPosition || "__ALL_POS__"),
      search: safeStr(state.search || ""),
      pageSize: clampInt(state.pageSize || 50, 10, 500),
    };
  }

  function saveFiltersForModule(moduleKey) {
    const key = safeStr(moduleKey || "").toLowerCase();
    if (!key) return;
    if (!state.filtersByModule || typeof state.filtersByModule !== "object") {
      state.filtersByModule = {};
    }
    state.filtersByModule[key] = currentFilterSnapshot();
  }

  function applyFiltersForModule(moduleKey) {
    const key = safeStr(moduleKey || "").toLowerCase();
    const defaults = normalizeDefaultFilters(state.defaultFilters || {});
    const saved =
      key && state.filtersByModule && state.filtersByModule[key]
        ? state.filtersByModule[key]
        : null;

    const defaultTeam = state.commishMode
      ? "__ALL__"
      : safeStr(defaults.teamId || state.detectedFranchiseId || "");
    const selectedTeam = safeStr(saved && saved.selectedTeam ? saved.selectedTeam : defaultTeam);
    state.selectedTeam = selectedTeam || "__ALL__";
    state.showAllTeams = state.selectedTeam === "__ALL__";
    state.selectedPosition = safeStr(
      saved && saved.selectedPosition ? saved.selectedPosition : defaults.position || "__ALL_POS__"
    );
    state.search = safeStr(saved && saved.search ? saved.search : "");
    const rawSize =
      saved && saved.pageSize !== undefined ? safeInt(saved.pageSize) : safeInt(defaults.pageSize);
    state.pageSize = [25, 50, 100].includes(rawSize) ? rawSize : 50;
  }

  function switchModule(nextModule) {
    const prevModule = safeStr(state.activeModule || "").toLowerCase();
    if (prevModule) saveFiltersForModule(prevModule);
    rememberHighlightForModule(state.activeModule || "default");
    state.activeModule = state.activeModule === nextModule ? "" : nextModule;
    setHighlightForModule(state.activeModule || "default");
    applyFiltersForModule(state.activeModule || "default");
  }

  function normalizeSeasonValue(v) {
    const s = safeStr(v);
    const m = s.match(/\d{4}/);
    return m ? m[0] : s;
  }

  function buildTagSelectionKey(season, franchiseId, side) {
    const league = safeStr(getLeagueId() || DEFAULT_LEAGUE_ID);
    const s = normalizeSeasonValue(season) || DEFAULT_YEAR;
    const fid = pad4(franchiseId);
    const tagSide = safeStr(side || "OFFENSE");
    return `${league}|${s}|${fid}|${tagSide}`;
  }

  function getTagSelectionsForTeam(season, franchiseId) {
    const league = safeStr(getLeagueId() || DEFAULT_LEAGUE_ID);
    const s = normalizeSeasonValue(season) || DEFAULT_YEAR;
    const fid = pad4(franchiseId);
    const out = [];
    Object.entries(state.tagSelections || {}).forEach(([key, sel]) => {
      if (!sel) return;
      if (safeStr(sel.league_id || league) !== league) return;
      if (normalizeSeasonValue(sel.season) !== s) return;
      if (pad4(sel.franchise_id) !== fid) return;
      out.push({ key, ...sel });
    });
    return out;
  }

  function buildExtensionSelectionKey(season, franchiseId, playerId) {
    const league = safeStr(getLeagueId() || DEFAULT_LEAGUE_ID);
    const s = normalizeSeasonValue(season) || DEFAULT_YEAR;
    const fid = pad4(franchiseId);
    const pid = safeStr(playerId);
    return `${league}|${s}|${fid}|${pid}`;
  }

  function isExpiredRookieRow(row) {
    const text = `${safeStr(row.contract_status)} ${safeStr(row.contract_info)} ${safeStr(
      row.mym_acq_type
    )}`.toLowerCase();
    return text.includes("expired rookie");
  }

  function canExtendRow(row) {
    if (!row) return false;
    const years = safeInt(row.contract_year);
    if (!(years === 1 || isExpiredRookieRow(row))) return false;
    const status = safeStr(row.contract_status).toLowerCase();
    if (status.includes("tag")) return false;
    return true;
  }

  function normalizeNickToken(v) {
    return safeStr(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function getOwnerExtensionNickname(franchiseId) {
    return safeStr(EXT_PRIMARY_NICK_BY_FRANCHISE[pad4(franchiseId)] || "");
  }

  function parseExtensionOwnerFromContractInfo(contractInfo) {
    const normalized = normalizeNickToken(contractInfo);
    if (!normalized) return "";
    const entries = Object.entries(EXT_OWNER_BY_NICKNAME);
    for (let i = 0; i < entries.length; i++) {
      const [nick, fid] = entries[i];
      if (!nick) continue;
      if (normalized.includes(nick)) return pad4(fid);
    }
    return "";
  }

  function isExtendedByCurrentOwner(row) {
    if (!row) return false;
    const owner = parseExtensionOwnerFromContractInfo(row.contract_info);
    if (!owner) return false;
    return owner === pad4(row.franchise_id);
  }

  function getExtensionRate(posKey, season, yearsToAdd) {
    const s = normalizeSeasonValue(season || state.selectedSeason || DEFAULT_YEAR);
    const y = safeInt(yearsToAdd) >= 2 ? 2 : 1;
    const seasonMap =
      EXTENSION_RATES_BY_SEASON[s] ||
      EXTENSION_RATES_BY_SEASON[String(safeInt(s) - 1)] ||
      EXTENSION_RATES_BY_SEASON["2025"];
    const pos = posKey === "K" ? "PK" : posKey;
    const rec = seasonMap && seasonMap[pos] ? seasonMap[pos] : seasonMap.DB;
    return safeInt(rec && rec[y]);
  }

  function isNonRookieContract(row) {
    if (!row) return false;
    if (rookieLike(row.contract_status)) return false;
    return !safeStr(row.contract_status).toLowerCase().includes("rookie");
  }

  function countTeamThreeYearNonRookieContracts(franchiseId, season) {
    const fid = pad4(franchiseId);
    const s = normalizeSeasonValue(season || state.selectedSeason);
    return (state.payload.eligibility || []).filter(
      (r) =>
        pad4(r.franchise_id) === fid &&
        normalizeSeasonValue(r.season) === s &&
        isNonRookieContract(r) &&
        safeInt(r.contract_year) === 3
    ).length;
  }

  function isLoadedContractInfo(contractInfo, years, salary) {
    const y = Math.max(1, safeInt(years));
    if (y <= 1) return false;
    const p = parseContractAmounts(contractInfo, y, salary);
    if (y === 2) return p.y1 !== p.y2;
    return p.y1 !== p.y2 || p.y2 !== p.y3;
  }

  function countTeamLoadedContracts(franchiseId, season) {
    const fid = pad4(franchiseId);
    const s = normalizeSeasonValue(season || state.selectedSeason);
    return (state.payload.eligibility || []).filter(
      (r) =>
        pad4(r.franchise_id) === fid &&
        normalizeSeasonValue(r.season) === s &&
        isLoadedContractInfo(r.contract_info, safeInt(r.contract_year), safeInt(r.salary))
    ).length;
  }

  function buildSeasonList(eligibilityRows, submissionRows, restructureRows, tagRows) {
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
    (tagRows || []).forEach((r) => {
      const s = normalizeSeasonValue(r.season);
      if (s) set.add(s);
    });
    return Array.from(set).sort((a, b) => safeInt(b) - safeInt(a));
  }

  function buildSubmissionSeasonList(rows) {
    const set = new Set();
    (rows || []).forEach((r) => {
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

  function populateAsOfSeasonSelect(seasons, selectedOverride) {
    const sel = $("#asOfSeasonSelect");
    if (!sel) return;
    sel.innerHTML = "";
    const base = Array.isArray(seasons) ? seasons.slice() : [];
    let maxSeason = 0;
    base.forEach((s) => {
      const n = safeInt(s);
      if (n > maxSeason) maxSeason = n;
    });
    if (maxSeason) base.push(String(maxSeason + 1));
    const list = Array.from(new Set(base.filter(Boolean))).sort((a, b) => safeInt(b) - safeInt(a));

    const optDefault = document.createElement("option");
    optDefault.value = "";
    optDefault.textContent = "Use Selected";
    sel.appendChild(optDefault);

    list.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      sel.appendChild(opt);
    });

    sel.value = safeStr(selectedOverride || "");
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
    const list = Array.isArray(teams) ? teams.slice() : [];
    const owner = list[0] || null;
    let hasSelected = false;
    const addOpt = (value, label, selected) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      opt.selected = !!selected;
      if (selected) hasSelected = true;
      sel.appendChild(opt);
    };

    if (owner && owner.id) addOpt(owner.id, owner.name || owner.id, owner.id === selectedId);
    addOpt("__ALL__", "All Teams", selectedId === "__ALL__");

    const rest = owner ? list.slice(1) : list;
    rest.forEach((t) => {
      if (!t || !t.id) return;
      addOpt(t.id, t.name || t.id, t.id === selectedId);
    });

    if (!hasSelected && sel.options.length) {
      sel.value = owner && owner.id ? owner.id : "__ALL__";
    }
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

  function getContractDeadlineDate(season) {
    const ymd = resolveMymDeadlineYmd(season);
    if (!ymd) return null;
    return parseYMDDate(ymd);
  }

  function getTagSeasonWindow(baseSeason) {
    const info = getTagDeadlineInfo(baseSeason);
    if (!info || !info.tagDeadline) return null;
    const start = new Date(info.year, 1, 1);
    const end = endOfDay(info.tagDeadline);
    if (!start || !end) return null;
    return { start, end, deadline: info.tagDeadline, year: info.year };
  }

  function buildMflScheduleUrl(season) {
    const s = normalizeSeasonValue(season);
    if (!s) return "";
    return `${MFL_API_BASE}/${s}/export?TYPE=nflSchedule&W=ALL&JSON=1`;
  }

  function parseKickoffToDate(val) {
    if (val === null || val === undefined) return null;
    const raw = String(val).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (!isNaN(n)) {
        if (raw.length >= 13) return new Date(n);
        if (raw.length >= 10) return new Date(n * 1000);
      }
    }
    return parseDate(raw);
  }

  function collectKickoffEntries(node, out) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((item) => collectKickoffEntries(item, out));
      return;
    }
    if (typeof node !== "object") return;

    if (node.kickoff !== undefined) {
      const weekVal = safeInt(node.week || node.week_id || node.week_no || "");
      out.push({ week: weekVal, kickoff: node.kickoff });
    }

    Object.keys(node).forEach((k) => collectKickoffEntries(node[k], out));
  }

  function extractWeek1Kickoff(scheduleData) {
    const out = [];
    collectKickoffEntries(scheduleData, out);
    if (!out.length) return null;
    const week1 = out.filter((x) => x && x.week === 1);
    const pool = week1.length ? week1 : out;
    const dates = pool
      .map((x) => parseKickoffToDate(x.kickoff))
      .filter((d) => d && !isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    return dates[0] || null;
  }

  function computePriorSunday(kickoffDate) {
    if (!kickoffDate || isNaN(kickoffDate.getTime())) return null;
    const base = new Date(
      kickoffDate.getFullYear(),
      kickoffDate.getMonth(),
      kickoffDate.getDate(),
      12,
      0,
      0
    );
    const day = base.getDay();
    const daysBack = day === 0 ? 7 : day;
    return addDays(base, -daysBack);
  }

  function resolveMymDeadlineYmd(season) {
    const s = normalizeSeasonValue(season);
    if (!s) return "";
    const evt = MYM_EVENTS_BY_SEASON[s] || {};
    const staticDeadline = safeStr(evt.contract_deadline);
    const dynamic = state && state.mymDeadlineBySeason ? state.mymDeadlineBySeason[s] : null;
    const dynamicYmd = dynamic && dynamic.deadlineYmd ? dynamic.deadlineYmd : "";
    if (!dynamicYmd && state && state.mymDeadlineFetch) {
      const fetching = !!state.mymDeadlineFetch[s];
      const seasonNum = safeInt(s);
      const currentYear = new Date().getFullYear();
      if (!fetching && (seasonNum >= currentYear || !staticDeadline)) {
        requestMymDeadlineFromSchedule(s);
      }
    }
    return dynamicYmd || staticDeadline;
  }

  function resolveWeek1KickoffYmd(season) {
    const s = normalizeSeasonValue(season);
    if (!s) return "";
    const dynamic = state && state.mymDeadlineBySeason ? state.mymDeadlineBySeason[s] : null;
    const kickoffYmd = dynamic && dynamic.kickoffYmd ? dynamic.kickoffYmd : "";
    if (!kickoffYmd && state && state.mymDeadlineFetch && !state.mymDeadlineFetch[s]) {
      requestMymDeadlineFromSchedule(s);
    }
    return kickoffYmd;
  }

  function getWeek5KickoffDate(season) {
    const kickoffYmd = resolveWeek1KickoffYmd(season);
    const kickoff = parseYMDDate(kickoffYmd);
    if (kickoff) return addDays(kickoff, 28);
    const contractDeadline = getContractDeadlineDate(season);
    if (!contractDeadline) return null;
    return addDays(contractDeadline, 32);
  }

  function getExtensionDeadlineDateForRow(row, season) {
    const s = normalizeSeasonValue(season || state.selectedSeason);
    const contractSeason = getContractSeasonValue(s);
    const contractDeadline = getContractDeadlineDate(contractSeason);
    const acqDate = parseDate(row && row.acquired_date);
    const acqType = safeStr(row && row.mym_acq_type).toUpperCase();
    const expiredRookie = isExpiredRookieRow(row);
    const rookieContract = rookieLike(row && row.contract_status);
    const rookieLock = parseDate(row && row.mym_deadline);
    if (expiredRookie) {
      return rookieLock || contractDeadline;
    }
    if (rookieContract) {
      return rookieLock || contractDeadline;
    }
    const acquiredLater =
      !!acqDate &&
      ((contractDeadline && acqDate.getTime() > endOfDay(contractDeadline).getTime()) ||
        /AUCTION|TRADE|WAIVER|FREE/.test(acqType));
    if (acquiredLater) {
      const acqPlus4 = addDays(acqDate, 28);
      const week5 = getWeek5KickoffDate(contractSeason);
      if (!week5) return acqPlus4;
      return acqPlus4.getTime() >= week5.getTime() ? acqPlus4 : week5;
    }
    return contractDeadline;
  }

  async function requestMymDeadlineFromSchedule(season) {
    const s = normalizeSeasonValue(season);
    if (!s || !state) return;
    if (!state.mymDeadlineBySeason) state.mymDeadlineBySeason = {};
    if (!state.mymDeadlineFetch) state.mymDeadlineFetch = {};
    if (state.mymDeadlineFetch[s]) return;
    state.mymDeadlineFetch[s] = true;

    try {
      const url = buildMflScheduleUrl(s);
      if (!url) return;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`MFL schedule HTTP ${res.status}`);
      const data = await res.json();
      const kickoff = extractWeek1Kickoff(data);
      const deadlineDate = computePriorSunday(kickoff);
      const deadlineYmd = deadlineDate ? fmtYMDDate(deadlineDate) : "";
      const kickoffYmd = kickoff ? fmtYMDDate(kickoff) : "";
      state.mymDeadlineBySeason[s] = { deadlineYmd, kickoffYmd };
    } catch (e) {
      state.mymDeadlineBySeason[s] = {
        deadlineYmd: "",
        kickoffYmd: "",
        error: e && e.message ? e.message : String(e),
      };
    } finally {
      state.mymDeadlineFetch[s] = true;
      render();
    }
  }

  function getMymSeasonWindow(season) {
    const contractSeason = getContractSeasonValue(season);
    if (!contractSeason) return null;
    const deadlineYmd = resolveMymDeadlineYmd(contractSeason);
    if (!deadlineYmd) return null;
    const deadline = getContractDeadlineDate(contractSeason);
    if (!deadline) return null;
    const start = addDays(endOfDay(deadline), 1);
    const end = endOfDay(new Date(safeInt(contractSeason) + 1, 0, 31));
    if (!start || !end) return null;
    return { season: contractSeason, start, end, deadlineYmd };
  }

  function isMymActiveForSeason(season, nowDate) {
    const win = getMymSeasonWindow(season);
    if (!win) return false;
    const now = nowDate && !isNaN(nowDate.getTime()) ? nowDate : new Date();
    return now.getTime() >= win.start.getTime() && now.getTime() <= win.end.getTime();
  }

  function getRestructureSeasonWindow(season) {
    const baseSeason = getBaseSeasonValue(season);
    const contractSeason = getContractSeasonValue(baseSeason);
    if (!baseSeason || !contractSeason) return null;
    const tagWindow = getTagSeasonWindow(baseSeason);
    if (!tagWindow) return null;
    const start = new Date(tagWindow.year, 1, 1);
    const endYmd = resolveMymDeadlineYmd(contractSeason);
    if (!endYmd) return null;
    const end = getContractDeadlineDate(contractSeason);
    if (!start || !end) return null;
    return { season: contractSeason, start, end, endYmd };
  }

  function isRestructureActiveForSeason(season, nowDate) {
    const win = getRestructureSeasonWindow(season);
    if (!win) return false;
    const now = nowDate && !isNaN(nowDate.getTime()) ? nowDate : new Date();
    return now.getTime() >= win.start.getTime() && now.getTime() <= win.end.getTime();
  }

  function getAuctionSeasonWindow(season) {
    const baseSeason = getBaseSeasonValue(season);
    const contractSeason = getContractSeasonValue(baseSeason);
    const info = getTagDeadlineInfo(baseSeason);
    if (!info || !info.tagDeadline) return null;
    const contractEnd = getContractDeadlineDate(contractSeason);
    if (!contractEnd) return null;
    const start = addDays(endOfDay(info.tagDeadline), 1);
    const end = endOfDay(contractEnd);
    return { season: contractSeason, start, end };
  }

  function isAuctionActiveForSeason(season, nowDate) {
    const win = getAuctionSeasonWindow(season);
    if (!win) return false;
    const now = nowDate && !isNaN(nowDate.getTime()) ? nowDate : new Date();
    return now.getTime() >= win.start.getTime() && now.getTime() <= win.end.getTime();
  }

  function isTagActiveForSeason(season, nowDate) {
    const win = getTagSeasonWindow(season);
    if (!win) return false;
    const now = nowDate && !isNaN(nowDate.getTime()) ? nowDate : new Date();
    return now.getTime() >= win.start.getTime() && now.getTime() <= win.end.getTime();
  }

  function updateModuleStatusChips() {
    const baseSeason = getBaseSeasonValue(normalizeSeasonValue(state.selectedSeason));
    const nowRef = getEffectiveNow(baseSeason);
    const tagActive = state.commishMode || isTagActiveForSeason(baseSeason, nowRef);
    const mymActive = isMymActiveForSeason(baseSeason, nowRef);
    const restructureActive = state.commishMode || isRestructureActiveForSeason(baseSeason, nowRef);
    const auctionActive = isAuctionActiveForSeason(baseSeason, nowRef);
    const tagChip = $("#moduleTagsChip");
    const mymChip = $("#moduleMymChip");
    const extensionsChip = $("#moduleExtensionsChip");
    const commishChip = $("#moduleCommishChip");

    if (tagChip) {
      tagChip.classList.remove("disabled");
      tagChip.classList.toggle("primary", tagActive);
    }
    if (mymChip) {
      mymChip.classList.remove("disabled");
      mymChip.classList.toggle("primary", mymActive);
    }
    if (extensionsChip) {
      extensionsChip.classList.remove("disabled");
      extensionsChip.classList.add("primary");
    }
    if (commishChip) {
      commishChip.style.display = "";
    }
    const setModuleState = (id, active, lockForOwners) => {
      const el = $(id);
      if (!el) return;
      if (lockForOwners && !state.commishMode) {
        el.classList.add("disabled");
        el.classList.remove("primary");
        el.disabled = true;
        return;
      }
      el.disabled = false;
      el.classList.toggle("disabled", !active);
      el.classList.toggle("primary", !!active);
    };

    // Placeholder scheduling statuses for upcoming modules.
    setModuleState("#moduleRestructuresChip", restructureActive, true);
    setModuleState("#moduleAuctionChip", auctionActive, true);
  }

  function renderEligibleAvailabilityNotice(season) {
    if (state.activeModule === "tag") return "";

    if (state.activeModule === "restructure") {
      if (state.commishMode) return "";
      const baseSeason = getBaseSeasonValue(season);
      const nowRef = getEffectiveNow(baseSeason);
      if (isRestructureActiveForSeason(baseSeason, nowRef)) return "";
      const win = getRestructureSeasonWindow(baseSeason);
      const endTxt =
        win ? win.endYmd : resolveMymDeadlineYmd(getContractSeasonValue(baseSeason)) || "TBD";
      return `<div class="ccc-eligWarn">Restructures Available Feb 1 Through ${htmlEsc(
        endTxt
      )}</div>`;
    }

    const base = getBaseSeasonValue(normalizeSeasonValue(season));
    if (!base) return "";
    const nowRef = getEffectiveNow(base);
    if (isMymActiveForSeason(base, nowRef)) return "";
    const win = getMymSeasonWindow(base);
    const deadlineTxt =
      win ? win.deadlineYmd : resolveMymDeadlineYmd(getContractSeasonValue(base)) || "TBD";
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
    const costTab = $(`.ccc-tab[data-tab="costcalc"]`);
    const eligibleTab = $(`.ccc-tab[data-tab="eligible"]`);
    const submittedTab = $(`.ccc-tab[data-tab="submitted"]`);
    if (summaryTab) summaryTab.textContent = "Summary";
    if (state.activeModule === "tag") {
      if (costTab) {
        costTab.style.display = "";
        costTab.textContent = "Cost Calc";
      }
      if (eligibleTab) eligibleTab.textContent = "Player Tagging";
      if (submittedTab) submittedTab.textContent = "Finalized Submissions";
    } else {
      if (costTab) costTab.style.display = "none";
      if (eligibleTab)
        eligibleTab.textContent =
          state.activeModule === "extensions" ? "Extensions" : "Eligible";
      if (submittedTab)
        submittedTab.textContent =
          state.activeModule === "restructure"
            ? "Restructure - Submitted"
            : state.activeModule === "extensions"
            ? "Extensions"
            : "MYM - Submitted";
    }
  }

  function syncModuleChipSelection() {
    const tagChip = $("#moduleTagsChip");
    const mymChip = $("#moduleMymChip");
    const restructureChip = $("#moduleRestructuresChip");
    const extensionsChip = $("#moduleExtensionsChip");
    const commishChip = $("#moduleCommishChip");
    if (tagChip) tagChip.classList.toggle("is-selected", state.activeModule === "tag");
    if (mymChip) mymChip.classList.toggle("is-selected", state.activeModule === "mym");
    if (restructureChip) {
      restructureChip.classList.toggle("is-selected", state.activeModule === "restructure");
    }
    if (extensionsChip) {
      extensionsChip.classList.toggle("is-selected", state.activeModule === "extensions");
    }
    if (commishChip) {
      commishChip.classList.toggle("is-selected", state.activeModule === "commish");
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
    const toggleBtn = $("#commishConsoleBtn");
    if (!consoleEl || !playerSelect) return;

    const canShow =
      !!state.canCommishMode && !!state.commishMode && state.activeModule === "commish";
    if (toggleBtn) {
      toggleBtn.style.display = canShow ? "" : "none";
      toggleBtn.textContent = state.commishConsoleOpen ? "Hide Admin Console" : "Admin Console";
    }

    const isVisible = canShow && !!state.commishConsoleOpen;
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
    const cccMain = $("#cccMain");
    const cccTabs = $("#cccTabs");
    const cccMeta = $("#cccMeta");
    const summary = $("#summary");
    const tabSummary = $("#tabSummary");
    const tabCostCalc = $("#tabCostCalc");
    const tabEligible = $("#tabEligible");
    const tabIneligible = $("#tabIneligible");
    const tabSubmitted = $("#tabSubmitted");

    if (cccError) cccError.textContent = "";

    if (!state.activeModule) {
      if (summary) summary.innerHTML = "";
      if (tabSummary) tabSummary.innerHTML = "";
      if (tabCostCalc) tabCostCalc.innerHTML = "";
      if (tabEligible) tabEligible.innerHTML = "";
      if (tabIneligible) tabIneligible.innerHTML = "";
      if (tabSubmitted) tabSubmitted.innerHTML = "";
      if (cccTabs) cccTabs.style.display = "none";
      if (cccMain) cccMain.style.display = "none";
      syncModuleChipSelection();
      updateModuleStatusChips();
      return;
    }

    if (cccTabs) cccTabs.style.display = "";
    if (cccMain) cccMain.style.display = "";
    const teamFilterWrap = $("#teamFilterWrap");
    if (teamFilterWrap) teamFilterWrap.style.display = state.activeModule === "commish" ? "none" : "";
    const moduleFilters = $("#moduleFilters");
    if (moduleFilters) moduleFilters.style.display = state.activeModule === "commish" ? "none" : "";


    const asOfDate =
      state.commishMode && state.asOfOverrideActive && state.asOfDate ? state.asOfDate : null;
    applyEffectiveEligibility(eligibility, asOfDate);

    const searchLower = safeStr(state.search).trim().toLowerCase();
    const season = normalizeSeasonValue(state.selectedSeason);
    const baseSeason = getBaseSeasonValue(season);
    const contractSeason = getContractSeasonValue(baseSeason);
    const nowRef = getEffectiveNow(baseSeason);
    state.availabilitySeason = contractSeason;
    state.calendarBaseSeason = baseSeason;
    state.calendarContractSeason = contractSeason;
    state.calendarNow = nowRef;
    if (state.commishMode && !safeStr(state.selectedTeam)) {
      state.selectedTeam = "__ALL__";
      state.showAllTeams = true;
    }
    const showAllTeams = !!state.showAllTeams;
    const selectedPosition = safeStr(state.selectedPosition || "__ALL_POS__");
    const selectedTeamId = pad4(state.selectedTeam);
    const teamSelectEl = $("#teamSelect");
    if (teamSelectEl) {
      const teamValue = showAllTeams ? "__ALL__" : safeStr(state.selectedTeam || "");
      if (teamValue && teamSelectEl.value !== teamValue) teamSelectEl.value = teamValue;
    }
    const positionSelectEl = $("#positionSelect");
    if (positionSelectEl && positionSelectEl.value !== selectedPosition) {
      positionSelectEl.value = selectedPosition;
    }
    const searchBoxEl = $("#searchBox");
    if (searchBoxEl && searchBoxEl.value !== safeStr(state.search || "")) {
      searchBoxEl.value = safeStr(state.search || "");
    }

    const seasonEligibility = eligibility.filter(
      (r) => !season || normalizeSeasonValue(r.season) === season
    );
    const allMymSubmissions = buildSubmittedRows(eligibility, submissions, meta);
    const seasonMymSubmissions = allMymSubmissions.filter(
      (r) => !season || normalizeSeasonValue(r.season) === season
    );
    const seasonRestructureSubmissions = (state.restructureSubmissions || [])
      .map((r) => normalizeSubmissionRow(r))
      .filter((r) => !season || normalizeSeasonValue(r.season) === season);
    const seasonTagTracking = (state.tagTrackingRows || []).filter(
      (r) => !season || normalizeSeasonValue(r.season) === season
    );
    const mymSubmissionSeasons = buildSubmissionSeasonList(allMymSubmissions);
    if (state.activeModule === "mym") {
      if (
        !state.mymSubmissionSeason ||
        (state.mymSubmissionSeason && !mymSubmissionSeasons.includes(state.mymSubmissionSeason))
      ) {
        state.mymSubmissionSeason = mymSubmissionSeasons[0] || "";
      }
    }
    const mymSubmissionSeason = state.mymSubmissionSeason;
    const mymSubmissionRows = mymSubmissionSeason
      ? allMymSubmissions.filter((r) => normalizeSeasonValue(r.season) === mymSubmissionSeason)
      : allMymSubmissions.slice();


    state.teamColorMap = buildTeamColorMap(
      seasonEligibility,
      seasonMymSubmissions.concat(seasonRestructureSubmissions),
      seasonTagTracking
    );

    const teamFilteredEligibility = showAllTeams
      ? seasonEligibility
      : seasonEligibility.filter((r) => pad4(r.franchise_id) === selectedTeamId);

    const teamFilteredMymSubmissions = showAllTeams
      ? seasonMymSubmissions
      : seasonMymSubmissions.filter((r) => pad4(r.franchise_id) === selectedTeamId);
    const teamFilteredRestructureSubmissions = showAllTeams
      ? seasonRestructureSubmissions
      : seasonRestructureSubmissions.filter((r) => pad4(r.franchise_id) === selectedTeamId);
    const teamFilteredMymSubmissionsForTab = showAllTeams
      ? mymSubmissionRows
      : mymSubmissionRows.filter((r) => pad4(r.franchise_id) === selectedTeamId);
    const teamFilteredTagTracking = showAllTeams
      ? seasonTagTracking
      : seasonTagTracking.filter((r) => pad4(r.franchise_id) === selectedTeamId);

    const positionFilteredEligibility =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredEligibility
        : teamFilteredEligibility.filter((r) => posKeyFromRow(r) === selectedPosition);
    const positionFilteredMymSubmissions =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredMymSubmissions
        : teamFilteredMymSubmissions.filter((r) => posKeyFromRow(r) === selectedPosition);
    const positionFilteredMymSubmissionsForTab =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredMymSubmissionsForTab
        : teamFilteredMymSubmissionsForTab.filter((r) => posKeyFromRow(r) === selectedPosition);
    const positionFilteredRestructureSubmissions =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredRestructureSubmissions
        : teamFilteredRestructureSubmissions.filter((r) => posKeyFromRow(r) === selectedPosition);
    const positionFilteredTagTracking =
      selectedPosition === "__ALL_POS__"
        ? teamFilteredTagTracking
        : teamFilteredTagTracking.filter((r) => posKeyFromRow(r) === selectedPosition);

    const scopedEligibility = searchLower
      ? positionFilteredEligibility.filter((r) =>
          safeStr(r.player_name).toLowerCase().includes(searchLower)
        )
      : positionFilteredEligibility.slice();
    const moduleSubmittedBase =
      state.activeModule === "restructure"
        ? positionFilteredRestructureSubmissions
        : positionFilteredMymSubmissions;
    const moduleSubmittedForTab =
      state.activeModule === "mym" && state.activeTab === "submitted"
        ? teamFilteredMymSubmissionsForTab
        : state.activeModule === "mym"
        ? positionFilteredMymSubmissionsForTab
        : moduleSubmittedBase;
    const scopedTagTracking = searchLower
      ? positionFilteredTagTracking.filter((r) =>
          safeStr(r.player_name).toLowerCase().includes(searchLower)
        )
      : positionFilteredTagTracking.slice();

    const built = meta && meta.generated_at ? safeStr(meta.generated_at) : "";
    const minSeason = meta && meta.min_season ? safeStr(meta.min_season) : "";

    if (cccMeta) {
      let metaText =
        `Module: ${
          state.activeModule === "restructure"
            ? "Restructure"
            : state.activeModule === "tag"
            ? "Tags"
            : state.activeModule === "extensions"
            ? "Extensions"
            : state.activeModule === "commish"
            ? "Admin"
            : "MYM"
        }` +
        (built ? ` | built: ${built}` : "") +
        (minSeason ? ` | min season: ${minSeason}` : "") +
        (state.commishMode && state.adminReason ? ` | ${state.adminReason}` : "");
      if (state.commishMode && state.asOfOverrideActive && state.asOfDate) {
        metaText += ` | as-of: ${fmtLocalYMDHM(state.asOfDate)}`;
      }
      if (state.commishMode && state.asOfSeasonOverride) {
        metaText += ` | as-of season: ${state.asOfSeasonOverride}`;
      }
      if (state.activeModule === "tag") {
        const scoringWeeks =
          (state.tagTrackingRows[0] && safeStr(state.tagTrackingRows[0].scoring_weeks_used)) || "";
        if (scoringWeeks) metaText += ` | scoring weeks: ${scoringWeeks}`;
      }
      if (isAdminDebugEnabled() && state.adminDebug) {
        const d = state.adminDebug;
        metaText +=
          ` | dbg can:${d.canCommish ? 1 : 0}` +
          ` workerOk:${d.workerOk ? 1 : 0}` +
          ` workerAdmin:${d.workerIsAdmin ? 1 : 0}` +
          ` session:${d.sessionMatch ? 1 : 0}` +
          ` fid:${htmlEsc(d.currentFranchiseId || "-")}` +
          ` commishFid:${htmlEsc(d.commishFranchiseId || "-")}`;
      }
      cccMeta.textContent = metaText;
    }

    if (state.activeModule === "tag") {
      const tagEligibleRows = scopedTagTracking.filter((r) => safeInt(r.is_tag_eligible) === 1);
      const tagEligibleAll = (seasonTagTracking || []).filter(
        (r) => safeInt(r.is_tag_eligible) === 1
      );
      const ppgMin = clampInt(state.ppgMinGames || 8, 1, 18);
      const ppgPool =
        state.tagTrackingMeta && Array.isArray(state.tagTrackingMeta.ppg_pool)
          ? state.tagTrackingMeta.ppg_pool
          : null;
      computePpgRanks(tagEligibleAll, ppgPool, !!state.ppgMinGamesEnabled, ppgMin);
      const tagRows = sortRows(
        tagEligibleRows,
        sortState.tab === "eligible" ? sortState.key : "tagRank",
        sortState.tab === "eligible" ? sortState.dir : "asc"
      );
      const teamNameSource =
        (tagRows[0] && tagRows[0].franchise_name) ||
        (positionFilteredTagTracking[0] && positionFilteredTagTracking[0].franchise_name) ||
        "";
      const teamName = showAllTeams ? "All Teams" : safeStr(teamNameSource || "Team");

      syncTabLabels();
      syncModuleChipSelection();
      syncCommishConsole(scopedEligibility);

      if (summary)
        summary.innerHTML = renderTagSummary(
          teamName,
          tagRows,
          season,
          selectedTeamId,
          showAllTeams,
          positionFilteredTagTracking
        );
      if (tabSummary)
        tabSummary.innerHTML = renderTagSummaryPage(
          tagEligibleRows,
          showAllTeams ? "League" : teamName,
          state.tagSummaryView || "pos",
          !!state.tagCalcOpen,
          state.tagTrackingMeta || {},
          state.tagSummarySide || "ALL",
          seasonTagTracking || []
        );
      if (tabCostCalc)
        tabCostCalc.innerHTML = renderTagCostCalcPage(
          state.tagTrackingMeta || {},
          state.tagSummarySide || "ALL",
          seasonTagTracking || []
        );
      if (tabEligible) tabEligible.innerHTML = renderTable(tagRows, "eligible");
      if (tabIneligible) tabIneligible.innerHTML = "";
      if (tabSubmitted) tabSubmitted.innerHTML = renderTagFinalizedSubmissionsPage(season);
      updateModuleStatusChips();
      return;
    }

    if (state.activeModule === "commish") {
      const landing = renderCommishModulePage();
      syncTabLabels();
      syncModuleChipSelection();
      syncCommishConsole(scopedEligibility);
      if (summary) summary.innerHTML = landing;
      if (tabSummary) tabSummary.innerHTML = landing;
      if (tabCostCalc) tabCostCalc.innerHTML = "";
      if (tabEligible) tabEligible.innerHTML = landing;
      if (tabIneligible) tabIneligible.innerHTML = "";
      if (tabSubmitted) tabSubmitted.innerHTML = landing;
      updateModuleStatusChips();
      return;
    }

    if (state.activeModule === "extensions") {
      const extensionProjectedRows = projectExtensionRowsForSeason(
        scopedEligibility,
        baseSeason,
        contractSeason
      );
      const extensionRows = sortRows(
        extensionProjectedRows.filter((r) => canExtendRow(r)),
        sortState.tab === "eligible" ? sortState.key : "player",
        sortState.tab === "eligible" ? sortState.dir : "asc"
      );
      const teamNameSource =
        (extensionRows[0] && extensionRows[0].franchise_name) ||
        (extensionProjectedRows[0] && extensionProjectedRows[0].franchise_name) ||
        "";
      const teamName = showAllTeams ? "All Teams" : safeStr(teamNameSource || "Team");
      syncTabLabels();
      syncModuleChipSelection();
      syncCommishConsole(scopedEligibility);
      if (summary) summary.innerHTML = renderExtensionsSummary(teamName, extensionRows);
      if (tabSummary) tabSummary.innerHTML = renderExtensionsSummary(teamName, extensionRows);
      if (tabCostCalc)
        tabCostCalc.innerHTML =
          '<div class="ccc-tableWrap" style="padding:12px;">Cost breakdown is shown per player in the extension popup.</div>';
      if (tabEligible) tabEligible.innerHTML = renderExtensionsTable(extensionRows, "eligible");
      if (tabIneligible) tabIneligible.innerHTML = "";
      if (tabSubmitted) tabSubmitted.innerHTML = renderExtensionsSubmittedPage(season);
      updateModuleStatusChips();
      return;
    }

    const restructureActiveNow =
      state.commishMode || isRestructureActiveForSeason(baseSeason, nowRef);
    const mymActionsOpen = state.commishMode || isMymActiveForSeason(baseSeason, nowRef);
    const restructureUsageByTeam = computeSubmissionUsageByTeam(seasonRestructureSubmissions);
    const eligibleRowsRaw =
      state.activeModule === "restructure"
        ? scopedEligibility.filter((r) => {
            if (!canRestructureRow(r)) return false;
            if (!restructureActiveNow) return false;
            const fid = pad4(r.franchise_id);
            return (restructureUsageByTeam.get(fid) || 0) < RESTRUCTURE_CAP_PER_TEAM;
          })
        : state.activeModule === "mym" && !mymActionsOpen
        ? []
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

    const bypassMymSubmittedFilters = state.activeModule === "mym" && state.activeTab === "submitted";
    const submittedRowsRaw = bypassMymSubmittedFilters
      ? moduleSubmittedForTab.slice()
      : searchLower
      ? moduleSubmittedForTab.filter((r) => safeStr(r.player_name).toLowerCase().includes(searchLower))
      : moduleSubmittedForTab.slice();

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
    // Keep commish console list aligned with current team/position/search filters.
    syncCommishConsole(scopedEligibility);
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
      tabSummary.innerHTML =
        state.activeModule === "restructure"
          ? renderRestructureSummaryPage(
              eligibleRows,
              submittedRowsRaw,
              teamName,
              selectedPosition
            )
          : renderSummaryPage(eligibleRows, submittedRowsRaw, teamName, selectedPosition);
    }
    if (tabCostCalc) tabCostCalc.innerHTML = "";
    if (tabEligible) {
      tabEligible.innerHTML = renderEligibleAvailabilityNotice(season) + renderTable(eligibleRows, "eligible");
    }
    if (tabIneligible) tabIneligible.innerHTML = "";
    if (tabSubmitted) {
      if (state.activeModule === "mym") {
        const header = renderMymSubmissionSeasonControls(mymSubmissionSeasons, mymSubmissionSeason);
        tabSubmitted.innerHTML = header + renderTable(submittedRows, "submitted");
      } else {
        tabSubmitted.innerHTML = renderTable(submittedRows, "submitted");
      }
    }
    updateModuleStatusChips();
  }

  // ======================================================
  // 9B) MODAL STATE + HELPERS
  // ======================================================
  const mymModalState = { open: false, row: null, years: 2 };
  const tagModalState = { open: false, key: "" };
  const extensionModalState = { open: false, key: "", yearsToAdd: 1 };

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

  function findTagRowForSelection(selection) {
    if (!selection) return null;
    const pid = safeStr(selection.player_id);
    const season = normalizeSeasonValue(selection.season || state.selectedSeason);
    if (!pid) return null;
    return (state.tagTrackingRows || []).find(
      (r) => safeStr(r.player_id) === pid && normalizeSeasonValue(r.season) === season
    ) || null;
  }

  function buildTagSubmissionPayload(selection, row) {
    const refRow = row || findTagRowForSelection(selection) || {};
    const salary = safeInt(refRow.tag_bid || refRow.tag_salary || 0);
    const tier = safeInt(refRow.tag_tier || 0);
    const formula = safeStr(refRow.tag_formula || "");
    const infoParts = ["Tag"];
    if (tier) infoParts.push(`Tier ${tier}`);
    if (formula) infoParts.push(`Formula: ${formula}`);
    const contractInfo = infoParts.join(" | ");
    return {
      league_id: safeStr(getLeagueId() || DEFAULT_LEAGUE_ID),
      season: normalizeSeasonValue(selection && selection.season ? selection.season : state.selectedSeason),
      franchise_id: safeStr(selection && selection.franchise_id),
      franchise_name: safeStr(selection && selection.franchise_name),
      player_id: safeStr(selection && selection.player_id),
      player_name: safeStr(selection && selection.player_name),
      pos: safeStr(selection && selection.pos),
      salary,
      contract_year: 1,
      contract_status: "Tag",
      contract_info: contractInfo,
      tag_formula: formula,
    };
  }

  function getTagSalaryForSubmission(sub) {
    if (!sub) return 0;
    const payload = sub.payload || null;
    const payloadSalary = safeInt(payload && payload.salary);
    if (payloadSalary > 0) return payloadSalary;
    const direct = safeInt(sub.tag_salary || sub.tag_bid || sub.salary);
    if (direct > 0) return direct;
    const row = findTagRowForSelection(sub);
    if (row) return safeInt(row.tag_bid || row.tag_salary || 0);
    return 0;
  }

  function findExtensionRow(selection) {
    if (!selection) return null;
    if (selection.row_snapshot) return { ...selection.row_snapshot };
    const pid = safeStr(selection.player_id);
    const season = normalizeSeasonValue(selection.season || state.selectedSeason);
    return (
      (state.payload.eligibility || []).find(
        (r) => safeStr(r.player_id) === pid && normalizeSeasonValue(r.season) === season
      ) || null
    );
  }

  function getExtensionCustomYearsFromInputs() {
    const y1 = safeInt($("#extYear1Input") && $("#extYear1Input").value);
    const y2 = safeInt($("#extYear2Input") && $("#extYear2Input").value);
    return [y1, y2];
  }

  function renderExtensionModalPreview() {
    const key = safeStr(extensionModalState.key);
    if (!key) return null;
    const sel = state.extensionSelections[key];
    if (!sel) return null;
    const row = findExtensionRow(sel);
    if (!row) return null;

    const preview = buildExtensionPreview(
      row,
      extensionModalState.yearsToAdd,
      getExtensionCustomYearsFromInputs()
    );
    const eligibility = getExtensionEligibility(row, extensionModalState.yearsToAdd);
    const breakdown = $("#extModalBreakdown");
    if (breakdown) breakdown.textContent = preview.lines.join("\n");
    const payloadEl = $("#extModalPreview");
    if (payloadEl) payloadEl.textContent = JSON.stringify(preview.payload, null, 2);

    const err = $("#extModalErr");
    if (err) {
      const loadedNow = countTeamLoadedContracts(row.franchise_id, row.season);
      const isLoadedNew =
        preview.expiredRookie &&
        preview.yearSalaries.length > 1 &&
        safeInt(preview.yearSalaries[0]) !== safeInt(preview.yearSalaries[1]);
      const loadedProjected = loadedNow + (isLoadedNew ? 1 : 0);
      const loadedCapFail = preview.expiredRookie && isLoadedNew && loadedProjected > 5;

      const messages = [];
      if (!eligibility.ok) messages.push(eligibility.reason);
      if (preview.minY1Violation)
        messages.push(`Year 1 must be at least ${preview.minY1.toLocaleString()} (20% of TCV).`);
      if (loadedCapFail) messages.push(`Front/backloaded contract cap exceeded (${loadedProjected}/5).`);
      if (eligibility.deadline)
        messages.push(`Extension deadline: ${fmtYMDDate(eligibility.deadline)}`);
      if (messages.length) {
        err.style.display = "";
        err.classList.remove("ok");
        err.innerHTML = messages.map((m) => htmlEsc(m)).join("<br>");
      } else {
        err.style.display = "none";
        err.classList.remove("ok");
        err.textContent = "";
      }
    }
    return { row, preview, eligibility };
  }

  function openExtensionModal(selectionKey) {
    const modal = $("#extensionModal");
    if (!modal) return;
    const sel = state.extensionSelections[selectionKey];
    if (!sel) return;
    const row = findExtensionRow(sel);
    if (!row) return;

    extensionModalState.open = true;
    extensionModalState.key = selectionKey;
    extensionModalState.yearsToAdd = Math.max(1, Math.min(2, safeInt(sel.years_to_add) || 1));

    const title = $("#extModalTitle");
    if (title) title.textContent = `Offer Extension - ${safeStr(row.player_name)}`;
    const sub = $("#extModalSub");
    if (sub) sub.textContent = `Current Salary: ${safeInt(row.salary).toLocaleString()} | Team: ${safeStr(row.franchise_name || row.franchise_id)}`;

    const b1 = $("#extOption1Btn");
    const b2 = $("#extOption2Btn");
    if (b1 && b2) {
      b1.classList.toggle("primary", extensionModalState.yearsToAdd === 1);
      b2.classList.toggle("primary", extensionModalState.yearsToAdd === 2);
    }

    const disclaimer = $("#extModalDisclaimer");
    if (disclaimer) {
      if (isExpiredRookieRow(row)) {
        disclaimer.style.display = "none";
      } else {
        disclaimer.style.display = "";
      }
    }

    const splitRow = $("#extRookieSplitRow");
    const y1Input = $("#extYear1Input");
    const y2Input = $("#extYear2Input");
    if (splitRow) splitRow.style.display = isExpiredRookieRow(row) ? "" : "none";
    if (y1Input) y1Input.value = "";
    if (y2Input) {
      y2Input.value = "";
      y2Input.disabled = extensionModalState.yearsToAdd < 2;
    }

    const err = $("#extModalErr");
    if (err) {
      err.style.display = "none";
      err.textContent = "";
      err.classList.remove("ok");
    }

    renderExtensionModalPreview();
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("ccc-modalOpen");
  }

  function closeExtensionModal() {
    const modal = $("#extensionModal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    extensionModalState.open = false;
    extensionModalState.key = "";
    const mym = $("#mymModal");
    const rs = $("#restructureModal");
    const tag = $("#tagModal");
    const tagAck = $("#tagAckModal");
    const dev = $("#devNoticeModal");
    const anyOpen =
      (mym && mym.classList.contains("is-open")) ||
      (rs && rs.classList.contains("is-open")) ||
      (tag && tag.classList.contains("is-open")) ||
      (tagAck && tagAck.classList.contains("is-open")) ||
      (dev && dev.classList.contains("is-open"));
    if (!anyOpen) document.body.classList.remove("ccc-modalOpen");
  }

  function setExtensionYears(years) {
    extensionModalState.yearsToAdd = Math.max(1, Math.min(2, safeInt(years) || 1));
    const key = safeStr(extensionModalState.key);
    const sel = state.extensionSelections[key];
    if (sel) sel.years_to_add = extensionModalState.yearsToAdd;
    saveExtensionSelections(state.extensionSelections);
    const b1 = $("#extOption1Btn");
    const b2 = $("#extOption2Btn");
    if (b1 && b2) {
      b1.classList.toggle("primary", extensionModalState.yearsToAdd === 1);
      b2.classList.toggle("primary", extensionModalState.yearsToAdd === 2);
    }
    const y2Input = $("#extYear2Input");
    if (y2Input) y2Input.disabled = extensionModalState.yearsToAdd < 2;
    renderExtensionModalPreview();
  }

  function submitExtensionSelection() {
    const key = safeStr(extensionModalState.key);
    if (!key) return;
    const sel = state.extensionSelections[key];
    if (!sel) return;
    const row = findExtensionRow(sel);
    if (!row) return;
    const out = renderExtensionModalPreview();
    if (!out) return;
    const preview = out.preview;
    const eligibility = out.eligibility;
    const loadedNow = countTeamLoadedContracts(row.franchise_id, row.season);
    const isLoadedNew =
      preview.expiredRookie &&
      preview.yearSalaries.length > 1 &&
      safeInt(preview.yearSalaries[0]) !== safeInt(preview.yearSalaries[1]);
    const loadedProjected = loadedNow + (isLoadedNew ? 1 : 0);
    if (!eligibility.ok || preview.minY1Violation || (preview.expiredRookie && isLoadedNew && loadedProjected > 5)) {
      return;
    }
    state.extensionSubmissions[key] = {
      ...preview.payload,
      submitted_at_utc: new Date().toISOString(),
    };
    saveExtensionSubmissions(state.extensionSubmissions);
    const err = $("#extModalErr");
    if (err) {
      err.style.display = "";
      err.textContent = "Extension selection submitted locally.";
      err.classList.add("ok");
    }
    render();
  }

  function openDevNotice() {
    const modal = $("#devNoticeModal");
    if (!modal) return;
    modal.dataset.opened = "1";
    modal.classList.add("is-open");
    document.body.classList.add("ccc-modalOpen");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeDevNotice() {
    const modal = $("#devNoticeModal");
    if (!modal) return;
    modal.dataset.opened = "0";
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    const mym = $("#mymModal");
    const rs = $("#restructureModal");
    const tag = $("#tagModal");
    const tagAck = $("#tagAckModal");
    const ext = $("#extensionModal");
    const anyOpen =
      (mym && mym.classList.contains("is-open")) ||
      (rs && rs.classList.contains("is-open")) ||
      (tag && tag.classList.contains("is-open")) ||
      (tagAck && tagAck.classList.contains("is-open")) ||
      (ext && ext.classList.contains("is-open"));
    if (!anyOpen) document.body.classList.remove("ccc-modalOpen");
  }

  function maybeShowDevNotice() {
    try {
      if (sessionStorage.getItem(SESSION_DEV_NOTICE_KEY)) return;
      sessionStorage.setItem(SESSION_DEV_NOTICE_KEY, "1");
    } catch (e) {}
    openDevNotice();
  }

  function openTagModal(selectionKey) {
    const modal = $("#tagModal");
    if (!modal) return;
    const sel = state.tagSelections[selectionKey];
    if (!sel) return;

    tagModalState.open = true;
    tagModalState.key = selectionKey;

    const title = $("#tagModalTitle");
    if (title) title.textContent = "Submit Tag Selection";

    const baseSeason = state.calendarBaseSeason || getBaseSeasonValue(state.selectedSeason);
    const deadlineInfo = getTagDeadlineInfo(baseSeason);
    const deadlineTxt = deadlineInfo ? fmtYMDDate(deadlineInfo.tagDeadline) : "TBD";

    const sub = $("#tagModalSub");
    if (sub) {
      sub.textContent = `You can change your selection until ${deadlineTxt}.`;
    }

    const selectionLine = `${safeStr(sel.player_name)} (${safeStr(sel.pos)}) — ${
      safeStr(sel.franchise_name || sel.franchise_id) || "Team"
    }`;
    const selectionEl = $("#tagModalSelection");
    if (selectionEl) selectionEl.textContent = selectionLine;

    const deadlineEl = $("#tagModalDeadline");
    if (deadlineEl) deadlineEl.textContent = `Tag deadline: ${deadlineTxt}`;

    const submission = state.tagSubmissions[selectionKey];
    const isSubmitted =
      submission && safeStr(submission.player_id) === safeStr(sel.player_id);

    const preview = $("#tagModalPreview");
    if (preview) {
      const payload = buildTagSubmissionPayload(sel);
      preview.textContent = JSON.stringify(payload, null, 2);
    }

    const err = $("#tagModalErr");
    if (err) {
      if (isSubmitted) {
        const submittedAt = submission.submitted_at_utc
          ? fmtLocalYMDHM(new Date(submission.submitted_at_utc))
          : "";
        err.style.display = "";
        err.textContent = submittedAt ? `Submitted: ${submittedAt}` : "Submitted.";
        err.classList.add("ok");
      } else {
        err.style.display = "none";
        err.textContent = "";
        err.classList.remove("ok");
      }
    }
    const confirm = $("#tagModalConfirm");
    if (confirm) {
      confirm.style.display = "none";
      confirm.textContent = "";
    }

    const removeBtn = $("#tagRemoveBtn");
    if (removeBtn) {
      const pastDeadline = isTagDeadlinePassed(baseSeason);
      const canRemoveAfterDeadline = !!state.commishMode;
      const showRemove = isSubmitted && (!pastDeadline || canRemoveAfterDeadline);
      removeBtn.style.display = showRemove ? "" : "none";
    }

    const submitBtn = $("#tagSubmitBtn");
    if (submitBtn) {
      submitBtn.textContent = "Submit Tag";
      submitBtn.disabled = false;
    }

    modal.classList.add("is-open");
    document.body.classList.add("ccc-modalOpen");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeTagModal() {
    const modal = $("#tagModal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    const key = safeStr(tagModalState.key);
    if (key) {
      const submission = state.tagSubmissions[key];
      if (!submission) {
        delete state.tagSelections[key];
        saveTagSelections(state.tagSelections);
      }
    }
    tagModalState.open = false;
    tagModalState.key = "";
    const mym = $("#mymModal");
    const rs = $("#restructureModal");
    const tagAck = $("#tagAckModal");
    const ext = $("#extensionModal");
    const anyOpen =
      (mym && mym.classList.contains("is-open")) ||
      (rs && rs.classList.contains("is-open")) ||
      (tagAck && tagAck.classList.contains("is-open")) ||
      (ext && ext.classList.contains("is-open"));
    if (!anyOpen) document.body.classList.remove("ccc-modalOpen");
    render();
  }

  function openTagAckModal(sel, salary) {
    const modal = $("#tagAckModal");
    if (!modal) return;
    const body = $("#tagAckBody");
    if (body) {
      body.innerHTML =
        `Name: ${htmlEsc(sel && sel.player_name ? sel.player_name : "")}<br>` +
        `Salary: ${safeInt(salary).toLocaleString()}`;
    }
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("ccc-modalOpen");
  }

  function closeTagAckModal() {
    const modal = $("#tagAckModal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    const mym = $("#mymModal");
    const rs = $("#restructureModal");
    const tag = $("#tagModal");
    const ext = $("#extensionModal");
    const dev = $("#devNoticeModal");
    const anyOpen =
      (mym && mym.classList.contains("is-open")) ||
      (rs && rs.classList.contains("is-open")) ||
      (tag && tag.classList.contains("is-open")) ||
      (ext && ext.classList.contains("is-open")) ||
      (dev && dev.classList.contains("is-open"));
    if (!anyOpen) document.body.classList.remove("ccc-modalOpen");
  }

  function submitTagSelection() {
    const key = safeStr(tagModalState.key);
    if (!key) return;
    const sel = state.tagSelections[key];
    if (!sel) return;
    const payload = buildTagSubmissionPayload(sel);
    state.tagSubmissions[key] = {
      ...sel,
      submitted_at_utc: new Date().toISOString(),
      tag_salary: payload.salary,
      payload,
    };
    saveTagSubmissions(state.tagSubmissions);
    closeTagModal();
    openTagAckModal(sel, payload.salary);
    render();
  }

  function removeTagSelection() {
    const key = safeStr(tagModalState.key);
    if (!key) return;
    delete state.tagSelections[key];
    delete state.tagSubmissions[key];
    saveTagSelections(state.tagSelections);
    saveTagSubmissions(state.tagSubmissions);
    closeTagModal();
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
    modal.setAttribute("aria-hidden", "true");
    const rs = $("#restructureModal");
    const tag = $("#tagModal");
    const tagAck = $("#tagAckModal");
    const ext = $("#extensionModal");
    const dev = $("#devNoticeModal");
    const anyOpen =
      (rs && rs.classList.contains("is-open")) ||
      (tag && tag.classList.contains("is-open")) ||
      (tagAck && tagAck.classList.contains("is-open")) ||
      (ext && ext.classList.contains("is-open")) ||
      (dev && dev.classList.contains("is-open"));
    if (!anyOpen) document.body.classList.remove("ccc-modalOpen");

    mymModalState.open = false;
    mymModalState.row = null;
  }

  // ✅ FIXED: single, clean submit function (no duplicate try blocks)
  async function submitMYMContract() {
  const row = mymModalState.row;
  if (!row) return;
  if (!state.commishMode) {
    const err = $("#mymModalErr");
    if (err) {
      err.style.display = "";
      err.textContent = "Submissions are disabled while the app is still under development.";
    }
    return;
  }

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
    modal.setAttribute("aria-hidden", "true");
    const mym = $("#mymModal");
    const tag = $("#tagModal");
    const tagAck = $("#tagAckModal");
    const ext = $("#extensionModal");
    const dev = $("#devNoticeModal");
    const anyOpen =
      (mym && mym.classList.contains("is-open")) ||
      (tag && tag.classList.contains("is-open")) ||
      (tagAck && tagAck.classList.contains("is-open")) ||
      (ext && ext.classList.contains("is-open")) ||
      (dev && dev.classList.contains("is-open"));
    if (!anyOpen) document.body.classList.remove("ccc-modalOpen");
    restructureModalState.open = false;
    restructureModalState.row = null;
    restructureModalState.calc = null;
  }

  async function submitRestructureContract() {
    const row = restructureModalState.row;
    const calc = renderRestructureModalSummary();
    if (!row || !calc) return;
    if (!state.commishMode) {
      const err = $("#rsModalErr");
      if (err) {
        err.style.display = "";
        err.textContent = "Submissions are disabled while the app is still under development.";
      }
      return;
    }

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
      must("#cccMain");
      must("#cccTabs");
      must("#tabSummary");
      must("#tabCostCalc");
      must("#tabEligible");
      must("#tabSubmitted");
      must("#teamSelect");
      must("#positionSelect");
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
      must("#rowHighlightChk");
      must("#rowHighlightModeSelect");
      must("#adminBadge");
      must("#adminControls");
      must("#asOfInput");
      must("#asOfApplyBtn");
      must("#asOfResetBtn");
      must("#asOfSeasonSelect");
      must("#clearBtn");
      must("#teamFilterWrap");

      applyThemeSetting(state.theme);
      applyHighlightSetting();

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
      must("#tagModal");
      must("#tagSubmitBtn");
      must("#tagRemoveBtn");
      must("#extensionModal");
      must("#extOption1Btn");
      must("#extOption2Btn");
      must("#extSubmitBtn");
      must("#extYear1Input");
      must("#extYear2Input");

      $("#cccMeta").textContent = "Loading MYM data…";

      const bust = (MYM_JSON_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const subBust =
        (MYM_SUBMISSIONS_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const restructureBust =
        (RESTRUCTURE_SUBMISSIONS_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const tagBust = (TAG_TRACKING_URL.includes("?") ? "&" : "?") + "v=" + Date.now();

      const [res, subRes, restructureSubRes, tagRes] = await Promise.all([
        fetch(MYM_JSON_URL + bust, { cache: "no-store" }),
        fetch(MYM_SUBMISSIONS_URL + subBust, { cache: "no-store" }).catch(() => null),
        fetch(RESTRUCTURE_SUBMISSIONS_URL + restructureBust, { cache: "no-store" }).catch(
          () => null
        ),
        fetch(TAG_TRACKING_URL + tagBust, { cache: "no-store" }).catch(() => null),
      ]);
      if (!res.ok) throw new Error("MYM JSON HTTP " + res.status);

      const raw = await res.json();
      state.payload = normalizePayload(raw);
      const payloadSubRows = Array.isArray(state.payload.submissions)
        ? state.payload.submissions.slice()
        : [];
      let subRows = [];
      if (subRes && subRes.ok) {
        try {
          const subRaw = await subRes.json();
          subRows = normalizeSubmissions(subRaw);
        } catch (e) {}
      }
      state.payload.submissions = subRows.length ? subRows : payloadSubRows;
      let restructureRows = [];
      if (restructureSubRes && restructureSubRes.ok) {
        try {
          const restructureRaw = await restructureSubRes.json();
          restructureRows = normalizeSubmissions(restructureRaw);
        } catch (e) {}
      }
      state.restructureSubmissions = restructureRows;
      let tagRows = [];
      let tagMeta = {};
      if (tagRes && tagRes.ok) {
        try {
          const tagRaw = await tagRes.json();
          tagRows = normalizeTagRows(tagRaw);
          tagMeta = (tagRaw && typeof tagRaw === "object" && tagRaw.meta) || {};
        } catch (e) {}
      }
      state.tagTrackingRows = tagRows;
      state.tagTrackingMeta = tagMeta;
      applyLocalOverrides(state.payload.eligibility);

      state.detectedFranchiseId = detectFranchiseId();

      const workerAdmin = await getAdminFlagFromWorker();
      state.detectedFranchiseId = await resolveCurrentFranchiseId(
        workerAdmin.L,
        workerAdmin.YEAR,
        state.detectedFranchiseId
      );
      const currentFranchiseId = pad4(state.detectedFranchiseId);
      const commishFranchiseId = pad4(workerAdmin.commishFranchiseId || "");

      // Explicit gating requested: commish tools only for franchise 0008.
      const commishGateFranchise = pad4(COMMISH_FRANCHISE_ID || commishFranchiseId || "");
      let canCommish =
        !!workerAdmin.ok &&
        !!workerAdmin.isAdmin &&
        !!currentFranchiseId &&
        !!commishGateFranchise &&
        currentFranchiseId === commishGateFranchise;
      const adminReason = canCommish
        ? safeStr(workerAdmin.reason || "Admin mode")
        : "Owner mode (admin tools limited)";

      state.isAdmin = canCommish;
      state.canCommishMode = canCommish;
      state.commishMode = state.canCommishMode ? true : false;
      state.commishConsoleOpen = false;
      state.adminReason = adminReason;
      state.adminDebug = {
        canCommish: !!canCommish,
        workerOk: !!workerAdmin.ok,
        workerIsAdmin: !!workerAdmin.isAdmin,
        sessionKnown: !!workerAdmin.sessionKnown,
        sessionMatch: !!workerAdmin.sessionMatch,
        currentFranchiseId,
        commishFranchiseId: commishGateFranchise,
        workerReason: safeStr(workerAdmin.reason || ""),
      };

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
        state.asOfDraft = state.asOfDate ? new Date(state.asOfDate.getTime()) : null;
      } else {
        state.asOfDate = null;
        state.asOfOverrideActive = false;
        state.asOfDraft = null;
        clearAsOfOverrideState();
        $("#asOfInput").value = "";
      }

      const seasons = buildSeasonList(
        state.payload.eligibility,
        state.payload.submissions,
        state.restructureSubmissions,
        state.tagTrackingRows
      );
      const requestedSeason = normalizeSeasonValue(getYear() || DEFAULT_YEAR);
      const seasonSelected = seasons.includes(requestedSeason)
        ? requestedSeason
        : seasons[0] || requestedSeason;
      state.selectedSeason = seasonSelected;
      if (state.commishMode) {
        populateAsOfSeasonSelect(seasons, state.asOfSeasonOverride);
      }

      const seasonRows = state.payload.eligibility.filter(
        (r) => normalizeSeasonValue(r.season) === state.selectedSeason
      );
      const seasonSubmissionRows = state.payload.submissions.filter(
        (r) => normalizeSeasonValue(r.season) === state.selectedSeason
      );
      const seasonRestructureRows = (state.restructureSubmissions || []).filter(
        (r) => normalizeSeasonValue(r.season) === state.selectedSeason
      );
      const seasonTagRows = (state.tagTrackingRows || []).filter(
        (r) => normalizeSeasonValue(r.season) === state.selectedSeason
      );
      const mergedSubmissionRows = seasonSubmissionRows.concat(
        seasonRestructureRows,
        seasonTagRows
      );
      const teams = buildTeamList(seasonRows, mergedSubmissionRows, state.detectedFranchiseId);
      const detected = teams.some((t) => t.id === state.detectedFranchiseId)
        ? state.detectedFranchiseId
        : teams[0]
        ? teams[0].id
        : "";
      state.selectedTeam = detected;
      state.lastOwnerTeam = detected;
      populateTeamSelect(teams, state.selectedTeam);
      const teamSelect = $("#teamSelect");
      if (teamSelect) {
        if (state.commishMode) {
          teamSelect.value = "__ALL__";
          state.selectedTeam = "__ALL__";
          state.showAllTeams = true;
        } else {
          const v = safeStr(teamSelect.value);
          state.selectedTeam = v;
          state.showAllTeams = v === "__ALL__";
        }
      }
      const positions = buildPositionList(seasonRows, mergedSubmissionRows);
      state.selectedPosition = "__ALL_POS__";
      populatePositionSelect(positions, state.selectedPosition);
      const positionSelect = $("#positionSelect");
      if (positionSelect) positionSelect.disabled = false;

      // Apply saved defaults
      const defaults = state.defaultFilters || {};
      if (!state.commishMode) {
        const defaultTeam = safeStr(defaults.teamId || "");
        if (teamSelect && defaultTeam) {
          const hasOpt = Array.from(teamSelect.options).some((o) => o.value === defaultTeam);
          if (hasOpt) {
            teamSelect.value = defaultTeam;
            state.selectedTeam = defaultTeam;
            state.showAllTeams = defaultTeam === "__ALL__";
          }
        }
      }
      if (positionSelect) {
        const defaultPos = safeStr(defaults.position || "");
        if (defaultPos) {
          const hasOpt = Array.from(positionSelect.options).some((o) => o.value === defaultPos);
          if (hasOpt) {
            positionSelect.value = defaultPos;
            state.selectedPosition = defaultPos;
          }
        }
      }

      const defaultsSize = state.defaultFilters || {};
      const defaultSize = clampInt(defaultsSize.pageSize || state.pageSize, 10, 500);
      state.pageSize = [25, 50, 100].includes(defaultSize) ? defaultSize : 50;

      resetAllTablePages();
      setTab("eligible");

      // default sort per tab
      sortState.tab = "eligible";
      sortState.key = state.activeModule === "tag" ? "player" : "acquired";
      sortState.dir = state.activeModule === "tag" ? "asc" : "desc";

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
    const tabCostCalc = $("#tabCostCalc");
    const tabEligible = $("#tabEligible");
    const tabIneligible = $("#tabIneligible");
    const tabSubmitted = $("#tabSubmitted");

    if (tabSummary) tabSummary.style.display = tab === "summary" ? "" : "none";
    if (tabCostCalc) tabCostCalc.style.display = tab === "costcalc" ? "" : "none";
    if (tabEligible) tabEligible.style.display = tab === "eligible" ? "" : "none";
    if (tabIneligible) tabIneligible.style.display = tab === "ineligible" ? "" : "none";
    if (tabSubmitted) tabSubmitted.style.display = tab === "submitted" ? "" : "none";

    $$(".ccc-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    applyHighlightSetting();
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
    const moduleTagsChip = $("#moduleTagsChip");
    if (moduleTagsChip)
      moduleTagsChip.addEventListener("click", () => {
        switchModule("tag");
        sortState.tab = "eligible";
        sortState.key = "player";
        sortState.dir = "asc";
        resetAllTablePages();
        setTab("eligible");
        render();
      });

    const moduleMymChip = $("#moduleMymChip");
    if (moduleMymChip)
      moduleMymChip.addEventListener("click", () => {
        switchModule("mym");
        sortState.tab = "eligible";
        sortState.key = "acquired";
        sortState.dir = "desc";
        resetAllTablePages();
        setTab("eligible");
        render();
      });

    const moduleRestructuresChip = $("#moduleRestructuresChip");
    if (moduleRestructuresChip)
      moduleRestructuresChip.addEventListener("click", () => {
        switchModule("restructure");
        sortState.tab = "eligible";
        sortState.key = "salary";
        sortState.dir = "desc";
        resetAllTablePages();
        setTab("eligible");
        render();
      });

    const moduleExtensionsChip = $("#moduleExtensionsChip");
    if (moduleExtensionsChip)
      moduleExtensionsChip.addEventListener("click", () => {
        switchModule("extensions");
        sortState.tab = "eligible";
        sortState.key = "player";
        sortState.dir = "asc";
        resetAllTablePages();
        setTab("eligible");
        render();
      });

    const moduleCommishChip = $("#moduleCommishChip");
    if (moduleCommishChip)
      moduleCommishChip.addEventListener("click", () => {
        switchModule("commish");
        resetAllTablePages();
        setTab("eligible");
        render();
      });

    const rowHighlightChk = $("#rowHighlightChk");
    if (rowHighlightChk)
      rowHighlightChk.addEventListener("change", (e) => {
        state.rowHighlightEnabled = !!e.target.checked;
        rememberHighlightForModule(state.activeModule || "default");
        applyHighlightSetting();
      });

    const rowHighlightModeSelect = $("#rowHighlightModeSelect");
    if (rowHighlightModeSelect)
      rowHighlightModeSelect.addEventListener("change", (e) => {
        const v = safeStr(e.target.value || "position").toLowerCase();
        state.rowHighlightMode = v === "team" ? "team" : "position";
        rememberHighlightForModule(state.activeModule || "default");
        applyHighlightSetting();
      });

    const rowHighlightSeg = $("#rowHighlightSeg");
    if (rowHighlightSeg)
      rowHighlightSeg.addEventListener("click", (e) => {
        const btn = e.target && e.target.closest ? e.target.closest(".seg") : null;
        if (!btn || btn.disabled) return;
        const v = safeStr(btn.getAttribute("data-highlight") || "").toLowerCase();
        state.rowHighlightMode = v === "team" ? "team" : "position";
        rememberHighlightForModule(state.activeModule || "default");
        applyHighlightSetting();
      });

    // Admin module controls
    document.addEventListener("change", (e) => {
      const target = e.target;
      if (!target) return;
      if (target.getAttribute && target.getAttribute("data-admin-theme")) {
        const v = safeStr(target.value || "auto").toLowerCase();
        state.theme = v === "light" || v === "dark" || v === "auto" ? v : "auto";
        saveThemeSetting(state.theme);
        applyThemeSetting(state.theme);
        return;
      }
      const defKey = target.getAttribute && target.getAttribute("data-admin-default");
      if (!defKey) return;
      state.defaultFilters = state.defaultFilters || loadDefaultFilters();
      if (defKey === "team") {
        const v = safeStr(target.value || "");
        state.defaultFilters.teamId = v;
        saveDefaultFilters(state.defaultFilters);
        if (!state.commishMode) {
          const teamSelect = $("#teamSelect");
          if (teamSelect && v) {
            teamSelect.value = v;
            state.selectedTeam = v;
            state.showAllTeams = v === "__ALL__";
          }
        }
      } else if (defKey === "position") {
        const v = safeStr(target.value || "__ALL_POS__");
        state.defaultFilters.position = v;
        saveDefaultFilters(state.defaultFilters);
        const positionSelect = $("#positionSelect");
        if (positionSelect) {
          positionSelect.value = v;
          state.selectedPosition = v;
        }
      } else if (defKey === "rows") {
        const v = clampInt(target.value || state.pageSize, 10, 500);
        state.defaultFilters.pageSize = [25, 50, 100].includes(v) ? v : 50;
        saveDefaultFilters(state.defaultFilters);
        state.pageSize = state.defaultFilters.pageSize;
      }
      resetAllTablePages();
      render();
    });

    document.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-admin-action]") : null;
      if (!btn) return;
      const action = safeStr(btn.getAttribute("data-admin-action"));
      if (action === "refresh") {
        handleRosterRefreshClick();
      }
    });

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
        const v = safeStr(e.target.value);
        state.selectedTeam = v;
        state.showAllTeams = v === "__ALL__";
        saveFiltersForModule(state.activeModule || "default");
        resetAllTablePages();
        render();
      });

    const positionSelect = $("#positionSelect");
    if (positionSelect)
      positionSelect.addEventListener("change", (e) => {
        state.selectedPosition = safeStr(e.target.value || "__ALL_POS__");
        saveFiltersForModule(state.activeModule || "default");
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
        if (!state.commishMode) {
          state.commishConsoleOpen = false;
        }
        const adminBadge = $("#adminBadge");
        const adminControls = $("#adminControls");
        if (adminBadge) adminBadge.style.display = state.commishMode ? "" : "none";
        if (adminControls) adminControls.style.display = state.commishMode ? "flex" : "none";

        const teamSelect = $("#teamSelect");
        if (state.commishMode) {
          state.lastOwnerTeam = state.lastOwnerTeam || state.selectedTeam;
          state.selectedTeam = "__ALL__";
          state.showAllTeams = true;
          if (teamSelect) teamSelect.value = "__ALL__";
        } else {
          const fallback =
            state.lastOwnerTeam ||
            state.detectedFranchiseId ||
            (teamSelect && teamSelect.options[0] ? teamSelect.options[0].value : "");
          state.selectedTeam = fallback;
          state.showAllTeams = fallback === "__ALL__";
          if (teamSelect && fallback) teamSelect.value = fallback;
        }

        render();
      });

    const searchBox = $("#searchBox");
    if (searchBox)
      searchBox.addEventListener("input", (e) => {
        state.search = e.target.value;
        saveFiltersForModule(state.activeModule || "default");
        resetAllTablePages();
        render();
      });

    const clearBtn = $("#clearBtn");
    if (clearBtn)
      clearBtn.addEventListener("click", () => {
        $("#searchBox").value = "";
        state.search = "";
        saveFiltersForModule(state.activeModule || "default");
        resetAllTablePages();
        render();
      });

    // Admin as-of
    const asOfInput = $("#asOfInput");
    if (asOfInput)
      asOfInput.addEventListener("change", () => {
        if (!state.canCommishMode || !state.commishMode) return;
        const v = asOfInput.value;
        const d = v ? new Date(v) : new Date();
        state.asOfDraft = isNaN(d.getTime()) ? new Date() : d;
      });

    const asOfApplyBtn = $("#asOfApplyBtn");
    if (asOfApplyBtn)
      asOfApplyBtn.addEventListener("click", () => {
        if (!state.canCommishMode || !state.commishMode) return;
        const d = state.asOfDraft || new Date();
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
        state.asOfDraft = now;
        $("#asOfInput").value = fmtForDatetimeLocal(now);
        saveAsOfOverrideState(state.asOfDate, state.asOfOverrideActive);
        render();
      });

    const asOfSeasonSelect = $("#asOfSeasonSelect");
    if (asOfSeasonSelect)
      asOfSeasonSelect.addEventListener("change", (e) => {
        if (!state.canCommishMode || !state.commishMode) return;
        const v = safeStr(e.target.value);
        state.asOfSeasonOverride = v;
        saveAsOfSeasonOverride(v);
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
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-extension-action='1']") : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const fid = pad4(btn.getAttribute("data-franchise-id"));
        if (!canManageTagForFranchise(fid)) return;
        const pid = safeStr(btn.getAttribute("data-player-id"));
        const season = normalizeSeasonValue(btn.getAttribute("data-season") || state.selectedSeason);
        const key = buildExtensionSelectionKey(season, fid, pid);
        const row =
          (state.payload.eligibility || []).find(
            (r) =>
              pad4(r.franchise_id) === fid &&
              safeStr(r.player_id) === pid &&
              normalizeSeasonValue(r.season) === season
          ) || null;
        const rowSnapshot = {
          season,
          franchise_id: fid,
          franchise_name: safeStr(
            (row && row.franchise_name) || btn.getAttribute("data-franchise-name") || ""
          ),
          player_id: pid,
          player_name: safeStr((row && row.player_name) || btn.getAttribute("data-player-name") || ""),
          positional_grouping: safeStr((row && row.positional_grouping) || btn.getAttribute("data-pos") || ""),
          position: safeStr((row && row.position) || btn.getAttribute("data-pos") || ""),
          salary: safeInt((row && row.salary) || btn.getAttribute("data-salary")),
          contract_year: safeInt(
            (row && row.contract_year) || btn.getAttribute("data-contract-year")
          ),
          contract_status: safeStr(
            (row && row.contract_status) || btn.getAttribute("data-contract-status")
          ),
          contract_info: safeStr((row && row.contract_info) || btn.getAttribute("data-contract-info")),
          acquired_date: safeStr((row && row.acquired_date) || btn.getAttribute("data-acquired-date")),
          mym_deadline: safeStr((row && row.mym_deadline) || btn.getAttribute("data-mym-deadline")),
          mym_acq_type: safeStr((row && row.mym_acq_type) || btn.getAttribute("data-acq-type")),
        };
        if (!rowSnapshot.player_id) return;
        state.extensionSelections[key] = {
          league_id: safeStr(getLeagueId() || DEFAULT_LEAGUE_ID),
          season,
          franchise_id: fid,
          franchise_name: safeStr(
            rowSnapshot.franchise_name || rowSnapshot.franchise_id || fid
          ),
          player_id: pid,
          player_name: safeStr(rowSnapshot.player_name),
          pos: posKeyFromRow(rowSnapshot),
          years_to_add: safeInt(
            (state.extensionSelections[key] && state.extensionSelections[key].years_to_add) || 1
          ),
          row_snapshot: rowSnapshot,
          at: Date.now(),
        };
        saveExtensionSelections(state.extensionSelections);
        openExtensionModal(key);
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

    // Tag selection buttons
    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-tag-action='1']") : null;
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const season = normalizeSeasonValue(btn.getAttribute("data-season") || state.selectedSeason);
        const side = safeStr(btn.getAttribute("data-tag-side") || "OFFENSE");
        const limit = Math.max(1, safeInt(btn.getAttribute("data-tag-limit") || 1));
        const fid = pad4(btn.getAttribute("data-franchise-id"));
        if (!canManageTagForFranchise(fid)) return;
        const franchiseName = safeStr(btn.getAttribute("data-franchise-name"));
        const pid = safeStr(btn.getAttribute("data-player-id"));
        const playerName = safeStr(btn.getAttribute("data-player-name"));
        const pos = safeStr(btn.getAttribute("data-pos"));
        const key = buildTagSelectionKey(season, fid, side);
        const existing = state.tagSelections[key];

        if (existing && safeStr(existing.player_id) === pid) {
          openTagModal(key);
          return;
        }

        if (existing && limit <= 1) {
          return;
        }

        state.tagSelections[key] = {
          league_id: safeStr(getLeagueId() || DEFAULT_LEAGUE_ID),
          season,
          franchise_id: fid,
          franchise_name: franchiseName,
          player_id: pid,
          player_name: playerName,
          pos,
          side,
          at: Date.now(),
        };
        if (state.tagSubmissions[key]) {
          delete state.tagSubmissions[key];
          saveTagSubmissions(state.tagSubmissions);
        }
        saveTagSelections(state.tagSelections);
        render();
        openTagModal(key);
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-tag-clear='1']") : null;
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const key = safeStr(btn.getAttribute("data-tag-key"));
        if (!key) return;
        delete state.tagSelections[key];
        saveTagSelections(state.tagSelections);
        render();
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-tag-clear-all='1']") : null;
        if (!btn) return;
        if (!state.commishMode) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        state.tagSelections = {};
        state.tagSubmissions = {};
        saveTagSelections(state.tagSelections);
        saveTagSubmissions(state.tagSubmissions);
        render();
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-tag-summary-view]") : null;
        if (!btn) return;
        const view = safeStr(btn.getAttribute("data-tag-summary-view"));
        state.tagSummaryView = view === "team" ? "team" : "pos";
        render();
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-tag-summary-side]") : null;
        if (!btn) return;
        const side = safeStr(btn.getAttribute("data-tag-summary-side"));
        state.tagSummarySide = normalizeTagSummarySide(side);
        render();
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-commish-view]") : null;
        if (!btn) return;
        if (!state.canCommishMode) return;
        const mode = safeStr(btn.getAttribute("data-commish-view")).toUpperCase();
        state.commishViewMode = ["A", "B", "C"].includes(mode) ? mode : "A";
        if (state.commishViewMode === "A") state.commishConsoleOpen = true;
        render();
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-commish-console-toggle]") : null;
        if (!btn) return;
        if (!state.canCommishMode) return;
        state.commishConsoleOpen = !state.commishConsoleOpen;
        render();
      },
      true
    );

    document.addEventListener("change", (e) => {
      const target = e.target;
      if (!target || !target.getAttribute) return;
      if (target.getAttribute("data-ppg-enabled") === "1") {
        state.ppgMinGamesEnabled = !!target.checked;
        savePpgSettings({
          minGames: state.ppgMinGames,
          enabled: state.ppgMinGamesEnabled,
        });
        render();
      }
      if (target.getAttribute("data-ppg-min") === "1") {
        const v = clampInt(target.value || state.ppgMinGames, 1, 18);
        state.ppgMinGames = v;
        savePpgSettings({
          minGames: state.ppgMinGames,
          enabled: state.ppgMinGamesEnabled,
        });
        render();
      }
      if (target.getAttribute("data-mym-submission-season") === "1") {
        state.mymSubmissionSeason = normalizeSeasonValue(target.value);
        render();
      }
      if (target.getAttribute("data-tag-submission-season") === "1") {
        const v = normalizeSeasonValue(target.value);
        state.tagSubmissionSeason = v;
        render();
      }
    });

    document.addEventListener(
      "click",
      (e) => {
        const btn =
          e.target && e.target.closest ? e.target.closest("[data-league-event-mode]") : null;
        if (!btn) return;
        const mode = safeStr(btn.getAttribute("data-league-event-mode")) === "date" ? "date" : "countdown";
        state.leagueEventMode = mode;
        const group = btn.parentElement;
        if (group) {
          Array.from(group.querySelectorAll("[data-league-event-mode]")).forEach((el) => {
            el.classList.toggle(
              "primary",
              safeStr(el.getAttribute("data-league-event-mode")) === mode
            );
          });
        }
        updateLeagueEventModule();
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

    const tagModal = $("#tagModal");
    if (tagModal) {
      tagModal.addEventListener("click", (e) => {
        const close = e.target && e.target.getAttribute && e.target.getAttribute("data-close");
        if (close === "1") closeTagModal();
      });
    }

    const extensionModal = $("#extensionModal");
    if (extensionModal) {
      extensionModal.addEventListener("click", (e) => {
        const close = e.target && e.target.getAttribute && e.target.getAttribute("data-close");
        if (close === "1") closeExtensionModal();
      });
    }

    const tagAckModal = $("#tagAckModal");
    if (tagAckModal) {
      tagAckModal.addEventListener("click", (e) => {
        const close = e.target && e.target.getAttribute && e.target.getAttribute("data-close");
        if (close === "1") closeTagAckModal();
      });
    }

    const devNoticeModal = $("#devNoticeModal");
    if (devNoticeModal) {
      devNoticeModal.addEventListener("click", (e) => {
        const close = e.target && e.target.closest ? e.target.closest("[data-close]") : null;
        if (close) {
          e.preventDefault();
          e.stopPropagation();
          closeDevNotice();
        }
      });
    }

    // Escape closes modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const modalElMym = $("#mymModal");
        const modalElRes = $("#restructureModal");
        const modalElTag = $("#tagModal");
        const modalElTagAck = $("#tagAckModal");
        const modalElExt = $("#extensionModal");
        const modalElDev = $("#devNoticeModal");
        if (modalElMym && modalElMym.classList.contains("is-open")) closeMYMModal();
        if (modalElRes && modalElRes.classList.contains("is-open")) closeRestructureModal();
        if (modalElTag && modalElTag.classList.contains("is-open")) closeTagModal();
        if (modalElTagAck && modalElTagAck.classList.contains("is-open")) closeTagAckModal();
        if (modalElExt && modalElExt.classList.contains("is-open")) closeExtensionModal();
        if (modalElDev && modalElDev.classList.contains("is-open")) closeDevNotice();
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

    const tagSubmitBtn = $("#tagSubmitBtn");
    if (tagSubmitBtn) tagSubmitBtn.addEventListener("click", () => submitTagSelection());

    const tagRemoveBtn = $("#tagRemoveBtn");
    if (tagRemoveBtn) tagRemoveBtn.addEventListener("click", () => removeTagSelection());

    const tagAckOkBtn = $("#tagAckOkBtn");
    if (tagAckOkBtn) tagAckOkBtn.addEventListener("click", () => closeTagAckModal());

    const extOption1Btn = $("#extOption1Btn");
    if (extOption1Btn) extOption1Btn.addEventListener("click", () => setExtensionYears(1));
    const extOption2Btn = $("#extOption2Btn");
    if (extOption2Btn) extOption2Btn.addEventListener("click", () => setExtensionYears(2));
    const extSubmitBtn = $("#extSubmitBtn");
    if (extSubmitBtn) extSubmitBtn.addEventListener("click", () => submitExtensionSelection());
    const extYear1Input = $("#extYear1Input");
    if (extYear1Input) extYear1Input.addEventListener("input", () => renderExtensionModalPreview());
    const extYear2Input = $("#extYear2Input");
    if (extYear2Input) extYear2Input.addEventListener("input", () => renderExtensionModalPreview());

    ["#rsTcvInput", "#rsYear1Input", "#rsYear2Input"].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener("input", () => renderRestructureModalSummary());
    });

    const rsSubmitBtn = $("#rsSubmitBtn");
    if (rsSubmitBtn) rsSubmitBtn.addEventListener("click", () => submitRestructureContract());
  }

  // ======================================================
  // IFRAME AUTO-HEIGHT (mobile scroll fix)
  // ======================================================
  function getDocHeight() {
    const body = document.body;
    const html = document.documentElement;
    const app = document.getElementById("cccApp");
    const appRect = app ? app.getBoundingClientRect() : null;
    const appBottom = appRect ? appRect.top + appRect.height + window.scrollY : 0;
    return Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      html ? html.clientHeight : 0,
      html ? html.scrollHeight : 0,
      html ? html.offsetHeight : 0,
      appBottom
    );
  }

  function startAutoHeightMessaging() {
    if (!window.parent || window.parent === window) return;

    let lastHeight = 0;
    let rafId = null;

    const send = () => {
      rafId = null;
      const height = Math.ceil(getDocHeight());
      if (!height || Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      window.parent.postMessage({ type: "ccc-height", height }, "*");
    };

    const schedule = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(send);
    };

    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("load", schedule);
    document.addEventListener("visibilitychange", schedule);

    if ("ResizeObserver" in window) {
      const ro = new ResizeObserver(schedule);
      if (document.body) ro.observe(document.body);
      const app = document.getElementById("cccApp");
      if (app) ro.observe(app);
    } else {
      window.setInterval(schedule, 500);
    }
  }

  // ======================================================
  // START
  // ======================================================
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      wireEvents();
      load();
      startAutoHeightMessaging();
      maybeShowDevNotice();
    });
  } else {
    wireEvents();
    load();
    startAutoHeightMessaging();
    maybeShowDevNotice();
  }
})();
