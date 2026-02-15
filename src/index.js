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
      const browserMflUserId = String(url.searchParams.get("MFL_USER_ID") || "").trim();
      const browserApiKey = String(url.searchParams.get("APIKEY") || "").trim();

      if (
        !L &&
        !path.startsWith("/mcm") &&
        path !== "/offer-mym" &&
        path !== "/offer-restructure" &&
        path !== "/commish-contract-update"
      ) {
        return new Response(
          JSON.stringify({ ok: false, isAdmin: false, reason: "Missing L param" }),
          { status: 400, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      // ---------- MCM (No MFL Cookie Required) ----------
      const jsonOut = (status, payload) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json", ...corsHeaders },
        });

      const MCM_SEED_URL = "https://keithcreelman.github.io/ups-league-data/mcm_seed.json";
      const MCM_VOTES_URL = "https://keithcreelman.github.io/ups-league-data/mcm_votes.json";
      const MCM_NOMS_URL = "https://keithcreelman.github.io/ups-league-data/mcm_nominations.json";

      const fetchJson = async (u, fallback) => {
        try {
          const res = await fetch(u, {
            headers: { "Cache-Control": "no-store" },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (!res.ok) return fallback;
          return await res.json();
        } catch (_) {
          return fallback;
        }
      };

      const safeStr = (v) => String(v == null ? "" : v).trim();

      const isValidUrl = (v) => {
        const s = safeStr(v);
        if (!s) return false;
        try {
          const p = new URL(s);
          return p.protocol === "http:" || p.protocol === "https:";
        } catch (_) {
          return false;
        }
      };

      const sha256Hex = async (text) => {
        const buf = new TextEncoder().encode(String(text || ""));
        const hash = await crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      };

      const utcNowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      const utcYmd = (d) => {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, "0");
        const day = String(d.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      };

      const firstMondayOfYearUtc = (year) => {
        const d = new Date(Date.UTC(year, 0, 1));
        const weekday = d.getUTCDay(); // Sun=0..Sat=6
        const offset = (8 - (weekday || 7)) % 7; // to Monday
        d.setUTCDate(d.getUTCDate() + offset);
        return d;
      };

      const currentSeasonYear = (seed) => {
        const mode = safeStr(seed?.season?.year_mode || "current");
        if (!mode || mode === "current") return new Date().getUTCFullYear();
        const n = Number(mode);
        return Number.isFinite(n) && n >= 2000 ? n : new Date().getUTCFullYear();
      };

      const seasonStartUtc = (seed, year) => {
        const start = safeStr(seed?.season?.season_start || "first_monday");
        if (!start || start === "first_monday") return firstMondayOfYearUtc(year);
        const m = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        return firstMondayOfYearUtc(year);
      };

      const weekInfoByNumber = (seed, cycle, weekNoRaw) => {
        const year = currentSeasonYear(seed);
        const start = seasonStartUtc(seed, year);
        const regularWeeks = Number(seed?.season?.regular_weeks || 48);
        const playoffWeeks = Number(seed?.season?.playoff_weeks || 4);
        const totalWeeks = regularWeeks + playoffWeeks;
        const w = Math.max(1, Math.min(totalWeeks, Number(weekNoRaw || 1) || 1));
        const phase = w <= regularWeeks ? "regular" : "playoffs";
        const genreId = phase === "regular" ? cycle[(w - 1) % cycle.length] : "playoffs";
        const weekStart = new Date(start.getTime());
        weekStart.setUTCDate(weekStart.getUTCDate() + (w - 1) * 7);
        const weekEnd = new Date(weekStart.getTime());
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
        return {
          season_year: year,
          season_start: utcYmd(start),
          regular_weeks: regularWeeks,
          playoff_weeks: playoffWeeks,
          total_weeks: totalWeeks,
          week_no: w,
          phase,
          genre_id: genreId,
          week_start: utcYmd(weekStart),
          week_end: utcYmd(weekEnd),
          today_utc: utcYmd(new Date()),
        };
      };

      const weekInfoNow = (seed, cycle) => {
        const year = currentSeasonYear(seed);
        const start = seasonStartUtc(seed, year);
        const today = new Date();
        const msPerDay = 86400000;
        const deltaDays = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - start.getTime()) / msPerDay);
        const regularWeeks = Number(seed?.season?.regular_weeks || 48);
        const playoffWeeks = Number(seed?.season?.playoff_weeks || 4);
        const totalWeeks = regularWeeks + playoffWeeks;
        const computedWeek = deltaDays < 0 ? 1 : Math.floor(deltaDays / 7) + 1;
        return weekInfoByNumber(seed, cycle, Math.max(1, Math.min(totalWeeks, computedWeek)));
      };

      const playoffRoundForWeek = (weekNo, regularWeeks, playoffWeeks) => {
        if (playoffWeeks < 4) return null;
        const offset = weekNo - regularWeeks;
        if (offset === 1) return { id: "R16", name: "Round of 16", matchups: 8 };
        if (offset === 2) return { id: "QF", name: "Quarterfinals", matchups: 4 };
        if (offset === 3) return { id: "SF", name: "Semifinals", matchups: 2 };
        if (offset === 4) return { id: "F", name: "Final", matchups: 1 };
        return null;
      };

      const buildNominees = (seed, nomDoc) => {
        const out = [];
        const seedNominees = Array.isArray(seed?.nominees) ? seed.nominees : [];
        for (const n of seedNominees) {
          if (!n || !safeStr(n.id)) continue;
          out.push({
            id: safeStr(n.id),
            display_name: safeStr(n.display_name),
            genre_id: safeStr(n.genre_id),
            primary_url: safeStr(n.primary_url),
            image_url: safeStr(n.image_url),
            source: "seed",
            active: true,
          });
        }

        const noms = Array.isArray(nomDoc?.nominations) ? nomDoc.nominations : [];
        for (const n of noms) {
          if (!n) continue;
          const status = safeStr(n.status || "approved");
          if (status === "rejected") continue;
          const nid = safeStr(n.nomination_id);
          if (!nid) continue;
          out.push({
            id: "user-" + nid,
            display_name: safeStr(n.display_name),
            genre_id: safeStr(n.genre_id),
            primary_url: safeStr(n.primary_url),
            image_url: safeStr(n.image_url),
            notes: safeStr(n.notes),
            source: status === "approved" ? "approved" : "pending",
            active: true,
          });
        }

        // De-dupe by id
        const seen = new Set();
        return out.filter((n) => {
          if (!n.id || seen.has(n.id)) return false;
          seen.add(n.id);
          return true;
        });
      };

      const voteCounts = (voteDoc, seasonYear, weekNo, phase, matchupKey) => {
        const votes = Array.isArray(voteDoc?.votes) ? voteDoc.votes : [];
        const out = new Map();
        for (const v of votes) {
          if (!v) continue;
          if (Number(v.season_year) !== Number(seasonYear)) continue;
          if (Number(v.week_no) !== Number(weekNo)) continue;
          const mk = safeStr(v.matchup_key || "regular");
          if (safeStr(matchupKey) !== mk) continue;
          const keyPhase = phase || (mk === "regular" ? "regular" : "playoffs");
          // We don't store phase in JSON; infer it.
          const inferred = mk === "regular" ? "regular" : "playoffs";
          if (keyPhase && inferred !== keyPhase) continue;
          const nid = safeStr(v.nominee_id);
          if (!nid) continue;
          out.set(nid, (out.get(nid) || 0) + 1);
        }
        return out;
      };

      const seedMapFromVotes = (voteDoc, nominees, seasonYear, regularWeeks, want) => {
        const votes = Array.isArray(voteDoc?.votes) ? voteDoc.votes : [];
        const counts = new Map();
        for (const v of votes) {
          if (!v) continue;
          if (Number(v.season_year) !== Number(seasonYear)) continue;
          if (Number(v.week_no) > Number(regularWeeks)) continue;
          if (safeStr(v.matchup_key || "regular") !== "regular") continue;
          const nid = safeStr(v.nominee_id);
          if (!nid) continue;
          counts.set(nid, (counts.get(nid) || 0) + 1);
        }

        const allIds = nominees.map((n) => n.id);
        const ranked = allIds
          .map((id) => ({ id, votes: counts.get(id) || 0 }))
          .sort((a, b) => (b.votes - a.votes) || a.id.localeCompare(b.id))
          .slice(0, want);

        const map = {};
        for (let i = 0; i < ranked.length; i += 1) map[ranked[i].id] = i + 1;
        return map;
      };

      const matchupPairsForRound = (roundId, seedMap, prevWinners) => {
        const bySeed = {};
        for (const [nid, seedNo] of Object.entries(seedMap || {})) bySeed[Number(seedNo)] = nid;
        const s = (n) => bySeed[n] || "";
        if (roundId === "R16") {
          const pairs = [
            [1, 16],
            [8, 9],
            [5, 12],
            [4, 13],
            [6, 11],
            [3, 14],
            [7, 10],
            [2, 15],
          ];
          return pairs.map(([a, b], i) => [`R16-${i + 1}`, s(a), s(b)]);
        }
        if (roundId === "QF") {
          return [
            ["QF-1", prevWinners["R16-1"] || "", prevWinners["R16-2"] || ""],
            ["QF-2", prevWinners["R16-3"] || "", prevWinners["R16-4"] || ""],
            ["QF-3", prevWinners["R16-5"] || "", prevWinners["R16-6"] || ""],
            ["QF-4", prevWinners["R16-7"] || "", prevWinners["R16-8"] || ""],
          ];
        }
        if (roundId === "SF") {
          return [
            ["SF-1", prevWinners["QF-1"] || "", prevWinners["QF-2"] || ""],
            ["SF-2", prevWinners["QF-3"] || "", prevWinners["QF-4"] || ""],
          ];
        }
        if (roundId === "F") {
          return [["F-1", prevWinners["SF-1"] || "", prevWinners["SF-2"] || ""]];
        }
        return [];
      };

      const winnerForMatchup = (voteDoc, seasonYear, weekNo, matchupKey, aId, bId, seedMap) => {
        if (!aId || !bId) return aId || bId || "";
        const counts = voteCounts(voteDoc, seasonYear, weekNo, "playoffs", matchupKey);
        const aC = counts.get(aId) || 0;
        const bC = counts.get(bId) || 0;
        if (aC > bC) return aId;
        if (bC > aC) return bId;
        const aSeed = Number(seedMap[aId] || 10000);
        const bSeed = Number(seedMap[bId] || 10000);
        if (aSeed < bSeed) return aId;
        if (bSeed < aSeed) return bId;
        return aId < bId ? aId : bId;
      };

      const getIpHash = async () => {
        const ip =
          safeStr(request.headers.get("CF-Connecting-IP")) ||
          safeStr((request.headers.get("X-Forwarded-For") || "").split(",")[0]) ||
          "";
        const salt = safeStr(env.MCM_SALT || "");
        return sha256Hex(`${salt}|${ip}`);
      };

      if (path.startsWith("/mcm")) {
        const seed = await fetchJson(MCM_SEED_URL, null);
        if (!seed || seed.schema_version !== "v1") {
          return jsonOut(500, { ok: false, error: "MCM seed missing or invalid." });
        }
        const genreLookup = {};
        const genres = Array.isArray(seed.genres) ? seed.genres : [];
        for (const g of genres) if (g && safeStr(g.id)) genreLookup[safeStr(g.id)] = g;
        const cycleRaw = Array.isArray(seed.genres_cycle) ? seed.genres_cycle : genres.map((g) => g.id);
        const cycle = cycleRaw.map(safeStr).filter((x) => x && genreLookup[x]);
        if (!cycle.length) return jsonOut(500, { ok: false, error: "MCM genres_cycle invalid." });

        const voteDoc = await fetchJson(MCM_VOTES_URL, { votes: [] });
        const nomDoc = await fetchJson(MCM_NOMS_URL, { nominations: [] });
        const nominees = buildNominees(seed, nomDoc);
        const nomineesById = {};
        for (const n of nominees) nomineesById[n.id] = n;

        const reqWeek = safeStr(url.searchParams.get("week_no"));
        const week = reqWeek ? weekInfoByNumber(seed, cycle, reqWeek) : weekInfoNow(seed, cycle);
        const round = week.phase === "playoffs" ? playoffRoundForWeek(week.week_no, week.regular_weeks, week.playoff_weeks) : null;

        const decorate = (n) => ({
          ...n,
          genre: genreLookup[n.genre_id] || { id: n.genre_id, name: n.genre_id },
        });

        if (path === "/mcm/config" && request.method === "GET") {
          return jsonOut(200, {
            ok: true,
            season: seed.season || {},
            genres,
            genres_cycle: cycle,
          });
        }

        if (path === "/mcm/week" && request.method === "GET") {
          const out = { ...week };
          out.genre = week.phase === "regular" ? genreLookup[week.genre_id] : { id: "playoffs", name: "Playoffs" };
          return jsonOut(200, { ok: true, week: out, round });
        }

        if (path === "/mcm/botd" && request.method === "GET") {
          const active = nominees.filter((n) => n.active);
          if (!active.length) return jsonOut(200, { ok: true, nominee: null, date_utc: utcYmd(new Date()) });
          const today = new Date();
          const ord = Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 86400000);
          const idx = (ord + 1337) % active.length;
          return jsonOut(200, { ok: true, nominee: decorate(active[idx]), date_utc: utcYmd(today) });
        }

        if (path === "/mcm/ballot" && request.method === "GET") {
          if (week.phase === "regular") {
            const ballotSize = Number(seed?.season?.ballot_size || 8);
            const picks = nominees
              .filter((n) => n.active && n.genre_id === week.genre_id)
              .sort((a, b) => (b.source || "").localeCompare(a.source || "") || (a.display_name || "").localeCompare(b.display_name || ""))
              .slice(0, ballotSize);
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "regular", "regular");
            const ballot = picks.map((n) => ({ ...decorate(n), votes: counts.get(n.id) || 0, matchup_key: "regular" }));
            return jsonOut(200, { ok: true, week, ballot });
          }

          if (!round) return jsonOut(400, { ok: false, error: "Playoff schedule not configured." });
          const seedMap = seedMapFromVotes(voteDoc, nominees.filter((n) => n.active), week.season_year, week.regular_weeks, 16);

          // Prior winners
          const r16Pairs = matchupPairsForRound("R16", seedMap, {});
          const r16Week = week.regular_weeks + 1;
          const r16Winners = {};
          for (const [key, a, b] of r16Pairs) r16Winners[key] = winnerForMatchup(voteDoc, week.season_year, r16Week, key, a, b, seedMap);
          const qfPairs = matchupPairsForRound("QF", seedMap, r16Winners);
          const qfWeek = week.regular_weeks + 2;
          const qfWinners = {};
          for (const [key, a, b] of qfPairs) qfWinners[key] = winnerForMatchup(voteDoc, week.season_year, qfWeek, key, a, b, seedMap);
          const sfPairs = matchupPairsForRound("SF", seedMap, qfWinners);
          const sfWeek = week.regular_weeks + 3;
          const sfWinners = {};
          for (const [key, a, b] of sfPairs) sfWinners[key] = winnerForMatchup(voteDoc, week.season_year, sfWeek, key, a, b, seedMap);

          let pairs = [];
          if (round.id === "R16") pairs = r16Pairs;
          else if (round.id === "QF") pairs = qfPairs;
          else if (round.id === "SF") pairs = sfPairs;
          else pairs = matchupPairsForRound("F", seedMap, sfWinners);

          const matchups = [];
          for (const [matchupKey, aId, bId] of pairs) {
            const candidates = [];
            for (const nid of [aId, bId]) {
              if (!nid || !nomineesById[nid]) continue;
              candidates.push({
                ...decorate(nomineesById[nid]),
                seed: seedMap[nid] || null,
                matchup_key: matchupKey,
              });
            }
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "playoffs", matchupKey);
            for (const c of candidates) c.votes = counts.get(c.id) || 0;
            matchups.push({ matchup_key: matchupKey, candidates });
          }

          return jsonOut(200, { ok: true, week, round, matchups, seeds: seedMap });
        }

        if (path === "/mcm/results" && request.method === "GET") {
          if (week.phase === "regular") {
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "regular", "regular");
            const results = Array.from(counts.entries())
              .map(([id, votes]) => ({ id, votes }))
              .filter((r) => nomineesById[r.id])
              .map((r) => ({ ...decorate(nomineesById[r.id]), votes: r.votes }))
              .sort((a, b) => (b.votes - a.votes) || (a.display_name || "").localeCompare(b.display_name || ""));
            return jsonOut(200, { ok: true, week, results });
          }

          if (!round) return jsonOut(400, { ok: false, error: "Playoff schedule not configured." });
          const seedMap = seedMapFromVotes(voteDoc, nominees.filter((n) => n.active), week.season_year, week.regular_weeks, 16);

          const r16Pairs = matchupPairsForRound("R16", seedMap, {});
          const r16Week = week.regular_weeks + 1;
          const r16Winners = {};
          for (const [key, a, b] of r16Pairs) r16Winners[key] = winnerForMatchup(voteDoc, week.season_year, r16Week, key, a, b, seedMap);
          const qfPairs = matchupPairsForRound("QF", seedMap, r16Winners);
          const qfWeek = week.regular_weeks + 2;
          const qfWinners = {};
          for (const [key, a, b] of qfPairs) qfWinners[key] = winnerForMatchup(voteDoc, week.season_year, qfWeek, key, a, b, seedMap);
          const sfPairs = matchupPairsForRound("SF", seedMap, qfWinners);
          const sfWeek = week.regular_weeks + 3;
          const sfWinners = {};
          for (const [key, a, b] of sfPairs) sfWinners[key] = winnerForMatchup(voteDoc, week.season_year, sfWeek, key, a, b, seedMap);

          let pairs = [];
          if (round.id === "R16") pairs = r16Pairs;
          else if (round.id === "QF") pairs = qfPairs;
          else if (round.id === "SF") pairs = sfPairs;
          else pairs = matchupPairsForRound("F", seedMap, sfWinners);

          const matchups = [];
          for (const [matchupKey, aId, bId] of pairs) {
            const candidates = [];
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "playoffs", matchupKey);
            for (const nid of [aId, bId]) {
              if (!nid || !nomineesById[nid]) continue;
              candidates.push({
                ...decorate(nomineesById[nid]),
                seed: seedMap[nid] || null,
                matchup_key: matchupKey,
                votes: counts.get(nid) || 0,
              });
            }
            const winnerId = winnerForMatchup(voteDoc, week.season_year, week.week_no, matchupKey, aId, bId, seedMap);
            matchups.push({ matchup_key: matchupKey, candidates, winner_nominee_id: winnerId });
          }
          return jsonOut(200, { ok: true, week, round, matchups });
        }

        if (path === "/mcm/nominate" && request.method === "POST") {
          let payload = null;
          try {
            payload = await request.json();
          } catch (_) {
            return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
          }

          const displayName = safeStr(payload?.display_name);
          const genreId = safeStr(payload?.genre_id);
          const primaryUrl = safeStr(payload?.primary_url);
          const imageUrl = safeStr(payload?.image_url);
          const notes = safeStr(payload?.notes);
          const attAdult = !!payload?.attestation_adult;
          const attRespectful = !!payload?.attestation_respectful;

          const errors = [];
          if (displayName.length < 2 || displayName.length > 80) errors.push("display_name must be 2-80 chars.");
          if (!genreLookup[genreId]) errors.push("Invalid genre_id.");
          if (!isValidUrl(primaryUrl) || primaryUrl.length > 500) errors.push("primary_url must be a valid http(s) URL.");
          if (imageUrl && (!isValidUrl(imageUrl) || imageUrl.length > 500)) errors.push("image_url must be a valid http(s) URL or blank.");
          if (notes.length > 500) errors.push("notes max length is 500.");
          if (!attAdult) errors.push("attestation_adult is required.");
          if (!attRespectful) errors.push("attestation_respectful is required.");
          if (errors.length) return jsonOut(400, { ok: false, errors });

          const ipHash = await getIpHash();
          const dispatchOut = await dispatchRepoEvent("log-mcm-nomination", {
            display_name: displayName,
            genre_id: genreId,
            primary_url: primaryUrl,
            image_url: imageUrl,
            notes,
            ip_hash: ipHash,
            attestation_adult: attAdult ? 1 : 0,
            attestation_respectful: attRespectful ? 1 : 0,
            created_at_utc: utcNowIso(),
            status: "approved",
            source: "worker-mcm-nominate",
          });
          if (!dispatchOut.ok) return jsonOut(500, { ok: false, error: dispatchOut.reason || "Dispatch failed." });
          return jsonOut(201, { ok: true, message: "Nomination queued." });
        }

        if (path === "/mcm/vote" && request.method === "POST") {
          let payload = null;
          try {
            payload = await request.json();
          } catch (_) {
            return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
          }
          const nomineeId = safeStr(payload?.nominee_id);
          const matchupKey = safeStr(payload?.matchup_key || "regular") || "regular";
          if (!nomineeId) return jsonOut(400, { ok: false, error: "nominee_id is required." });
          if (matchupKey.length > 40) return jsonOut(400, { ok: false, error: "matchup_key too long." });
          const nominee = nomineesById[nomineeId];
          if (!nominee) return jsonOut(400, { ok: false, error: "Unknown nominee_id." });

          if (week.phase === "regular") {
            if (matchupKey !== "regular") return jsonOut(400, { ok: false, error: "matchup_key is not used for regular weeks." });
            if (nominee.genre_id !== week.genre_id) return jsonOut(400, { ok: false, error: "Nominee not on this week's ballot." });
          } else {
            if (!round) return jsonOut(400, { ok: false, error: "Playoff schedule not configured." });
            if (matchupKey === "regular") return jsonOut(400, { ok: false, error: "matchup_key is required for playoff votes." });

            const seedMap = seedMapFromVotes(voteDoc, nominees.filter((n) => n.active), week.season_year, week.regular_weeks, 16);
            const r16Pairs = matchupPairsForRound("R16", seedMap, {});
            const r16Week = week.regular_weeks + 1;
            const r16Winners = {};
            for (const [key, a, b] of r16Pairs) r16Winners[key] = winnerForMatchup(voteDoc, week.season_year, r16Week, key, a, b, seedMap);
            const qfPairs = matchupPairsForRound("QF", seedMap, r16Winners);
            const qfWeek = week.regular_weeks + 2;
            const qfWinners = {};
            for (const [key, a, b] of qfPairs) qfWinners[key] = winnerForMatchup(voteDoc, week.season_year, qfWeek, key, a, b, seedMap);
            const sfPairs = matchupPairsForRound("SF", seedMap, qfWinners);
            const sfWeek = week.regular_weeks + 3;
            const sfWinners = {};
            for (const [key, a, b] of sfPairs) sfWinners[key] = winnerForMatchup(voteDoc, week.season_year, sfWeek, key, a, b, seedMap);

            let pairs = [];
            if (round.id === "R16") pairs = r16Pairs;
            else if (round.id === "QF") pairs = qfPairs;
            else if (round.id === "SF") pairs = sfPairs;
            else pairs = matchupPairsForRound("F", seedMap, sfWinners);

            const m = pairs.find((p) => p[0] === matchupKey);
            if (!m) return jsonOut(400, { ok: false, error: "Unknown matchup_key for this round." });
            const aId = m[1];
            const bId = m[2];
            if (nomineeId !== aId && nomineeId !== bId) return jsonOut(400, { ok: false, error: "Nominee not in this matchup." });
          }

          const ipHash = await getIpHash();
          // Enforce one vote per IP per week/matchup_key against current log.
          const votes = Array.isArray(voteDoc?.votes) ? voteDoc.votes : [];
          const already = votes.some((v) => {
            if (!v) return false;
            if (Number(v.season_year) !== Number(week.season_year)) return false;
            if (Number(v.week_no) !== Number(week.week_no)) return false;
            if (safeStr(v.matchup_key || "regular") !== matchupKey) return false;
            return safeStr(v.ip_hash) === ipHash;
          });
          if (already) {
            return jsonOut(409, {
              ok: false,
              error: week.phase === "regular" ? "You already voted this week (per IP)." : "You already voted in this matchup (per IP).",
            });
          }

          const dispatchOut = await dispatchRepoEvent("log-mcm-vote", {
            season_year: week.season_year,
            week_no: week.week_no,
            matchup_key: matchupKey,
            nominee_id: nomineeId,
            ip_hash: ipHash,
            submitted_at_utc: utcNowIso(),
            source: "worker-mcm-vote",
          });
          if (!dispatchOut.ok) return jsonOut(500, { ok: false, error: dispatchOut.reason || "Dispatch failed." });

          return jsonOut(201, {
            ok: true,
            message: "Vote queued.",
            nominee_id: nomineeId,
            nominee_name: nominee.display_name,
            week_no: week.week_no,
            season_year: week.season_year,
            matchup_key: matchupKey,
          });
        }

        return jsonOut(404, { ok: false, error: "Not found" });
      }

      // ---------- Cookie ----------
      const cookie = env.MFL_COOKIE || "";
      if (!cookie) {
        return new Response(
          JSON.stringify({ ok: false, isAdmin: false, reason: "Missing MFL_COOKIE secret" }),
          { status: 500, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }
      const normalizeCookieValue = (raw) => {
        let v = String(raw || "").trim();
        if (!v) return "";
        v = v.replace(/^MFL_USER_ID=/i, "").split(";")[0].trim();
        try {
          v = decodeURIComponent(v);
        } catch (_) {}
        return v;
      };
      const secretCookieValue = normalizeCookieValue(cookie);
      const browserCookieValue = normalizeCookieValue(browserMflUserId);
      const sessionByCookie = !!browserCookieValue && browserCookieValue === secretCookieValue;
      const commishApiKey = String(env.COMMISH_API_KEY || "").trim();
      const sessionByApiKey = !!commishApiKey && !!browserApiKey && browserApiKey === commishApiKey;
      const sessionKnown = !!browserCookieValue || (!!commishApiKey && !!browserApiKey);
      const sessionMatch = sessionByCookie || sessionByApiKey;
      const cookieHeader = cookie.includes("=") ? cookie : `MFL_USER_ID=${cookie}`;

      const getLeagueAdminState = async (leagueId, year) => {
        const mflUrl = `https://api.myfantasyleague.com/${encodeURIComponent(
          year
        )}/export?TYPE=league&L=${encodeURIComponent(leagueId)}&JSON=1&_=${Date.now()}`;

        const res = await fetch(mflUrl, {
          headers: {
            Cookie: cookieHeader,
            "User-Agent": "ups-league-data-worker",
          },
          cf: { cacheTtl: 0, cacheEverything: false },
        });

        if (!res.ok) {
          return {
            ok: false,
            isAdmin: false,
            reason: `MFL HTTP ${res.status}`,
            emailCount: 0,
            mflHttp: res.status,
          };
        }

        const data = await res.json();
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

        let commishFranchiseId = "";
        try {
          const myFrUrl = `https://api.myfantasyleague.com/${encodeURIComponent(
            year
          )}/export?TYPE=myfranchise&L=${encodeURIComponent(leagueId)}&JSON=1&_=${Date.now()}`;
          const myFrRes = await fetch(myFrUrl, {
            headers: {
              Cookie: cookieHeader,
              "User-Agent": "ups-league-data-worker",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (myFrRes.ok) {
            const myFrData = await myFrRes.json();
            const cand =
              (myFrData &&
                (myFrData?.franchise?.id ||
                  myFrData?.myfranchise?.id ||
                  myFrData?.myfranchise?.franchise?.id ||
                  myFrData?.franchise?.franchise_id ||
                  myFrData?.myfranchise?.franchise_id)) ||
              "";
            commishFranchiseId = String(cand || "")
              .replace(/\D/g, "")
              .padStart(4, "0")
              .slice(-4);
          }
        } catch (_) {}

        return {
          ok: true,
          isAdmin: emailCount > 1,
          reason: emailCount > 1
            ? "Private owner data visible (commish)"
            : "No private owner data visible (not commish)",
          emailCount,
          commishFranchiseId,
          mflHttp: 200,
        };
      };

      async function dispatchRepoEvent(eventType, clientPayload) {
        const repoOwner = String(env.GITHUB_REPO_OWNER || "keithcreelman").trim();
        const repoName = String(env.GITHUB_REPO_NAME || "ups-league-data").trim();
        const githubToken = String(env.GITHUB_PAT || "").trim();
        if (!githubToken) {
          return {
            ok: false,
            queued: false,
            reason: "Missing GITHUB_PAT worker secret",
          };
        }

        const dispatchUrl = `https://api.github.com/repos/${encodeURIComponent(
          repoOwner
        )}/${encodeURIComponent(repoName)}/dispatches`;

        const dispatchRes = await fetch(dispatchUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "ups-league-data-worker",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            event_type: eventType,
            client_payload: clientPayload || {},
          }),
          cf: { cacheTtl: 0, cacheEverything: false },
        });

        if (dispatchRes.status !== 204) {
          const preview = (await dispatchRes.text()).slice(0, 600);
          return {
            ok: false,
            queued: false,
            reason: "GitHub dispatch failed",
            upstreamStatus: dispatchRes.status,
            upstreamPreview: preview,
            repo: `${repoOwner}/${repoName}`,
          };
        }

        return {
          ok: true,
          queued: true,
          reason: "Dispatch queued",
          repo: `${repoOwner}/${repoName}`,
        };
      }

      // ---------- Queue GitHub JSON refresh ----------
      if (path === "/refresh-mym-json") {
        if (request.method !== "POST") {
          return new Response(
            JSON.stringify({ ok: false, reason: "Method not allowed" }),
            { status: 405, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        const leagueId = String(L || "").trim();
        const year = String(YEAR || "2025").trim();
        const adminState = await getLeagueAdminState(leagueId, year);
        if (!adminState.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              queued: false,
              reason: adminState.reason,
              mflHttp: adminState.mflHttp,
            }),
            { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }
        if (!adminState.isAdmin) {
          return new Response(
            JSON.stringify({
              ok: false,
              queued: false,
              reason: "Only league admin can queue refresh",
            }),
            { status: 403, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        const dispatchOut = await dispatchRepoEvent("refresh-mym-json", {
          league_id: leagueId,
          year,
          source: "ccc-roster-refresh",
        });

        if (!dispatchOut.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              queued: false,
              reason: dispatchOut.reason || "GitHub dispatch failed",
              upstreamStatus: dispatchOut.upstreamStatus || 0,
              upstreamPreview: dispatchOut.upstreamPreview || "",
            }),
            { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            queued: true,
            reason: "Refresh queued",
            repo: dispatchOut.repo || "",
          }),
          { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      // ---------- MYM contract submit ----------
      if (
        path === "/offer-mym" ||
        path === "/offer-restructure" ||
        path === "/commish-contract-update"
      ) {
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
        const playerName = String(body.player_name || body.playerName || "").trim();
        const franchiseId = String(body.franchise_id || body.franchiseId || "").trim();
        const franchiseName = String(body.franchise_name || body.franchiseName || "").trim();
        const position = String(body.position || body.pos || "").trim();
        const salary = String(body.salary ?? "").trim();
        const contractYear = String(body.contract_year ?? body.contractYear ?? "").trim();
        const contractInfo = String(body.contract_info || body.contractInfo || "").trim();
        const requestedContractStatus = String(body.contract_status || body.contractStatus || "").trim();
        const contractTypeRaw = String(body.type || "").trim().toLowerCase();
        const isManualContractUpdate =
          path === "/commish-contract-update" || contractTypeRaw.includes("manual_contract_update");
        const isRestructure =
          !isManualContractUpdate &&
          (path === "/offer-restructure" || contractTypeRaw.includes("restructure"));
        const eventType = isRestructure ? "log-restructure-submission" : "log-mym-submission";
        const sourceTag = isRestructure ? "worker-offer-restructure" : "worker-offer-mym";
        const payloadPlayerStatus = String(body.player_status || body.playerStatus || "").trim();
        const overrideAsOfDate = String(
          body.override_as_of_date || body.override_as_of || body.overrideAsOf || ""
        ).trim();
        const submittedAtUtc = String(
          body.submitted_at_utc || body.submittedAtUtc || new Date().toISOString()
        ).trim();
        const commishOverrideFlag = (() => {
          const raw = String(
            body.commish_override_flag || body.commish_override || body.commishOverride || ""
          )
            .trim()
            .toLowerCase();
          return raw === "1" || raw === "true" || raw === "yes" ? 1 : 0;
        })();

        if (!leagueId || !playerId || !salary || !contractYear) {
          return new Response(
            JSON.stringify({
              ok: false,
              reason: "Missing required fields (L, player_id, salary, contract_year)",
            }),
            { status: 400, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        if (isManualContractUpdate) {
          const adminState = await getLeagueAdminState(leagueId, year);
          if (!adminState.ok || !adminState.isAdmin) {
            return new Response(
              JSON.stringify({
                ok: false,
                reason: "Only league admin can perform manual contract updates",
              }),
              { status: 403, headers: { "content-type": "application/json", ...corsHeaders } }
            );
          }
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

        if (!isRestructure && !isManualContractUpdate) {
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
        }

        let contractStatus = "";
        if (isManualContractUpdate) {
          contractStatus = requestedContractStatus || "";
          playerStatusLookup = {
            source: "manual-contract-update",
            value: requestedContractStatus,
            rookie: null,
          };
        } else if (isRestructure) {
          contractStatus = requestedContractStatus || "Veteran";
          playerStatusLookup = {
            source: "restructure-skip-rookie-check",
            value: "",
            rookie: null,
          };
        } else {
          const isRookie =
            playerStatusLookup.rookie !== null
              ? playerStatusLookup.rookie
              : rookieLike(requestedContractStatus);
          contractStatus = isRookie ? "MYM - Rookie" : "MYM - Vet";
        }

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
        let anyChanged = false;

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
          if (changed) anyChanged = true;

          if (changed) break;
        }

        let logDispatch = {
          ok: false,
          queued: false,
          skipped: true,
          reason: isManualContractUpdate ? "Manual update does not dispatch submission log" : "No applied change detected",
        };
        if (looksOk && anyChanged && !isManualContractUpdate) {
          try {
            logDispatch = await dispatchRepoEvent(eventType, {
              league_id: leagueId,
              year: year,
              season: year,
              player_id: playerId,
              player_name: playerName,
              position: position,
              franchise_id: franchiseId,
              franchise_name: franchiseName,
              salary: salary,
              contract_year: contractYear,
              contract_status: statusUsed || contractStatus,
              contract_info: contractInfo,
              submitted_at_utc: submittedAtUtc || new Date().toISOString(),
              commish_override_flag: commishOverrideFlag,
              override_as_of_date: overrideAsOfDate,
              source: sourceTag,
            });
          } catch (e) {
            logDispatch = {
              ok: false,
              queued: false,
              skipped: false,
              reason: `Submission log dispatch error: ${e?.message || String(e)}`,
            };
          }
        }

        return new Response(
          JSON.stringify({
            ok: looksOk,
            reason: looksOk
              ? isManualContractUpdate
                ? "Manual contract update submitted to MFL"
                : "Submitted to MFL"
              : "MFL import rejected request",
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
              isManualContractUpdate,
              logDispatch,
            },
          }),
          { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      const adminState = await getLeagueAdminState(L, YEAR);
      if (!adminState.ok) {
        return new Response(
          JSON.stringify({
            ok: false,
            isAdmin: false,
            reason: adminState.reason,
            sessionKnown,
            sessionMatch,
          }),
          { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          isAdmin: adminState.isAdmin,
          reason: adminState.reason,
          emailCount: adminState.emailCount,
          commishFranchiseId: adminState.commishFranchiseId || "",
          sessionKnown,
          sessionMatch,
          sessionByCookie,
          sessionByApiKey,
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
