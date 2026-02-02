(function(){
  // ======================================================
  // 1) CONFIG
  // ======================================================
  const MYM_JSON_URL =
    "https://keithcreelman.github.io/ups-league-data/mym_dashboard.json";

  // Commissioner franchise IDs (ONLY reliable client-side signal)
  const COMMISH_FRANCHISE_IDS = ["0007","0004"];

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
    try{
      const u = new URL(window.location.href);
      const qs = u.searchParams;
      return pad4(
        qs.get("FRANCHISE_ID") ||
        qs.get("FRANCHISE") ||
        qs.get("F") ||
        ""
      );
    }catch(e){
      return "";
    }
  }

  function normalizePayload(raw){
    return {
      eligibility : raw.eligibility || raw.View_MYM_Eligibility || [],
      usage       : raw.usage || raw.View_MYM_Usage || [],
      meta        : raw.meta || {}
    };
  }

  // ======================================================
  // 3) STATE
  // ======================================================
  const state = {
    payload: { eligibility:[], usage:[], meta:{} },
    isAdmin: false,
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
      return bd - ad;
    });
  }

  // ======================================================
  // 6) RENDERING
  // ======================================================
  function renderTable(rows){
    if(!rows.length){
      return `<div class="ccc-empty">No players</div>`;
    }

    return `
      <div class="ccc-tableWrap">
        <table class="ccc-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Salary</th>
              <th>Acquired</th>
              <th>Deadline</th>
              <th>Explanation</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r=>`
              <tr>
                <td class="playerCell">${htmlEsc(r.player_name)}</td>
                <td>${htmlEsc(r.positional_grouping || r.position)}</td>
                <td>${safeInt(r.salary).toLocaleString()}</td>
                <td>${fmtYMD(r.acquired_date)}</td>
                <td>${fmtYMD(r.mym_deadline)}</td>
                <td class="explain">${htmlEsc(r.rule_explanation)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function render(){
    const { eligibility, usage, meta } = state.payload;

    const asOf = state.isAdmin ? state.asOfDate : null;

    eligibility.forEach(r=>{
      r._eligibleEffective = state.isAdmin
        ? computeEligible(r, asOf)
        : safeInt(r.eligible_flag);
    });

    let rows = eligibility;

    if(state.selectedTeam !== "__ALL__"){
      rows = rows.filter(r => pad4(r.franchise_id) === state.selectedTeam);
    }

    if(state.search){
      const s = state.search.toLowerCase();
      rows = rows.filter(r =>
        safeStr(r.player_name).toLowerCase().includes(s)
      );
    }

    const eligible   = sortNewest(rows.filter(r=>r._eligibleEffective === 1));
    const ineligible = sortNewest(rows.filter(r=>r._eligibleEffective !== 1));

    $("#cccMeta").textContent =
      `Season ${rows[0]?.season || ""}` +
      (state.isAdmin ? " | ADMIN" : "");

    $("#tabEligible").innerHTML   = renderTable(eligible);
    $("#tabIneligible").innerHTML = renderTable(ineligible);
  }

  // ======================================================
  // 7) LOAD
  // ======================================================
  async function load(){
    try{
      const res = await fetch(MYM_JSON_URL + "?v=" + Date.now());
      const raw = await res.json();
      state.payload = normalizePayload(raw);

      // 🔐 FINAL ADMIN LOGIC (ONLY WORKING METHOD)
      state.detectedFranchiseId = detectFranchiseId();
      state.isAdmin = COMMISH_FRANCHISE_IDS.includes(state.detectedFranchiseId);

      $("#adminBadge").style.display   = state.isAdmin ? "" : "none";
      $("#adminControls").style.display = state.isAdmin ? "flex" : "none";

      if(state.isAdmin){
        const now = new Date();
        state.asOfDate = now;
        $("#asOfInput").value =
          now.toISOString().slice(0,16);
      }

      const teams = [...new Map(
        state.payload.eligibility.map(r=>[
          pad4(r.franchise_id),
          r.franchise_name
        ])
      )].map(([id,name])=>({id,name}));

      const sel = $("#teamSelect");
      sel.innerHTML =
        `<option value="__ALL__">All Teams</option>` +
        teams.map(t=>`<option value="${t.id}">${t.name}</option>`).join("");

      render();
    }catch(e){
      $("#cccError").textContent = "Failed to load MYM data";
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

  $("#teamSelect").onchange = e => {
    state.selectedTeam = e.target.value;
    render();
  };

  $("#searchBox").oninput = e => {
    state.search = e.target.value;
    render();
  };

  $("#asOfInput").onchange = e => {
    if(!state.isAdmin) return;
    state.asOfDate = new Date(e.target.value);
    render();
  };

  $("#asOfResetBtn").onclick = ()=>{
    if(!state.isAdmin) return;
    const now = new Date();
    state.asOfDate = now;
    $("#asOfInput").value = now.toISOString().slice(0,16);
    render();
  };

  // ======================================================
  // START
  // ======================================================
  load();
})();
