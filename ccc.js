(function(){
  // ======================================================
  // 1) CONFIG
  // ======================================================
  const MYM_JSON_URL =
    "https://keithcreelman.github.io/ups-league-data/mym_dashboard.json";

  // Your commissioner franchise IDs (optional fast path if F exists)
  const COMMISH_FRANCHISE_IDS = ["0008"];

  // ======================================================
  // 2) HELPERS
  // ======================================================
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const safeStr = x => (x === null || x === undefined) ? "" : String(x);
  const safeInt = x => {
    const n = parseInt(String(x).replace(/[^\d-]/g,""),10);
    return isNaN(n) ? 0 : n;
  };

  const pad4 = fid => {
    const d = safeStr(fid).replace(/\D/g,"");
    return d ? d.padStart(4,"0").slice(-4) : "";
  };

  const htmlEsc = s =>
    safeStr(s)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#39;");

  const parseDate = x => {
    const s = safeStr(x).trim();
    if(!s) return null;
    const t = s.replace(" ","T");
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? t + ":00" : t;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  };

  const fmtYMD = x => {
    const d = parseDate(x);
    if(!d) return "";
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  };

  function detectFranchiseId(){
    // 1) Querystring (works on some MFL pages)
    try{
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

      const fid = pad4(cand);
      if(fid) return fid;
    }catch(e){}

    // 2) Common globals (best-effort)
    const g =
      window.franchise_id ||
      window.franchiseId ||
      window.FID ||
      window.fid ||
      "";

    return pad4(g);
  }

  function normalizePayload(raw){
    // handle your "meta + eligibility + usage" JSON
    return {
      eligibility : raw.eligibility || raw.View_MYM_Eligibility || [],
      usage       : raw.usage || raw.View_MYM_Usage || [],
      meta        : raw.meta || {}
    };
  }

  function getLeagueId(){
    try{
      const u = new URL(window.location.href);
      return u.searchParams.get("L") || "";
    }catch(e){
      return "";
    }
  }

  function getYearFromPath(){
    const m = window.location.pathname.match(/\/(\d{4})\//);
    return m ? m[1] : "2025";
  }

  async function detectAdminViaLeagueExport(){
    const L = getLeagueId();
    if(!L) return { isAdmin:false, reason:"no L in url" };

    const year = getYearFromPath();
    const url = `/${year}/export?TYPE=league&L=${encodeURIComponent(L)}&JSON=1&_=${Date.now()}`;

    try{
      const res = await fetch(url, { cache:"no-store", credentials:"include" });
      if(!res.ok) return { isAdmin:false, reason:`http ${res.status}` };

      const data = await res.json();
      const league = data.league || data;

      const frBlock = league.franchises || (league.league && league.league.franchises) || null;
      const frArr = (frBlock && (frBlock.franchise || frBlock)) || [];
      const franchises = Array.isArray(frArr) ? frArr : [frArr].filter(Boolean);

      // Private owner info (emails) only visible for commish
      const emailCount = franchises.reduce((acc,f)=>{
        const hasEmail = !!(f && (f.email || (f.owner && f.owner.email)));
        return acc + (hasEmail ? 1 : 0);
      }, 0);

      return (emailCount > 1)
        ? { isAdmin:true, reason:"private owner data visible" }
        : { isAdmin:false, reason:"no private owner data" };

    }catch(e){
      return { isAdmin:false, reason:String(e?.message || e) };
    }
  }

  // ======================================================
  // 3) STATE
  // ======================================================
  const state = {
    payload: { eligibility:[], usage:[], meta:{} },
    isAdmin: false,
    adminReason: "",
    detectedFranchiseId: "",
    selectedTeam: "__ALL__",
    asOfDate: null,
    search: ""
  };

  // ======================================================
  // 4) ELIGIBILITY OVERRIDE (ADMIN ONLY)
  // ======================================================
  function computeEligible(row, asOfDate){
    if(String(row.mym_acq_type).toUpperCase() === "ROOKIE_DRAFT") return 0;
    const deadline = parseDate(row.mym_deadline);
    if(!deadline || !asOfDate) return 0;
    return asOfDate.getTime() <= deadline.getTime() ? 1 : 0;
  }

  // ======================================================
  // 5) SORTING
  // ======================================================
  function sortNewest(rows){
    return rows.sort((a,b)=>{
      const ad = parseDate(a.acquired_date) || new Date(0);
      const bd = parseDate(b.acquired_date) || new Date(0);
      if(bd - ad !== 0) return bd - ad;

      const a2 = parseDate(a.mym_deadline) || new Date("2999-01-01");
      const b2 = parseDate(b.mym_deadline) || new Date("2999-01-01");
      return a2 - b2;
    });
  }

  // ======================================================
  // 6) RENDERING
  // ======================================================
  function renderTable(rows){
    if(!rows.length){
      return `<div class="ccc-tableWrap" style="padding:12px;">No players</div>`;
    }

    return `
      <div class="ccc-tableWrap">
        <table class="ccc-table">
          <thead>
            <tr>
              <th style="min-width:180px;">Player</th>
              <th>Pos</th>
              <th>Salary</th>
              <th>Acquired</th>
              <th>Deadline</th>
              <th style="min-width:320px;">Explanation</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r=>`
              <tr>
                <td class="playerCell">${htmlEsc(r.player_name)}</td>
                <td class="muted">${htmlEsc(r.positional_grouping || r.position)}</td>
                <td>${safeInt(r.salary).toLocaleString()}</td>
                <td class="muted">${htmlEsc(fmtYMD(r.acquired_date))}</td>
                <td class="muted">${htmlEsc(fmtYMD(r.mym_deadline))}</td>
                <td class="explain">${htmlEsc(r.rule_explanation || "")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function setMetaText(rows){
    const season = rows[0]?.season || "";
    const built  = state.payload.meta?.generated_at || "";
    const minS   = state.payload.meta?.min_season || "";

    const adminTag = state.isAdmin ? " | ADMIN" : "";
    const why = state.isAdmin && state.adminReason ? ` | ${state.adminReason}` : "";

    $("#cccMeta").textContent =
      `Season: ${season}` +
      (built ? ` | built: ${built}` : "") +
      (minS ? ` | min season: ${minS}` : "") +
      adminTag +
      why;
  }

  function render(){
    const { eligibility } = state.payload;

    const asOf = state.isAdmin ? state.asOfDate : null;

    eligibility.forEach(r=>{
      r._eligibleEffective = state.isAdmin
        ? computeEligible(r, asOf)
        : safeInt(r.eligible_flag);
    });

    let rows = eligibility;

    // Team filter
    if(state.selectedTeam !== "__ALL__"){
      rows = rows.filter(r => pad4(r.franchise_id) === pad4(state.selectedTeam));
    }

    // Search filter
    if(state.search){
      const s = state.search.toLowerCase();
      rows = rows.filter(r => safeStr(r.player_name).toLowerCase().includes(s));
    }

    const eligible   = sortNewest(rows.filter(r=>safeInt(r._eligibleEffective) === 1));
    const ineligible = sortNewest(rows.filter(r=>safeInt(r._eligibleEffective) !== 1));

    setMetaText(rows.length ? rows : eligibility);

    $("#tabEligible").innerHTML   = renderTable(eligible);
    $("#tabIneligible").innerHTML = renderTable(ineligible);
  }

  // ======================================================
  // 7) LOAD
  // ======================================================
  async function load(){
    try{
      $("#cccError").textContent = "";
      if($("#cccMeta")) $("#cccMeta").textContent = "Loading MYM data…";

      const res = await fetch(MYM_JSON_URL + "?v=" + Date.now(), { cache:"no-store" });
      if(!res.ok) throw new Error("MYM JSON HTTP " + res.status);

      const raw = await res.json();
      state.payload = normalizePayload(raw);

      // 🔐 ADMIN DETECTION (reliable)
      state.detectedFranchiseId = detectFranchiseId();

      // 1) Manual override switch: add &ADMIN=1 to URL
      const forcedAdmin = (() => {
        try { return new URL(location.href).searchParams.get("ADMIN") === "1"; }
        catch(e){ return false; }
      })();

      // 2) Fast path if a franchise id is detectable
      const hardcodedAdmin =
        !!state.detectedFranchiseId &&
        COMMISH_FRANCHISE_IDS.includes(state.detectedFranchiseId);

      // 3) Real commish detection via same-origin league export (uses your login cookies)
      const exportAdmin = await detectAdminViaLeagueExport();

      state.isAdmin = forcedAdmin || hardcodedAdmin || exportAdmin.isAdmin;
      state.adminReason = forcedAdmin ? "forced" : (hardcodedAdmin ? "fid-match" : (exportAdmin.isAdmin ? "league-export" : ""));

      console.log("[CCC admin]", {
        forcedAdmin,
        detectedFranchiseId: state.detectedFranchiseId,
        hardcodedAdmin,
        exportAdmin
      });

      // Toggle admin UI
      const adminBadge = $("#adminBadge");
      const adminControls = $("#adminControls");
      if(adminBadge) adminBadge.style.display = state.isAdmin ? "" : "none";
      if(adminControls) adminControls.style.display = state.isAdmin ? "flex" : "none";

      // As-of defaults
      if(state.isAdmin){
        const now = new Date();
        state.asOfDate = now;

        const asOfInput = $("#asOfInput");
        if(asOfInput){
          // datetime-local expects "YYYY-MM-DDTHH:MM"
          const v = now.toISOString().slice(0,16);
          asOfInput.value = v;
        }
      }else{
        state.asOfDate = null;
      }

      // Build team dropdown
      const map = new Map();
      state.payload.eligibility.forEach(r=>{
        const id = pad4(r.franchise_id);
        const nm = safeStr(r.franchise_name) || id;
        if(id && !map.has(id)) map.set(id, nm);
      });

      const teams = Array.from(map.entries())
        .map(([id,name])=>({id,name}))
        .sort((a,b)=> a.name.localeCompare(b.name));

      const sel = $("#teamSelect");
      if(sel){
        sel.innerHTML =
          `<option value="__ALL__">All Teams</option>` +
          teams.map(t=>`<option value="${t.id}">${htmlEsc(t.name)}</option>`).join("");

        // Default selection:
        // - if detected franchise exists in list, use it
        // - else All Teams
        const canUseDetected = teams.some(t=>t.id === state.detectedFranchiseId);
        state.selectedTeam = canUseDetected ? state.detectedFranchiseId : "__ALL__";
        sel.value = state.selectedTeam;
      }

      render();
    }catch(e){
      $("#cccError").textContent = "Failed to load MYM data: " + (e?.message || e);
      console.error(e);
    }
  }

  // ======================================================
  // 8) EVENTS
  // ======================================================
  $$(".ccc-tab").forEach(b=>{
    b.onclick = ()=> {
      $$(".ccc-tab").forEach(x=>x.classList.remove("active"));
      b.classList.add("active");
      $("#tabEligible").style.display   = b.dataset.tab==="eligible" ? "" : "none";
      $("#tabIneligible").style.display = b.dataset.tab==="ineligible" ? "" : "none";
    };
  });

  const teamSelect = $("#teamSelect");
  if(teamSelect){
    teamSelect.onchange = e => {
      state.selectedTeam = e.target.value;
      render();
    };
  }

  const searchBox = $("#searchBox");
  if(searchBox){
    searchBox.oninput = e => {
      state.search = e.target.value;
      render();
    };
  }

  const asOfInput = $("#asOfInput");
  if(asOfInput){
    asOfInput.onchange = e => {
      if(!state.isAdmin) return;
      const d = new Date(e.target.value);
      state.asOfDate = isNaN(d.getTime()) ? new Date() : d;
      render();
    };
  }

  const asOfReset = $("#asOfResetBtn");
  if(asOfReset){
    asOfReset.onclick = ()=>{
      if(!state.isAdmin) return;
      const now = new Date();
      state.asOfDate = now;
      if($("#asOfInput")) $("#asOfInput").value = now.toISOString().slice(0,16);
      render();
    };
  }

  const clearBtn = $("#clearBtn");
  if(clearBtn){
    clearBtn.onclick = ()=>{
      if($("#searchBox")) $("#searchBox").value = "";
      state.search = "";
      render();
    };
  }

  const refreshBtn = $("#refreshBtn");
  if(refreshBtn){
    refreshBtn.onclick = ()=> load();
  }

  // ======================================================
  // START
  // ======================================================
  load();
})();
