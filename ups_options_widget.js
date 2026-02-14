(function () {
  "use strict";

  const TIMEZONE = "America/New_York";
  const MFL_API_BASE = "https://api.myfantasyleague.com";
  const THEME_KEY = "uow_theme_v1";

  const EVENT_OVERRIDES = {
    "2026": {
      seasonStart: { month: 3, day: 1, hour: 0, minute: 0 },
      ownersMeeting: { month: 3, day: 19, hour: 21, minute: 0 },
      expiringDeadline: { month: 5, day: 21, hour: 12, minute: 0 },
      rookieDraft: { month: 5, day: 24, hour: 18, minute: 30 },
      cutDeadline: { month: 7, day: 29, hour: 12, minute: 0 },
    faAuction: { month: 7, day: 31, hour: 12, minute: 0 }
    }
  };

  const DEFAULT_PLAYOFF_END_WEEK = 17;
  const DEFAULT_REGULAR_END_WEEK = 14;

  const INLINE_SCHEDULES = {
    "2026": [
      { week: 1, kickoff: 1789086000 },
      { week: 2, kickoff: 1789690500 },
      { week: 3, kickoff: 1790295300 },
      { week: 4, kickoff: 1790900100 },
      { week: 5, kickoff: 1791504900 },
      { week: 6, kickoff: 1792109700 },
      { week: 7, kickoff: 1792714500 },
      { week: 8, kickoff: 1793319300 },
      { week: 9, kickoff: 1793927700 },
      { week: 10, kickoff: 1794532500 },
      { week: 11, kickoff: 1795137300 },
      { week: 12, kickoff: 1795742100 },
      { week: 13, kickoff: 1796320800 },
      { week: 14, kickoff: 1796951700 },
      { week: 15, kickoff: 1797556500 },
      { week: 16, kickoff: 1798161300 },
      { week: 17, kickoff: 1798740000 },
      { week: 18, kickoff: 1799530200 }
    ]
  };

  const PUBLIC_ASSETS_BASE = (function () {
    const script = document.currentScript;
    if (script && script.src) {
      try {
        const url = new URL(script.src, window.location.href);
        url.search = "";
        url.hash = "";
        return url.href.replace(/ups_options_widget\.js$/, "");
      } catch (e) {
        // fall through to default
      }
    }
    return "https://keithcreelman.github.io/ups-league-data/";
  })();

  const LOCAL_SCHEDULE_MANIFEST = {
    "2026": "ups_options_widget_schedule_2026.json"
  };

  const state = {
    mode: "countdown",
    selectedId: "",
    scheduleByYear: {},
    scheduleFetch: {},
    leagueDetailsByYear: {},
    leagueDetailsFetch: {},
    theme: loadThemeSetting(),
    manualSelection: false
  };

  const $ = (sel) => document.querySelector(sel);

  function normalizeThemeValue(value, allowAuto) {
    const v = String(value || "").toLowerCase();
    if (v === "light" || v === "dark") return v;
    return allowAuto ? "auto" : "";
  }

  function getThemeFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      return normalizeThemeValue(params.get("THEME") || params.get("theme"), false);
    } catch (e) {
      return "";
    }
  }

  function parseLeagueId() {
    const params = new URLSearchParams(window.location.search || "");
    const raw = params.get("L") || "";
    return raw || "74598";
  }

  function loadThemeSetting() {
    const forcedByQuery = getThemeFromQuery();
    if (forcedByQuery) return forcedByQuery;
    try {
      const raw = localStorage.getItem(THEME_KEY);
      if (!raw) return "auto";
      return normalizeThemeValue(raw, true);
    } catch (e) {
      return "auto";
    }
  }

  function saveThemeSetting(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
  }

  function applyThemeSetting(theme) {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const sanitized = normalizeThemeValue(theme, true);
    const next = sanitized === "auto" ? (prefersDark ? "dark" : "light") : sanitized;
    document.body.setAttribute("data-theme", next);
    const themeSelect = $("#themeSelect");
    if (themeSelect && themeSelect.value !== sanitized) themeSelect.value = sanitized;
  }

  function applyHostTheme(theme) {
    const forced = normalizeThemeValue(theme, false);
    if (!forced) return;
    state.theme = forced;
    saveThemeSetting(state.theme);
    applyThemeSetting(state.theme);
    notifyParentTheme(state.theme);
  }

  function wireThemeListener() {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (state.theme === "auto") applyThemeSetting("auto");
    };
    if (media.addEventListener) {
      media.addEventListener("change", handler);
    } else if (media.addListener) {
      media.addListener(handler);
    }
  }

  function notifyParentTheme(theme) {
    if (!window.parent || window.parent === window) return;
    const t = normalizeThemeValue(theme, true);
    try {
      window.parent.postMessage({ type: "uow-theme", theme: t }, "*");
    } catch (e) {}
  }

  function wireHostThemeMessages() {
    window.addEventListener("message", (e) => {
      const data = e && e.data ? e.data : {};
      if (!data || data.type !== "ups-theme") return;
      applyHostTheme(data.mode || data.theme || "");
    });
  }

  function safeInt(x) {
    const n = parseInt(String(x).replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function parseSeasonYear() {
    const params = new URLSearchParams(window.location.search || "");
    const raw = params.get("YEAR") || "";
    const match = raw.match(/\d{4}/);
    if (match) return safeInt(match[0]);
    return new Date().getFullYear();
  }

  function getNow() {
    return new Date();
  }

  function makeZonedDate(year, month, day, hour, minute) {
    const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    const asTz = new Date(utc.toLocaleString("en-US", { timeZone: TIMEZONE }));
    const offset = utc.getTime() - asTz.getTime();
    return new Date(utc.getTime() + offset);
  }

  function toTimeZoneDate(d) {
    if (!d || Number.isNaN(d.getTime())) return null;
    return new Date(d.toLocaleString("en-US", { timeZone: TIMEZONE }));
  }

  function addDays(d, days) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + days);
    return out;
  }

  function getMemorialDay(year) {
    const d = new Date(year, 4, 31, 12, 0, 0, 0);
    const day = d.getDay();
    const offset = (day + 6) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }

  function getLastWeekdayOfMonth(year, monthIndex, weekday) {
    const d = new Date(year, monthIndex + 1, 0, 12, 0, 0, 0);
    const day = d.getDay();
    const offset = (day - weekday + 7) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }

  function getThanksgivingDate(year) {
    const first = new Date(year, 10, 1, 12, 0, 0, 0);
    const firstDay = first.getDay();
    const offset = (4 - firstDay + 7) % 7;
    first.setDate(first.getDate() + offset);
    first.setDate(first.getDate() + 21);
    return first;
  }

  function formatCountdown(diffMs) {
    if (!Number.isFinite(diffMs)) return "TBD";
    const totalSeconds = Math.floor(Math.abs(diffMs) / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(" ");
  }

  function formatDate(d) {
    if (!d || Number.isNaN(d.getTime())) return "TBD";
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit"
    });
    return `${fmt.format(d)} ET`;
  }

  function ymdInTz(d) {
    if (!d || Number.isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);
    const map = {};
    parts.forEach((p) => (map[p.type] = p.value));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function getOverride(id, year) {
    const yearKey = String(year);
    const table = EVENT_OVERRIDES[yearKey];
    return table ? table[id] : null;
  }

  function resolveFixedDate(id, year, now, fallbackFn) {
    const override = getOverride(id, year);
    let date = override
      ? makeZonedDate(year, override.month, override.day, override.hour, override.minute)
      : fallbackFn(year);
    if (date && date.getTime() < now.getTime()) {
      const nextYear = year + 1;
      const nextOverride = getOverride(id, nextYear);
      date = nextOverride
        ? makeZonedDate(nextYear, nextOverride.month, nextOverride.day, nextOverride.hour, nextOverride.minute)
        : fallbackFn(nextYear);
    }
    return date;
  }

  function buildScheduleUrl(year) {
    return `${MFL_API_BASE}/${encodeURIComponent(year)}/export?TYPE=nflSchedule&W=ALL&JSON=1`;
  }

  function buildLeagueDetailsUrl(year, leagueId) {
    return `${MFL_API_BASE}/${encodeURIComponent(year)}/export?TYPE=league&L=${encodeURIComponent(leagueId)}&JSON=1`;
  }

  function extractLeagueWeeks(data) {
    if (!data) return null;
    const league = data.league || data.leagueDetails || data;
    if (!league || typeof league !== "object") return null;
    const endWeek = safeInt(league.end_week || league.endWeek || league.end_week_id || league.endWeekId);
    const lastRegular = safeInt(
      league.last_regular_season_week ||
        league.lastRegularSeasonWeek ||
        league.regular_season_end_week ||
        league.regularSeasonEndWeek
    );
    return { endWeek, lastRegularWeek: lastRegular };
  }

  async function fetchLeagueDetails(year, leagueId) {
    const y = String(year);
    if (state.leagueDetailsFetch[y]) return;
    state.leagueDetailsFetch[y] = true;
    try {
      const res = await fetch(buildLeagueDetailsUrl(y, leagueId), { cache: "no-store" });
      if (!res.ok) throw new Error(`League HTTP ${res.status}`);
      const data = await res.json();
      const info = extractLeagueWeeks(data);
      state.leagueDetailsByYear[y] = info || {};
    } catch (e) {
      state.leagueDetailsByYear[y] = { error: e && e.message ? e.message : String(e) };
    } finally {
      updateDisplay();
    }
  }

  function getLeagueWeekConfig(year, leagueId) {
    const y = String(year);
    const cached = state.leagueDetailsByYear[y];
    if (!cached && !state.leagueDetailsFetch[y]) fetchLeagueDetails(y, leagueId);
    return cached || null;
  }

  function parseKickoffToDate(val) {
    if (val === null || val === undefined) return null;
    const raw = String(val).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (!Number.isNaN(n)) {
        if (raw.length >= 13) return new Date(n);
        if (raw.length >= 10) return new Date(n * 1000);
      }
    }
    const t = raw.replace(" ", "T");
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00` : t;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
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

  function extractWeekKickoffs(scheduleData) {
    const entries = [];
    collectKickoffEntries(scheduleData, entries);
    const map = new Map();
    entries.forEach((entry) => {
      const week = safeInt(entry && entry.week);
      const kickoff = parseKickoffToDate(entry && entry.kickoff);
      if (!week || !kickoff || Number.isNaN(kickoff.getTime())) return;
      const existing = map.get(week);
      if (!existing || kickoff.getTime() < existing.getTime()) {
        map.set(week, kickoff);
      }
    });
    const out = Array.from(map.entries()).map(([week, kickoff]) => ({ week, kickoff }));
    out.sort((a, b) => a.week - b.week);
    return out;
  }

  function getScheduleMaxWeek(year) {
    const weeks = getWeekKickoffs(year);
    if (!weeks || !weeks.length) return 0;
    return weeks.reduce((max, entry) => Math.max(max, safeInt(entry && entry.week)), 0);
  }

  async function loadLocalSchedule(year) {
    const key = String(year);
    const inline = INLINE_SCHEDULES[key];
    if (inline) {
      return inline
        .map((item) => {
          const week = safeInt(item && item.week);
          const kickoff = parseKickoffToDate(item && item.kickoff);
          return week && kickoff ? { week, kickoff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.week - b.week);
    }
    const manifestPath = LOCAL_SCHEDULE_MANIFEST[key];
    if (!manifestPath) return null;
    try {
      const res = await fetch(PUBLIC_ASSETS_BASE + manifestPath, { cache: "no-store" });
      if (!res.ok) throw new Error(`Local schedule HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.weekKickoffs)) return null;
      const parsed = data.weekKickoffs
        .map((item) => {
          const week = safeInt(item && item.week);
          const kickoff = parseKickoffToDate(item && item.kickoff);
          return week && kickoff ? { week, kickoff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.week - b.week);
      return parsed.length ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  async function applyScheduleFallback(year) {
    const y = String(year);
    const fallback = await loadLocalSchedule(year);
    if (fallback && fallback.length) {
      state.scheduleByYear[y] = { weekKickoffs: fallback };
      updateDisplay();
    }
  }

  async function fetchSchedule(year) {
    const y = String(year);
    if (state.scheduleFetch[y]) return;
    state.scheduleFetch[y] = true;
    try {
      const res = await fetch(buildScheduleUrl(y), { cache: "no-store" });
      if (!res.ok) throw new Error(`Schedule HTTP ${res.status}`);
      const data = await res.json();
      state.scheduleByYear[y] = { weekKickoffs: extractWeekKickoffs(data) };
    } catch (e) {
      state.scheduleByYear[y] = { weekKickoffs: [], error: e && e.message ? e.message : String(e) };
      applyScheduleFallback(year);
    } finally {
      updateDisplay();
    }
  }

  function getWeekKickoffs(year) {
    const y = String(year);
    const cached = state.scheduleByYear[y];
    if (cached && cached.weekKickoffs) return cached.weekKickoffs;

    // Try inline/local immediately
    const inline = INLINE_SCHEDULES[y];
    if (inline) {
      const parsed = inline
        .map((item) => {
          const week = safeInt(item && item.week);
          const kickoff = parseKickoffToDate(item && item.kickoff);
          return week && kickoff ? { week, kickoff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.week - b.week);
      if (parsed.length) {
        state.scheduleByYear[y] = { weekKickoffs: parsed, inline: true };
        if (!state.scheduleFetch[y]) fetchSchedule(y); // still fetch live for freshness
        return parsed;
      }
    }

    if (!cached && !state.scheduleFetch[y]) fetchSchedule(y);
    return null;
  }

  function computeWeekStart(kickoffDate) {
    const local = toTimeZoneDate(kickoffDate);
    if (!local) return null;
    const day = local.getDay();
    const daysBack = (day - 2 + 7) % 7;
    local.setDate(local.getDate() - daysBack);
    local.setHours(0, 0, 0, 0);
    return local;
  }

  function resolveNextKickoffInfo(year, now) {
    const y = safeInt(year);
    const nowTz = toTimeZoneDate(now) || now;
    const tryYear = (yy) => {
      const weeks = getWeekKickoffs(yy);
      if (!weeks || !weeks.length) return null;
      const sorted = weeks.slice().sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
      let candidate = null;
      sorted.forEach((w) => {
        if (!w || !w.kickoff || Number.isNaN(w.kickoff.getTime())) return;
        const start = computeWeekStart(w.kickoff);
        if (!start) return;
        if (start.getTime() <= nowTz.getTime()) candidate = w;
      });
      if (candidate) return { week: candidate.week, kickoff: candidate.kickoff, season: yy };
      return sorted[0] ? { week: sorted[0].week, kickoff: sorted[0].kickoff, season: yy } : null;
    };

    return tryYear(y) || tryYear(y + 1);
  }

  function resolveWeekKickoff(year, week) {
    const weeks = getWeekKickoffs(year);
    if (!weeks || !weeks.length) return null;
    const entry = weeks.find((w) => safeInt(w.week) === safeInt(week));
    return entry && entry.kickoff ? entry.kickoff : null;
  }

  function computePriorSunday(kickoffDate) {
    if (!kickoffDate || Number.isNaN(kickoffDate.getTime())) return null;
    const base = new Date(kickoffDate.getTime());
    base.setHours(12, 0, 0, 0);
    const day = base.getDay();
    const daysBack = day === 0 ? 7 : day;
    return addDays(base, -daysBack);
  }

  function resolveContractDeadline(year) {
    const weeks = getWeekKickoffs(year);
    if (!weeks || !weeks.length) return null;
    const week1 = weeks.find((w) => safeInt(w.week) === 1);
    if (!week1 || !week1.kickoff) return null;
    return computePriorSunday(week1.kickoff);
  }

  function resolveTradeDeadline(year) {
    const thanksgiving = getThanksgivingDate(year);
    const weeks = getWeekKickoffs(year);
    if (weeks && weeks.length) {
      const target = ymdInTz(thanksgiving);
      const match = weeks
        .map((w) => w.kickoff)
        .filter((d) => d && ymdInTz(d) === target)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      if (match) return match;
    }
    return thanksgiving;
  }

  function resolveActiveSeasonYear(baseYear, now) {
    const currentYear = now.getFullYear();
    const seedYear = Math.max(baseYear, currentYear);
    const week1Seed = resolveWeekKickoff(seedYear, 1);
    if (week1Seed && week1Seed.getTime() >= now.getTime()) return seedYear;
    const week1Next = resolveWeekKickoff(seedYear + 1, 1);
    if (week1Next) return seedYear + 1;
    return seedYear;
  }

  function buildEvents() {
    const now = getNow();
    const baseYear = parseSeasonYear();
    const seasonYear = resolveActiveSeasonYear(baseYear, now);

    const faFallback = (year) => makeZonedDate(year, 7, getLastWeekdayOfMonth(year, 6, 6).getDate(), 12, 0);
    const scheduleMaxWeek = getScheduleMaxWeek(seasonYear);
    const fallbackRegularWeek = Math.max(
      1,
      scheduleMaxWeek ? Math.min(scheduleMaxWeek, DEFAULT_REGULAR_END_WEEK) : DEFAULT_REGULAR_END_WEEK
    );
    const fallbackPlayoffWeek = Math.max(
      fallbackRegularWeek + 1,
      scheduleMaxWeek ? Math.min(scheduleMaxWeek, DEFAULT_PLAYOFF_END_WEEK) : DEFAULT_PLAYOFF_END_WEEK
    );
    let regularWeek = fallbackRegularWeek;
    let endWeek = fallbackPlayoffWeek;
    regularWeek = Math.min(regularWeek, Math.max(1, endWeek - 1));
    endWeek = Math.max(endWeek, regularWeek + 1, fallbackPlayoffWeek);

    const events = [
      {
        id: "seasonStart",
        label: "Start of UPS Season",
        date: resolveFixedDate("seasonStart", seasonYear, now, (y) => makeZonedDate(y, 3, 1, 0, 0)),
        hint: "March 1"
      },
      {
        id: "ownersMeeting",
        label: "Annual Owner's Meeting",
        date: resolveFixedDate("ownersMeeting", seasonYear, now, (y) => makeZonedDate(y, 3, 19, 21, 0)),
        hint: "March 19, 9:00 PM ET"
      },
      {
        id: "expiringDeadline",
        label: "Expiring Rookie Extension/Tagged Player Deadline",
        date: resolveFixedDate("expiringDeadline", seasonYear, now, (y) => makeZonedDate(y, 4, 30, 12, 0)),
        hint: "Deadline time ET"
      },
      {
        id: "rookieDraft",
        label: "Rookie Draft",
        date: resolveFixedDate("rookieDraft", seasonYear, now, (y) => {
          const memorial = getMemorialDay(y);
          const draft = addDays(memorial, -1);
          draft.setHours(18, 30, 0, 0);
          return draft;
        }),
        hint: "Memorial Day weekend"
      },
      {
        id: "cutDeadline",
        label: "Deadline to Cut Players",
        date: resolveFixedDate("cutDeadline", seasonYear, now, (y) => {
          const fa = faFallback(y);
          return addDays(fa, -2);
        }),
        hint: "Offseason roster lock"
      },
      {
        id: "faAuction",
        label: "FA Auction",
        date: resolveFixedDate("faAuction", seasonYear, now, faFallback),
        hint: "Auction kickoff"
      }
    ];

    const kickoffInfo = resolveNextKickoffInfo(seasonYear, now);
    events.push({
      id: "contractDeadline",
      label: "Contract Deadline",
      date: resolveContractDeadline(seasonYear),
      hint: "Last Sunday before Week 1"
    });

    events.push({
      id: "weekKickoff",
      label: kickoffInfo && kickoffInfo.week ? `Week ${kickoffInfo.week} - NFL` : "Week 1 - NFL",
      date: kickoffInfo ? kickoffInfo.kickoff : null,
      hint: "Next kickoff (rolls Tuesday)"
    });

    events.push({
      id: "tradeDeadline",
      label: "Trade Deadline",
      date: resolveTradeDeadline(seasonYear),
      hint: "Thanksgiving kickoff"
    });

    events.push({
      id: "regularSeasonEnd",
      label: "End of UPS Regular Season",
      date: resolveWeekKickoff(seasonYear, regularWeek),
      hint: `Week ${regularWeek} kickoff`
    });

    const playoffEndKickoff = resolveWeekKickoff(seasonYear, endWeek);

    events.push({
      id: "playoffsEnd",
      label: "End of UPS Playoffs",
      date: playoffEndKickoff,
      hint: `Week ${endWeek} kickoff`
    });

    return { events, now };
  }

  function pickNextEventId(events, now) {
    const candidates = (events || []).filter((e) => e && e.date && !Number.isNaN(e.date.getTime()));
    candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
    const next = candidates.find((e) => e.date.getTime() >= now.getTime());
    const pick = next || candidates[0] || events[0];
    return pick ? pick.id : "";
  }

  function syncSelection(events, now) {
    if (!state.selectedId) {
      state.selectedId = pickNextEventId(events, now);
      return;
    }
    const current = events.find((e) => e.id === state.selectedId);
    const hasValidDate = current && current.date && !Number.isNaN(current.date.getTime());
    const isManual = state.manualSelection;
    if (!hasValidDate) {
      if (!isManual) {
        state.selectedId = pickNextEventId(events, now);
        state.manualSelection = false;
      }
      return;
    }
    if (!isManual && current.date.getTime() < now.getTime()) {
      state.selectedId = pickNextEventId(events, now);
      state.manualSelection = false;
    }
  }

  function populateOptions(selectEl, events) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    (events || []).forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.label;
      opt.selected = e.id === state.selectedId;
      selectEl.appendChild(opt);
    });
  }

  function updateDisplay() {
    const payload = buildEvents();
    const events = payload.events;
    const now = payload.now;
    syncSelection(events, now);

    const selectEl = $("#eventSelect");
    if (selectEl && !selectEl.options.length) {
      populateOptions(selectEl, events);
    }

    const current = events.find((e) => e.id === state.selectedId) || events[0];
    const dateText = current && current.date ? formatDate(current.date) : "TBD";
    const diffMs = current && current.date ? current.date.getTime() - now.getTime() : NaN;
    const rawCountdown = current && current.date ? formatCountdown(diffMs) : "TBD";
    const isPast = current && current.date && diffMs < 0;
    const countdownText = rawCountdown === "TBD" ? "TBD" : isPast ? `${rawCountdown} Ago` : rawCountdown;
    const primary = state.mode === "date" ? dateText : countdownText;
    const secondary = state.mode === "date" ? countdownText : dateText;

    const labelEl = $("#eventLabel");
    const valueEl = $("#eventValue");
    const hintEl = $("#eventHint");
    if (labelEl) labelEl.textContent = current ? current.label : "Event";
    if (valueEl) valueEl.textContent = primary;
    if (hintEl) {
      const parts = [];
      parts.push(`${state.mode === "date" ? "Countdown" : "Date"}: ${secondary}`);
      if (current && current.hint) parts.push(current.hint);
      hintEl.textContent = parts.join(" | ");
    }

    if (selectEl) {
      const option = selectEl.querySelector(`option[value="${state.selectedId}"]`);
      if (option && current && option.textContent !== current.label) option.textContent = current.label;
      if (selectEl.value !== state.selectedId) selectEl.value = state.selectedId;
    }
  }

  function wireEvents() {
    const themeSelect = $("#themeSelect");
    if (themeSelect) {
      themeSelect.value = state.theme;
      themeSelect.addEventListener("change", (e) => {
        state.theme = normalizeThemeValue(e.target.value || "auto", true);
        saveThemeSetting(state.theme);
        applyThemeSetting(state.theme);
        notifyParentTheme(state.theme);
      });
    }

    const selectEl = $("#eventSelect");
    if (selectEl) {
      selectEl.addEventListener("change", (e) => {
        state.selectedId = String(e.target.value || "");
        state.manualSelection = true;
        updateDisplay();
      });
    }

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode") === "date" ? "date" : "countdown";
        state.mode = mode;
        document.querySelectorAll("[data-mode]").forEach((el) => {
          el.classList.toggle("active", el.getAttribute("data-mode") === mode);
        });
        updateDisplay();
      });
    });
  }

  function startTicker() {
    updateDisplay();
    window.setInterval(updateDisplay, 60000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateDisplay();
    });
  }

  function getDocHeight() {
    const body = document.body;
    const html = document.documentElement;
    const app = document.getElementById("uowApp");
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
      window.parent.postMessage({ type: "uow-height", height }, "*");
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
      const app = document.getElementById("uowApp");
      if (app) ro.observe(app);
    } else {
      window.setInterval(schedule, 500);
    }
  }

  function init() {
    const parsedYear = parseSeasonYear();
    const year = Math.max(parsedYear, new Date().getFullYear());
    const leagueId = parseLeagueId();
    applyThemeSetting(state.theme);
    wireThemeListener();
    wireHostThemeMessages();
    notifyParentTheme(state.theme);
    applyScheduleFallback(year);
    applyScheduleFallback(year + 1);
    fetchSchedule(year);
    fetchSchedule(year + 1);
    fetchLeagueDetails(year, leagueId);
    fetchLeagueDetails(year + 1, leagueId);
    wireEvents();
    startTicker();
    startAutoHeightMessaging();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
