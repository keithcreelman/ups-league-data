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

  const src =
    "https://keithcreelman.github.io/ups-league-data/mfl_hpm16_contractcommandcenter.html" +
    "?cache=20260204aw" +
    "&L=" +
    encodeURIComponent(L) +
    "&YEAR=" +
    encodeURIComponent(YEAR) +
    "&FRANCHISE_ID=" +
    encodeURIComponent(FRANCHISE_ID) +
    (DEBUG_ADMIN ? "&DEBUG_ADMIN=" + encodeURIComponent(DEBUG_ADMIN) : "");

  let mount = document.getElementById("cccMount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "cccMount";
    document.body.appendChild(mount);
  }

  mount.innerHTML =
    '<iframe src="' +
    src +
    '" style="width:100%; height:1400px; border:0;" loading="lazy"></iframe>';
})();
