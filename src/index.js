export default {
  async fetch(request, env) {
    try {
      // ---------- CORS ----------
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      if (request.method === "OPTIONS") {
        return new Response("", { headers: corsHeaders });
      }

      // ---------- Inputs ----------
      const url = new URL(request.url);
      const L = url.searchParams.get("L") || "";
      const YEAR = url.searchParams.get("YEAR") || "2025";

      if (!L) {
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
