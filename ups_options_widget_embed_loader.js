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
  const MODE_KEY = "ups_mode_" + YEAR + "_" + L;

  const LATEST_JSON_URL = "https://keithcreelman.github.io/ups-league-data/ups_options_widget_latest.json";
  const LATEST_JS_URL = "https://keithcreelman.github.io/ups-league-data/ups_options_widget_latest.js";
  const DEFAULT_CACHE = "20260214a";

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

  function toggleHostMode() {
    if (typeof window.toggleUPSMode === "function") {
      window.toggleUPSMode();
      return;
    }
    const mode = getHostMode();
    setHostMode(mode === "dark" ? "light" : "dark", true);
  }

  function ensureLoaderStyles() {
    if (document.getElementById("uowThemeToggleStyles")) return;
    const style = document.createElement("style");
    style.id = "uowThemeToggleStyles";
    style.textContent =
      ".uow-theme-toolbar{margin:.45rem 0 .35rem;display:flex;justify-content:flex-end}" +
      ".uow-theme-toggle{border:1px solid var(--ups-chip-border,#3a5f89);background:var(--ups-chip-bg,#10213a);color:var(--ups-chip-text,#e8effa);border-radius:10px;font:800 .8rem/1 inherit;padding:.5rem .7rem;cursor:pointer;display:inline-flex;align-items:center;gap:.4rem}" +
      ".uow-theme-toggle:hover,.uow-theme-toggle:focus{border-color:var(--ups-chip-hover-border,#8fb7ef);background:var(--ups-chip-hover-bg,#1c3f70);color:var(--ups-text,#f3f8ff)}" +
      "#uowMount{border:1px solid var(--ups-border,#27476f);background:var(--ups-surface,#111b2e);border-radius:12px;padding:.35rem}";
    (document.head || document.documentElement).appendChild(style);
  }

  let mount = document.getElementById("uowMount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "uowMount";
    document.body.appendChild(mount);
  }

  function ensureToggleUi() {
    ensureLoaderStyles();
    let toolbar = mount.previousElementSibling;
    if (!toolbar || !toolbar.classList || !toolbar.classList.contains("uow-theme-toolbar")) {
      toolbar = document.createElement("div");
      toolbar.className = "uow-theme-toolbar";
      toolbar.innerHTML =
        '<button type="button" id="uowThemeToggleBtn" class="uow-theme-toggle" aria-pressed="false">' +
        '<span aria-hidden="true">\u25D0</span><span id="uowThemeToggleLabel">Theme: Dark</span></button>';
      mount.parentNode.insertBefore(toolbar, mount);
    }
    const btn = document.getElementById("uowThemeToggleBtn");
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", toggleHostMode);
    }
    updateToggleUi();
  }

  function updateToggleUi() {
    const mode = getHostMode();
    const btn = document.getElementById("uowThemeToggleBtn");
    const label = document.getElementById("uowThemeToggleLabel");
    if (label) label.textContent = mode === "dark" ? "Theme: Dark" : "Theme: Light";
    if (btn) {
      btn.setAttribute("aria-pressed", mode === "light" ? "true" : "false");
      btn.setAttribute("title", mode === "dark" ? "Switch to light mode" : "Switch to dark mode");
    }
  }

  function buildSrc(cacheKey, mode) {
    const cache = cacheKey || DEFAULT_CACHE;
    const theme = normalizeMode(mode || getHostMode());
    return (
      "https://keithcreelman.github.io/ups-league-data/ups_options_widget.html" +
      "?cache=" +
      encodeURIComponent(cache) +
      "&L=" +
      encodeURIComponent(L) +
      "&YEAR=" +
      encodeURIComponent(YEAR) +
      "&THEME=" +
      encodeURIComponent(theme)
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

  function postThemeToWidget(iframe, mode) {
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: "ups-theme", mode: normalizeMode(mode) }, "*");
    } catch (e) {}
  }

  function syncIframeTheme(iframe, mode) {
    if (!iframe) return;
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
    postThemeToWidget(iframe, nextMode);
  }

  mount.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "480px";
  iframe.style.border = "0";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("scrolling", "no");
  mount.appendChild(iframe);

  ensureToggleUi();

  resolveLatestCache((cacheKey) => {
    iframe.src = buildSrc(cacheKey, getHostMode());
  });

  iframe.addEventListener("load", () => {
    syncIframeTheme(iframe, getHostMode());
  });

  function onMessage(e) {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    if (e.origin !== "https://keithcreelman.github.io") return;
    const data = e.data || {};
    if (!data) return;

    if (data.type === "uow-height") {
      const next = Number(data.height);
      if (!Number.isFinite(next) || next <= 0) return;
      const clamped = Math.max(280, Math.min(20000, Math.ceil(next)));
      iframe.style.height = String(clamped) + "px";
      return;
    }

    if (data.type === "uow-theme") {
      setHostMode(data.theme || data.mode || "", true);
      updateToggleUi();
      return;
    }
  }

  window.addEventListener("message", onMessage, false);
  document.addEventListener("ups-theme-change", function (ev) {
    const mode = normalizeMode(ev && ev.detail ? ev.detail.mode : getHostMode());
    updateToggleUi();
    syncIframeTheme(iframe, mode);
  });
})();
