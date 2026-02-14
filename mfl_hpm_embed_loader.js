(function () {
  "use strict";

  function pad4(v) {
    const d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }

  function getUrl() {
    try {
      return new URL(window.location.href);
    } catch (e) {
      return null;
    }
  }

  function getLeagueId(u) {
    if (!u) return "74598";
    const q = u.searchParams.get("L");
    if (q) return q;
    const m = String(window.location.pathname || "").match(/\/home\/(\d+)(?:\/|$)/i);
    return m ? m[1] : "74598";
  }

  function getYear(u) {
    if (!u) return "2025";
    const q = u.searchParams.get("YEAR");
    if (q) return q;
    const m = String(window.location.pathname || "").match(/\/(\d{4})\//);
    return m ? m[1] : "2025";
  }

  function getFranchiseId(u) {
    const globals = [
      window.FRANCHISE_ID,
      window.franchise_id,
      window.franchiseId,
      window.fid,
    ];
    for (const g of globals) {
      const p = pad4(g);
      if (p) return p;
    }

    if (u) {
      const q = pad4(
        u.searchParams.get("FRANCHISE_ID") ||
          u.searchParams.get("FRANCHISE") ||
          u.searchParams.get("F") ||
          u.searchParams.get("FR")
      );
      if (q) return q;
    }

    const m = String(window.location.pathname || "").match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
    return m ? pad4(m[1]) : "";
  }

  function normalizeMode(v) {
    return String(v || "").toLowerCase() === "light" ? "light" : "dark";
  }

  function normalizeExplicitMode(v) {
    const mode = String(v || "").toLowerCase();
    return mode === "light" || mode === "dark" ? mode : "";
  }

  const u = getUrl();
  const L = getLeagueId(u);
  const YEAR = getYear(u);
  const FRANCHISE_ID = getFranchiseId(u);
  const MODE_KEY = "ups_mode_" + YEAR + "_" + L;
  const DEBUG_ADMIN =
    (u && (u.searchParams.get("DEBUG_ADMIN") || u.searchParams.get("DEBUG"))) || "";

  const LATEST_JSON_URL = "https://keithcreelman.github.io/ups-league-data/ccc_latest.json";
  const LATEST_JS_URL = "https://keithcreelman.github.io/ups-league-data/ccc_latest.js";
  const DEFAULT_CACHE = "20260214o";

  function inferModeFromSystem() {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  }

  function getHostMode() {
    if (typeof window.getUPSMode === "function") return normalizeMode(window.getUPSMode());
    const attr = document.documentElement.getAttribute("data-ups-mode");
    if (attr) return normalizeMode(attr);
    try {
      const stored = localStorage.getItem(MODE_KEY);
      if (stored) return normalizeMode(stored);
    } catch (e) {}
    return inferModeFromSystem();
  }

  function setHostMode(mode, persist) {
    const next = normalizeExplicitMode(mode);
    if (!next) return;
    if (typeof window.setUPSMode === "function") {
      window.setUPSMode(next);
      return;
    }
    document.documentElement.setAttribute("data-ups-mode", next);
    document.documentElement.style.colorScheme = next;
    if (persist) {
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch (e) {}
    }
    try {
      document.dispatchEvent(new CustomEvent("ups-theme-change", { detail: { mode: next } }));
    } catch (e) {}
  }

  let mount = document.getElementById("cccMount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "cccMount";
    document.body.appendChild(mount);
  }

  function buildSrc(cacheKey, mode) {
    const cache = cacheKey || DEFAULT_CACHE;
    const theme = normalizeMode(mode || getHostMode());
    return (
      "https://keithcreelman.github.io/ups-league-data/mfl_hpm16_contractcommandcenter.html" +
      "?cache=" +
      encodeURIComponent(cache) +
      "&L=" +
      encodeURIComponent(L) +
      "&YEAR=" +
      encodeURIComponent(YEAR) +
      "&FRANCHISE_ID=" +
      encodeURIComponent(FRANCHISE_ID) +
      "&THEME=" +
      encodeURIComponent(theme) +
      (DEBUG_ADMIN ? "&DEBUG_ADMIN=" + encodeURIComponent(DEBUG_ADMIN) : "")
    );
  }

  function resolveLatestCache(cb) {
    let done = false;
    const finish = (cacheKey) => {
      if (done) return;
      done = true;
      cb(cacheKey || DEFAULT_CACHE);
    };

    try {
      fetch(LATEST_JSON_URL, { cache: "no-store" })
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data) => {
          const v = data && (data.cache || data.version || data.v);
          if (v) finish(String(v));
          else throw new Error("Missing version");
        })
        .catch(() => {
          const s = document.createElement("script");
          s.src = LATEST_JS_URL + "?v=" + Date.now();
          s.onload = () => {
            const v = window.CCC_LATEST_VERSION || window.CCC_CACHE || "";
            finish(v);
          };
          s.onerror = () => finish(DEFAULT_CACHE);
          (document.head || document.documentElement).appendChild(s);
        });
    } catch (e) {
      finish(DEFAULT_CACHE);
    }

    setTimeout(() => finish(DEFAULT_CACHE), 3000);
  }

  mount.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "1400px";
  iframe.style.border = "0";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("scrolling", "no");
  mount.appendChild(iframe);

  resolveLatestCache((cacheKey) => {
    iframe.src = buildSrc(cacheKey, getHostMode());
  });

  function syncIframeTheme(mode) {
    const nextMode = normalizeMode(mode || getHostMode());
    const srcAttr = iframe.getAttribute("src");
    if (srcAttr) {
      try {
        const src = new URL(srcAttr, window.location.href);
        const before = src.toString();
        src.searchParams.set("THEME", nextMode);
        src.searchParams.set("theme", nextMode);
        const after = src.toString();
        if (after !== before) iframe.src = after;
      } catch (e) {}
    }
    if (iframe.contentWindow) {
      try {
        iframe.contentWindow.postMessage({ type: "ups-theme", mode: nextMode }, "*");
      } catch (e) {}
    }
  }

  iframe.addEventListener("load", () => {
    syncIframeTheme(getHostMode());
  });

  function onMessage(e) {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    if (e.origin !== "https://keithcreelman.github.io") return;
    const data = e.data || {};
    if (!data) return;
    if (data.type === "ccc-height") {
      const next = Number(data.height);
      if (!Number.isFinite(next) || next <= 0) return;
      const clamped = Math.max(600, Math.min(20000, Math.ceil(next)));
      iframe.style.height = String(clamped) + "px";
      return;
    }
    if (data.type === "ccc-theme") {
      setHostMode(data.theme || data.mode || "", true);
      return;
    }
  }

  window.addEventListener("message", onMessage, false);
  document.addEventListener("ups-theme-change", function (ev) {
    const mode = normalizeMode(ev && ev.detail ? ev.detail.mode : getHostMode());
    syncIframeTheme(mode);
  });
})();
