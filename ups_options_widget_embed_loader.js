(function () {
  "use strict";

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
    if (!u) return String(new Date().getFullYear());
    const q = u.searchParams.get("YEAR");
    if (q) return q;
    const m = String(window.location.pathname || "").match(/\/(\d{4})\//);
    return m ? m[1] : String(new Date().getFullYear());
  }

  const u = getUrl();
  const L = getLeagueId(u);
  const YEAR = getYear(u);

  const LATEST_JSON_URL = "https://keithcreelman.github.io/ups-league-data/ups_options_widget_latest.json";
  const LATEST_JS_URL = "https://keithcreelman.github.io/ups-league-data/ups_options_widget_latest.js";
  const DEFAULT_CACHE = "20260207aw";

  let mount = document.getElementById("uowMount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "uowMount";
    document.body.appendChild(mount);
  }

  function buildSrc(cacheKey) {
    const cache = cacheKey || DEFAULT_CACHE;
    return (
      "https://keithcreelman.github.io/ups-league-data/ups_options_widget.html" +
      "?cache=" +
      encodeURIComponent(cache) +
      "&L=" +
      encodeURIComponent(L) +
      "&YEAR=" +
      encodeURIComponent(YEAR)
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
            const v = window.UOW_LATEST_VERSION || "";
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
  iframe.style.height = "900px";
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
    if (!data || data.type !== "uow-height") return;
    const next = Number(data.height);
    if (!Number.isFinite(next) || next <= 0) return;
    const clamped = Math.max(400, Math.min(20000, Math.ceil(next)));
    iframe.style.height = String(clamped) + "px";
  }

  window.addEventListener("message", onMessage, false);
})();
