(function(){
  // =========================
  // 1) CONFIG
  // =========================
  const MYM_JSON_URL = "https://keithcreelman.github.io/ups-league-data/mym_dashboard.json";

  // Put your real commish IDs here if you want a fast-path check
  const COMMISH_FRANCHISE_IDS = ["0007","0004"];

  // =========================
  // 2) UTIL
  // =========================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function safeStr(x){ return (x===null||x===undefined) ? "" : String(x); }
  function safeInt(x){
    const n = parseInt(String(x).replace(/[^\d-]/g,""),10);
    return isNaN(n) ? 0 : n;
  }
  function pad4(fid){
    const d = safeStr(fid).replace(/\D/g,"");
    if(!d) return "";
    return d.padStart(4,"0").slice(-4);
  }
function htmlEsc(s){
  return safeStr(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");

  }

  function parseDate(x){
    const s = safeStr(x).trim();
    if(!s) return null;
    const t = s.replace(" ","T");
    const t2 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? (t + ":00") : t;
    const d = new Date(t2);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtYMD(x){
    const d = parseDate(x);
    if(!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const da = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  }

  function getLeagueId(){
    try{
      const u = new URL(window.location.href);
      return u.searchParams.get("L") || "";
    }catch(e){ return ""; }
  }
  function getYearFromPath(){
    const m = window.location.pathname.match(/\/(\d{4})\//);
    return m ? m[1] : "2025";
  }

  function detectFranchiseId(){
    try{
      const url = new URL(window.location.href);
      const qs = url.searchParams;
      const cand = [qs.get("FRANCHISE_ID"), qs.get("franchise_id"), qs.get("FRANCHISE"), qs.get("F"), qs.get("FR")].filter(Boolean);
      if(cand.length) return pad4(cand[0]);
    }catch(e){}
    return "";
  }

  function normalizePayload(raw){
    if(Array.isArray(raw)) return { eligibility: raw, usage: [], meta: {} };
    const all = raw.View_MYM_All || raw.view_mym_all || raw.mym_all || null;
    if(Array.isArray(all)){
      return { eligibility: all, usage: raw.View_MYM_Usage || raw.usage || [], meta: raw.meta || {} };
    }
    return {
      eligibility: raw.eligibility || raw.View_MYM_Eligibility || [],
      usage: raw.usage || raw.View_MYM_Usage || [],
      meta: raw.meta || {}
    };
  }

  // =========================
  // 3) ADMIN DETECTION
  // =========================
  async function detectAdminViaLeagueExport(){
    const L = getLeagueId();
    if(!L) return { isAdmin:false, reason:"No league id (L) found in URL." };

    const year = getYearFromPath();
    const url = `/${year}/export?TYPE=league&L=${encodeURIComponent(L)}&JSON=1&_=${Date.now()}`;

    try{
      const res = await fetch(url, { cache:"no-store", credentials:"include" });
      if(!res.ok) return { isAdmin:false, reason:`League export HTTP ${res.status}` };

      const data = await res.json();
      const league = data.league || data;

      const frBlock = league.franchises || (league.league && league.league.franchises) || null;
      const frArr = (frBlock && (frBlock.franchise || frBlock)) || [];
      const franchises = Array.isArray(frArr) ? frArr : [frArr].filter(Boolean);

      const emailCount = franchises.reduce((acc,f)=>{
        const hasEmail = !!(f && (f.email || (f.owner && f.owner.email)));
        return acc + (hasEmail ? 1 : 0);
      }, 0);

      return (emailCount > 1)
        ? { isAdmin:true, reason:"Commissioner-level private owner info visible." }
        : { isAdmin:false, reason:"No commissioner-level private owner info detected." };
    }catch(e){
      return { isAdmin:false, reason:`League export failed: ${e && e.message ? e.message : e}` };
    }
  }

  // =========================
  // 4) ELIGIBILITY OVERRIDE + SCORING
  // =========================
  function computeEligible(row, asOfDate){
    const acqType = safeStr(row.mym_acq_type || "").toUpperCase();
    if(acqType === "ROOKIE_DRAFT") return 0;

    const deadline = parseDate(row.mym_deadline);
    if(!deadline || !asOfDate) return 0;
    return (asOfDate.getTime() <= deadline.getTime()) ? 1 : 0;
  }

  function scoreCandidate(row, asOfDate){
    const salary = safeInt(row.salary);
    const pos = safeStr(row.positional_grouping || row.position).toUpperCase();
    const eligible = safeInt(row._eligibleEffective) === 1;
    if(!eligible) return 0;

    const deadline = parseDate(row.mym_deadline);
    const urgDays = (deadline && asOfDate) ? Math.ceil((deadline.getTime() - asOfDate.getTime()) / (1000*60*60*24)) : 14;

    const posW = ({
      "QB": 1.0, "RB": 1.4, "WR": 1.2, "TE": 1.25,
      "DL": 1.05, "LB": 1.05, "DB": 1.05, "S": 1.05, "CB": 1.05
    })[pos] || 1.0;

    const salaryScore = Math.max(0, 20000 - salary) / 20000;
    const urgencyScore = Math.max(0, Math.min(1, (14 - urgDays) / 14));
    const score = (salaryScore * 60) + (posW * 20) + (urgencyScore * 20);
    return Math.round(score);
  }

  // =========================
  // 5) UI RENDER
  // =========================
  function pillForType(acqType){
    const t = safeStr(acqType).toUpperCase();
    if(t.includes("AUCTION")) return "auction";
    if(t.includes("ROOKIE")) return "rookie";
    return "waiver";
  }

  function renderTable(rows, mode, asOfDate){
    if(!rows.length){
      return `<div class="ccc-tableWrap" style="padding:12px;">No rows.</div>`;
    }

    const showScore = (mode === "eligible");

    const head = `
      <div class="ccc-tableWrap">
        <table class="ccc-table">
          <thead>
            <tr>
              <th style="min-width:180px;">Player</th>
              <th>Pos</th>
              <th>Salary</th>
              <th>Acq Type</th>
              <th>Acquired</th>
              <th>Deadline</th>
              ${showScore ? `<th>Score</th>` : ``}
              <th style="min-width:320px;">Explanation</th>
            </tr>
          </thead>
          <tbody>
    `;

    const body = rows.map(r=>{
      const player = htmlEsc(r.player_name);
      const pos = htmlEsc(r.positional_grouping || r.position);
      const salary = safeInt(r.salary).toLocaleString();
      const acqType = safeStr(r.mym_acq_type);

      const acquired = htmlEsc(fmtYMD(r.acquired_date));
      const deadline = htmlEsc(fmtYMD(r.mym_deadline));
      const expl = htmlEsc(r.rule_explanation || "");

      const score = showScore ? scoreCandidate(r, asOfDate) : null;

      return `
        <tr>
          <td class="playerCell">${player}</td>
          <td class="muted">${pos}</td>
          <td>${salary}</td>
          <td><span class="pill ${pillForType(acqType)}">${htmlEsc(acqType)}</span></td>
          <td class="muted">${acquired}</td>
          <td class="muted">${deadline}</td>
          ${showScore ? `<td><span class="pill good">${score}</span></td>` : ``}
          <td class="explain">${expl}</td>
        </tr>
      `;
    }).join("");

    return head + body + `</tbody></table></div>`;
  }

  function renderSummary(teamName, rowsAll, rowsElig, usageRow, asOfDate, isAdmin){
    const used = usageRow ? safeInt(usageRow.mym_used) : 0;
    const remaining = usageRow ? safeInt(usageRow.mym_remaining) : 0;

    const soonest = rowsElig
      .map(r => ({ r, d: parseDate(r.mym_deadline) }))
      .filter(x => x.d)
      .sort((a,b) => a.d - b.d)[0];

    const soonestTxt = soonest ? fmtYMD(soonest.r.mym_deadline) : "N/A";
    const asOfTxt = asOfDate ? asOfDate.toISOString().slice(0,16).replace("T"," ") : "";

    return `
      <div class="ccc-summaryTop">
        <div class="ccc-summaryTitle">${htmlEsc(teamName)} MYM Snapshot</div>
        <div class="muted" style="font-size:12px;">
          ${isAdmin ? `<span class="pill">As-Of: ${htmlEsc(asOfTxt)}</span>` : ``}
        </div>
      </div>

      <div class="ccc-kpis">
        <div class="kpi">
          <div class="label">Eligible Now</div>
          <div class="value">${rowsElig.length}</div>
          <div class="hint">out of ${rowsAll.length} players</div>
        </div>

        <div class="kpi">
          <div class="label">Soonest Deadline</div>
          <div class="value">${htmlEsc(soonestTxt)}</div>
          <div class="hint">earliest eligible deadline</div>
        </div>

        <div class="kpi">
          <div class="label">MYM Used</div>
          <div class="value">${used}</div>
          <div class="hint">successful submissions</div>
        </div>

        <div class="kpi">
          <div class="label">MYM Remaining</div>
          <div class="value">${remaining}</div>
          <div class="hint">cap: 5 per season</div>
        </div>
      </div>
    `;
  }

  // =========================
  // 6) STATE
  // =========================
  let state = {
    payload: { eligibility: [], usage: [], meta: {} },
    isAdmin: false,
    selectedTeam: "__ALL__",
    detectedFranchiseId: "",
    asOfDate: null,
    search: ""
  };

  function buildTeamList(rows){
    const map = new Map();
    rows.forEach(r=>{
      const id = pad4(r.franchise_id);
      const nm = safeStr(r.franchise_name);
      if(id && !map.has(id)) map.set(id, nm || id);
    });

    const list = Array.from(map.entries())
      .map(([id,name])=>({ id, name }))
      .sort((a,b)=> a.name.localeCompare(b.name));

    return [{ id:"__ALL__", name:"All Teams" }, ...list];
  }

  function populateTeamSelect(teams, selectedId){
    const sel = $("#teamSelect");
    sel.innerHTML = "";
    teams.forEach(t=>{
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      opt.selected = (t.id === selectedId);
      sel.appendChild(opt);
    });
  }

  function getUsageRow(usageRows, franchiseId, season){
    const seasonStr = safeStr(season);
    let row = usageRows.find(u => pad4(u.franchise_id) === franchiseId && safeStr(u.season) === seasonStr);
    if(!row) row = usageRows.find(u => pad4(u.franchise_id) === franchiseId);
    return row || null;
  }

  function applyEffectiveEligibility(rows, asOfDate){
    rows.forEach(r=>{
      r._eligibleEffective = safeInt(r.eligible_flag);
      if(state.isAdmin && asOfDate){
        r._eligibleEffective = computeEligible(r, asOfDate);
      }
    });
  }

  function sortRowsNewestAcquired(rows){
    return rows.sort((a,b)=>{
      const aa = parseDate(a.acquired_date) || new Date("1900-01-01");
      const bb = parseDate(b.acquired_date) || new Date("1900-01-01");
      if(bb - aa !== 0) return bb - aa;
      const da = parseDate(a.mym_deadline) || new Date("2999-01-01");
      const db = parseDate(b.mym_deadline) || new Date("2999-01-01");
      return da - db;
    });
  }

  function render(){
    const { eligibility, usage, meta } = state.payload;
    $("#cccError").textContent = "";

    const asOfDate = state.isAdmin ? state.asOfDate : null;
    applyEffectiveEligibility(eligibility, asOfDate);

    const searchLower = safeStr(state.search).trim().toLowerCase();

    let scoped = eligibility;
    if(state.selectedTeam !== "__ALL__"){
      const fid = pad4(state.selectedTeam);
      scoped = scoped.filter(r => pad4(r.franchise_id) === fid);
    }
    if(searchLower){
      scoped = scoped.filter(r => safeStr(r.player_name).toLowerCase().includes(searchLower));
    }

    const season = scoped[0] ? scoped[0].season : (eligibility[0] ? eligibility[0].season : "");
    const built = (meta && meta.generated_at) ? safeStr(meta.generated_at) : "";
    const minSeason = (meta && meta.min_season) ? safeStr(meta.min_season) : "";

    $("#cccMeta").textContent =
      `Season: ${season || "?"}` +
      (built ? ` | built: ${built}` : "") +
      (minSeason ? ` | min season: ${minSeason}` : "") +
      (state.isAdmin ? ` | admin: yes` : "");

    const eligibleRows = sortRowsNewestAcquired(scoped.filter(r => safeInt(r._eligibleEffective) === 1));
    const ineligibleRows = sortRowsNewestAcquired(scoped.filter(r => safeInt(r._eligibleEffective) !== 1));

    const teamName =
      (state.selectedTeam === "__ALL__") ? "All Teams" :
      (scoped[0] ? safeStr(scoped[0].franchise_name) : "Team");

    let usageRow = null;
    if(state.selectedTeam !== "__ALL__"){
      usageRow = getUsageRow(usage, pad4(state.selectedTeam), season);
    }else{
      const used = usage.reduce((acc,u)=> acc + safeInt(u.mym_used), 0);
      const remaining = usage.reduce((acc,u)=> acc + safeInt(u.mym_remaining), 0);
      usageRow = { mym_used: used, mym_remaining: remaining };
    }

    $("#summary").innerHTML = renderSummary(teamName, scoped, eligibleRows, usageRow, asOfDate, state.isAdmin);
    $("#tabEligible").innerHTML = renderTable(eligibleRows, "eligible", asOfDate || new Date());
    $("#tabIneligible").innerHTML = renderTable(ineligibleRows, "ineligible", asOfDate || new Date());
  }

  async function load(){
    try{
      $("#cccMeta").textContent = "Loading MYM data…";

      const bust = (MYM_JSON_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
      const res = await fetch(MYM_JSON_URL + bust, { cache:"no-store" });
      if(!res.ok) throw new Error("MYM JSON HTTP " + res.status);

      const raw = await res.json();
      state.payload = normalizePayload(raw);

      state.detectedFranchiseId = detectFranchiseId();
      const quickAdmin = COMMISH_FRANCHISE_IDS.includes(state.detectedFranchiseId);
      const exportAdmin = await detectAdminViaLeagueExport();

      state.isAdmin = quickAdmin || exportAdmin.isAdmin;

      $("#adminBadge").style.display = state.isAdmin ? "" : "none";
      $("#adminControls").style.display = state.isAdmin ? "flex" : "none";

      if(state.isAdmin){
        const now = new Date();
        state.asOfDate = now;
        const pad = (n)=> String(n).padStart(2,"0");
        $("#asOfInput").value =
          `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      }else{
        state.asOfDate = null;
      }

      const teams = buildTeamList(state.payload.eligibility);
      const detected = teams.some(t => t.id === state.detectedFranchiseId) ? state.detectedFranchiseId : "__ALL__";
      state.selectedTeam = detected;

      populateTeamSelect(teams, state.selectedTeam);
      render();
    }catch(e){
      $("#cccMeta").textContent = "";
      $("#cccError").textContent = "Could not load MYM JSON. " + (e && e.message ? e.message : e);
      console.error(e);
    }
  }

  function setTab(tab){
    $("#tabEligible").style.display = (tab==="eligible") ? "" : "none";
    $("#tabIneligible").style.display = (tab==="ineligible") ? "" : "none";
    $$(".ccc-tab").forEach(b=>{
      b.classList.toggle("active", b.dataset.tab === tab);
    });
  }

  // Events
  $$(".ccc-tab").forEach(btn => btn.addEventListener("click", ()=> setTab(btn.dataset.tab)));

  $("#teamSelect").addEventListener("change", (e)=>{
    state.selectedTeam = e.target.value;
    render();
  });

  $("#searchBox").addEventListener("input", (e)=>{
    state.search = e.target.value;
    render();
  });

  $("#clearBtn").addEventListener("click", ()=>{
    $("#searchBox").value = "";
    state.search = "";
    render();
  });

  $("#refreshBtn").addEventListener("click", ()=> load());

  $("#asOfInput").addEventListener("change", ()=>{
    if(!state.isAdmin) return;
    const v = $("#asOfInput").value;
    const d = v ? new Date(v) : new Date();
    state.asOfDate = isNaN(d.getTime()) ? new Date() : d;
    render();
  });

  $("#asOfResetBtn").addEventListener("click", ()=>{
    if(!state.isAdmin) return;
    const now = new Date();
    state.asOfDate = now;
    const pad = (n)=> String(n).padStart(2,"0");
    $("#asOfInput").value =
      `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    render();
  });

  // Start
  setTab("eligible");
  load();
})();
