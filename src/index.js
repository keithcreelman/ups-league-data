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
      const cookieHeader = cookie.includes("=") ? cookie : `MFL_USER_ID=${cookie}`;

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
        const requestedContractStatus = String(body.contract_status || body.contractStatus || "").trim();
        const payloadPlayerStatus = String(body.player_status || body.playerStatus || "").trim();

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

        const makeDataXml = (statusValue) => {
          const attrs = [
            `id="${esc(playerId)}"`,
            `salary="${esc(salary)}"`,
            `contractYear="${esc(contractYear)}"`,
            `contractInfo="${esc(contractInfo)}"`,
          ];
          if (statusValue) attrs.push(`contractStatus="${esc(statusValue)}"`);
          return (
            `<salaries><leagueUnit unit="LEAGUE">` +
            `<player ${attrs.join(" ")} />` +
            `</leagueUnit></salaries>`
          );
        };

        const rookieLike = (raw) => {
          const val = String(raw || "").trim().toLowerCase();
          if (!val) return false;
          return (
            val === "r" ||
            val.startsWith("r-") ||
            val.includes("rookie") ||
            val.includes("mym - rookie")
          );
        };

        let playerStatusLookup = {
          source: "none",
          value: "",
          rookie: null,
        };

        if (payloadPlayerStatus) {
          playerStatusLookup = {
            source: "payload",
            value: payloadPlayerStatus,
            rookie: rookieLike(payloadPlayerStatus),
          };
        } else {
          try {
            const playersQs = new URLSearchParams({
              TYPE: "players",
              L: leagueId,
              P: playerId,
              DETAILS: "1",
              JSON: "1",
              _: String(Date.now()),
            });
            if (env.MFL_APIKEY) {
              playersQs.set("APIKEY", String(env.MFL_APIKEY));
            }
            const playerStatusUrl =
              `https://api.myfantasyleague.com/${encodeURIComponent(year)}` +
              `/export?${playersQs.toString()}`;
            const playerRes = await fetch(playerStatusUrl, {
              headers: {
                Cookie: cookieHeader,
                "User-Agent": "ups-league-data-worker",
              },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (playerRes.ok) {
              const pdata = await playerRes.json();
              const playersRaw = pdata?.players?.player || [];
              const players = Array.isArray(playersRaw)
                ? playersRaw
                : [playersRaw].filter(Boolean);
              const p = players.find((x) => String(x?.id || "") === String(playerId));
              const pStatus = String(p?.status || "").trim();
              if (pStatus) {
                playerStatusLookup = {
                  source: "mfl_players_export",
                  value: pStatus,
                  rookie: rookieLike(pStatus),
                };
              }
            }
          } catch (_) {
            // Fall through to requested status if lookup fails.
          }
        }

        const isRookie =
          playerStatusLookup.rookie !== null
            ? playerStatusLookup.rookie
            : rookieLike(requestedContractStatus);
        const contractStatus = isRookie ? "MYM - Rookie" : "MYM - Vet";

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
          headers: { Cookie: cookieHeader, "User-Agent": "ups-league-data-worker" },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const loc = probe.headers.get("Location") || probe.headers.get("location");
        if (probe.status >= 300 && probe.status < 400 && loc) {
          targetImportUrl = loc;
        }

        const verifyUrlBase =
          `https://api.myfantasyleague.com/${encodeURIComponent(year)}` +
          `/export?TYPE=salaries&L=${encodeURIComponent(leagueId)}&JSON=1&_=`;
        const readPlayer = async (nonce) => {
          const verifyUrl = verifyUrlBase + encodeURIComponent(String(nonce));
          const verifyRes = await fetch(verifyUrl, {
            headers: {
              Cookie: cookieHeader,
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

        const preCheck = await readPlayer(Date.now() - 1);

        const importAttempts = [];
        const statusAttempts = contractStatus
          ? [contractStatus]
          : Array.from(new Set([preCheck?.contractStatus || "", "A", ""]).values());

        let mflRes = null;
        let text = "";
        let looksOk = false;
        let postCheck = preCheck;
        let dataXmlUsed = "";
        let statusUsed = "";

        for (const statusCandidate of statusAttempts) {
          const dataXml = makeDataXml(statusCandidate);
          const bodyData = `DATA=${encodeURIComponent(dataXml)}`;

          const res = await fetch(targetImportUrl, {
            method: "POST",
            headers: {
              Cookie: cookieHeader,
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              "User-Agent": "ups-league-data-worker",
            },
            body: bodyData,
            redirect: "manual",
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const bodyText = await res.text();
          const lowered = bodyText.toLowerCase();
          const requestOk =
            res.ok &&
            !lowered.includes("error") &&
            !lowered.includes("invalid") &&
            !lowered.includes("not authorized");

          await new Promise((r) => setTimeout(r, 250));
          const verifyAfter = await readPlayer(Date.now());
          const changed =
            !!preCheck &&
            !!verifyAfter &&
            (String(preCheck.contractYear || "") !== String(verifyAfter.contractYear || "") ||
              String(preCheck.contractInfo || "") !== String(verifyAfter.contractInfo || "") ||
              String(preCheck.contractStatus || "") !== String(verifyAfter.contractStatus || ""));

          importAttempts.push({
            statusTried: statusCandidate || "(none)",
            upstreamStatus: res.status,
            requestOk,
            changed,
          });

          mflRes = res;
          text = bodyText;
          postCheck = verifyAfter || preCheck;
          dataXmlUsed = dataXml;
          statusUsed = statusCandidate || "";
          looksOk = requestOk;

          if (changed) break;
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
              statusUsed,
              playerStatusLookup,
              dataXml: dataXmlUsed,
              importAttempts,
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
          Cookie: cookieHeader,
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
