export default {
  async fetch(request, env) {
    try {
      // ---------- CORS ----------
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      if (request.method === "OPTIONS") {
        return new Response("", { headers: corsHeaders });
      }

      // ---------- Inputs ----------
      const url = new URL(request.url);
      const path = url.pathname || "/";
      const L = url.searchParams.get("L") || "";
      const YEAR = url.searchParams.get("YEAR") || "2025";

      if (!L && path !== "/offer-mym") {
        return new Response(
          JSON.stringify({ ok: false, isAdmin: false, reason: "Missing L param" }),
          { status: 400, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      // ---------- Cookie ----------
      const cookie = env.MFL_COOKIE || "";
      if (!cookie) {
        return new Response(
          JSON.stringify({ ok: false, isAdmin: false, reason: "Missing MFL_COOKIE secret" }),
          { status: 500, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      // ---------- MYM contract submit ----------
      if (path === "/offer-mym") {
        if (request.method !== "POST") {
          return new Response(
            JSON.stringify({ ok: false, reason: "Method not allowed" }),
            { status: 405, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        const ct = request.headers.get("content-type") || "";
        let body = {};
        if (ct.includes("application/json")) {
          body = await request.json();
        } else {
          const raw = await request.text();
          const p = new URLSearchParams(raw);
          body = Object.fromEntries(p.entries());
        }

        const leagueId = String(L || body.L || body.leagueId || "").trim();
        const year = String(YEAR || body.YEAR || body.year || "2025").trim();
        const playerId = String(body.player_id || body.playerId || "").trim();
        const salary = String(body.salary ?? "").trim();
        const contractYear = String(body.contract_year ?? body.contractYear ?? "").trim();
        const contractInfo = String(body.contract_info || body.contractInfo || "").trim();

        if (!leagueId || !playerId || !salary || !contractYear) {
          return new Response(
            JSON.stringify({
              ok: false,
              reason: "Missing required fields (L, player_id, salary, contract_year)",
            }),
            { status: 400, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        const esc = (s) =>
          String(s)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const dataXml =
          `<salaries><leagueUnit unit="LEAGUE">` +
          `<player id="${esc(playerId)}" salary="${esc(salary)}" contractYear="${esc(
            contractYear
          )}" contractInfo="${esc(contractInfo)}" />` +
          `</leagueUnit></salaries>`;

        const form = new URLSearchParams();
        form.set("TYPE", "salaries");
        form.set("L", leagueId);
        form.set("APPEND", "1");
        form.set("DATA", dataXml);

        const mflImportUrl = `https://api.myfantasyleague.com/${encodeURIComponent(year)}/import`;
        const mflRes = await fetch(mflImportUrl, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent": "ups-league-data-worker",
          },
          body: form.toString(),
          cf: { cacheTtl: 0, cacheEverything: false },
        });

        const text = await mflRes.text();
        const lowered = text.toLowerCase();
        const looksOk =
          mflRes.ok &&
          !lowered.includes("error") &&
          !lowered.includes("invalid") &&
          !lowered.includes("not authorized");

        return new Response(
          JSON.stringify({
            ok: looksOk,
            reason: looksOk ? "Submitted to MFL" : "MFL import rejected request",
            upstreamStatus: mflRes.status,
            upstreamPreview: text.slice(0, 400),
          }),
          { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      // ---------- Call MFL (must be full domain, not /2025/export) ----------
      const mflUrl = `https://api.myfantasyleague.com/${encodeURIComponent(
        YEAR
      )}/export?TYPE=league&L=${encodeURIComponent(L)}&JSON=1&_=${Date.now()}`;

      const res = await fetch(mflUrl, {
        headers: {
          // pass the commish cookie here
          Cookie: cookie,
          "User-Agent": "ups-league-data-worker",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      if (!res.ok) {
        return new Response(
          JSON.stringify({
            ok: false,
            isAdmin: false,
            reason: `MFL HTTP ${res.status}`,
          }),
          { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      const data = await res.json();

      // ---------- Detect commish by presence of private owner info ----------
      const league = data.league || data;
      const frBlock =
        league.franchises ||
        (league.league && league.league.franchises) ||
        null;

      const frArr = (frBlock && (frBlock.franchise || frBlock)) || [];
      const franchises = Array.isArray(frArr) ? frArr : [frArr].filter(Boolean);

      const emailCount = franchises.reduce((acc, f) => {
        const hasEmail = !!(f && (f.email || (f.owner && f.owner.email)));
        return acc + (hasEmail ? 1 : 0);
      }, 0);

      const isAdmin = emailCount > 1;

      return new Response(
        JSON.stringify({
          ok: true,
          isAdmin,
          reason: isAdmin
            ? "Private owner data visible (commish)"
            : "No private owner data visible (not commish)",
          emailCount,
        }),
        { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
      );
    } catch (e) {
      return new Response(
        JSON.stringify({
          ok: false,
          isAdmin: false,
          reason: `Worker error: ${e?.message || String(e)}`,
        }),
        { status: 200, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
