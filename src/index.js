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
        const contractStatus = String(body.contract_status || body.contractStatus || "").trim();

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

        const attrs = [
          `id="${esc(playerId)}"`,
          `salary="${esc(salary)}"`,
          `contractYear="${esc(contractYear)}"`,
          `contractInfo="${esc(contractInfo)}"`,
        ];
        if (contractStatus) attrs.push(`contractStatus="${esc(contractStatus)}"`);

        const dataXml =
          `<salaries><leagueUnit unit="LEAGUE">` +
          `<player ${attrs.join(" ")} />` +
          `</leagueUnit></salaries>`;

        const form = new URLSearchParams();
        form.set("TYPE", "salaries");
        form.set("L", leagueId);
        form.set("APPEND", "1");
        form.set("DATA", dataXml);

        const importQuery =
          `TYPE=salaries&L=${encodeURIComponent(leagueId)}&APPEND=1`;
        const importUrl = `https://api.myfantasyleague.com/${encodeURIComponent(
          year
        )}/import?${importQuery}`;

        // api.myfantasyleague.com issues 302 to a specific shard (wwwNN). If we auto-follow
        // a POST through 302, body data can be dropped. Resolve target first, then POST once.
        let targetImportUrl = importUrl;
        const probe = await fetch(importUrl, {
          method: "GET",
          redirect: "manual",
          headers: { Cookie: cookie, "User-Agent": "ups-league-data-worker" },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const loc = probe.headers.get("Location") || probe.headers.get("location");
        if (probe.status >= 300 && probe.status < 400 && loc) {
          targetImportUrl = loc;
        }

        const mflRes = await fetch(targetImportUrl, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent": "ups-league-data-worker",
          },
          body: form.toString(),
          redirect: "manual",
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const text = await mflRes.text();

        const lowered = text.toLowerCase();
        const looksOk =
          !!mflRes &&
          mflRes.ok &&
          !lowered.includes("error") &&
          !lowered.includes("invalid") &&
          !lowered.includes("not authorized");

        // Verify pre/post state from MFL export so callers can confirm site-side data changed.
        let preCheck = null;
        let postCheck = null;
        if (looksOk) {
          const verifyUrlBase =
            `https://api.myfantasyleague.com/${encodeURIComponent(year)}` +
            `/export?TYPE=salaries&L=${encodeURIComponent(leagueId)}&JSON=1&_=` ;
          const readPlayer = async (nonce) => {
            const verifyUrl = verifyUrlBase + encodeURIComponent(String(nonce));
            const verifyRes = await fetch(verifyUrl, {
              headers: {
                Cookie: cookie,
                "User-Agent": "ups-league-data-worker",
              },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!verifyRes.ok) return null;
            const v = await verifyRes.json();
            const leagueUnit = (v?.salaries && (v.salaries.leagueUnit || v.salaries.leagueunit)) || {};
            const playersRaw = leagueUnit.player || [];
            const players = Array.isArray(playersRaw) ? playersRaw : [playersRaw].filter(Boolean);
            const found = players.find((p) => String(p.id) === String(playerId));
            if (!found) return { id: String(playerId), found: false };
            return {
              id: String(found.id || ""),
              salary: String(found.salary || ""),
              contractYear: String(found.contractYear || ""),
              contractInfo: String(found.contractInfo || ""),
              contractStatus: String(found.contractStatus || ""),
            };
          };

          preCheck = await readPlayer(Date.now() - 1);
          // small delay helps MFL propagate import state before verify fetch
          await new Promise((r) => setTimeout(r, 250));
          postCheck = await readPlayer(Date.now());
        }

        return new Response(
          JSON.stringify({
            ok: looksOk,
            reason: looksOk ? "Submitted to MFL" : "MFL import rejected request",
            upstreamStatus: mflRes ? mflRes.status : 0,
            upstreamPreview: text.slice(0, 800),
            preCheck,
            postCheck,
            submitDebug: {
              targetImportUrl,
              contentType: "application/x-www-form-urlencoded;charset=UTF-8",
              formFields: { TYPE: "salaries", L: leagueId, APPEND: "1" },
              dataXml,
            },
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
