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

  const u = getUrl();
  const L = getLeagueId(u);
  const YEAR = getYear(u);
  const FRANCHISE_ID = getFranchiseId(u);
  const DEBUG_ADMIN =
    (u && (u.searchParams.get("DEBUG_ADMIN") || u.searchParams.get("DEBUG"))) || "";

  const LATEST_JSON_URL = "https://keithcreelman.github.io/ups-league-data/ccc_latest.json";
  const LATEST_JS_URL = "https://keithcreelman.github.io/ups-league-data/ccc_latest.js";
  const DEFAULT_CACHE = "20260214l";

  let mount = document.getElementById("cccMount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "cccMount";
    document.body.appendChild(mount);
  }

  function buildSrc(cacheKey) {
    const cache = cacheKey || DEFAULT_CACHE;
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
    iframe.src = buildSrc(cacheKey);
  });

  function onMessage(e) {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    if (e.origin !== "https://keithcreelman.github.io") return;
    const data = e.data || {};
    if (!data || data.type !== "ccc-height") return;
    const next = Number(data.height);
    if (!Number.isFinite(next) || next <= 0) return;
    const clamped = Math.max(600, Math.min(20000, Math.ceil(next)));
    iframe.style.height = String(clamped) + "px";
  }

  window.addEventListener("message", onMessage, false);
})();
