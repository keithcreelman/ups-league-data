# mfl_api.py
#
# MFL API helpers with throttling, retries, and league/year awareness.

from urllib.request import urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from datetime import date
import json
import time
import random
import logging
import os
from typing import Dict, Tuple
import sqlite3
import re
import logging

logger = logging.getLogger(__name__)



# --- CONFIG ---

# API key: prefer environment variable `MFL_APIKEY`.
# For convenience this repo keeps the original key as a fallback so
# existing local runs continue to work. If you want to force explicit
# key usage remove the fallback value and set `MFL_APIKEY` instead.
APIKEY = os.environ.get("MFL_APIKEY", "aRBv1sCXvuWqx0CmP13EaDoeFbox")

# These are tuned by callers (e.g. loadplayers.apply_mode)
REQUEST_DELAY = 2.5     # seconds to sleep before each request
REQUEST_JITTER = 0.5    # +/- random jitter
BASE_BACKOFF = 2.0      # base delay for 429 exponential backoff


# Map UPS league history -> MFL server number
# (based on your original hard-coded URLs)

# season -> server_number (as string) OR tuple(server_number, league_id)
SERVER_MAP: Dict[int, str | Tuple[int, str]] = {}


def _normalize_server_value(server: str | int | None) -> str | None:
    """
    Normalize a server value from DB (e.g., 'www45', '45', 48) into just the number
    as a string (e.g., '45').
    """
    if server is None:
        return None
    s = str(server).strip().lower()
    if not s:
        return None
    if s.startswith("www"):
        s = s[3:]
    # strip any leading dots/slashes if ever present
    s = s.lstrip("./")
    return s

def _parse_league_id_from_url(url: str) -> str:
    """
    Extract league_id from a history_url like:
      https://www48.myfantasyleague.com/2012/home/37227

    Returns '37227' or '' if it can't be parsed.
    """
    if not url:
        return ""
    m = re.search(r"/home/(\d+)", url)
    if m:
        return m.group(1)
    # Fallback: last numeric path segment
    m = re.search(r"/(\d+)(?:/?$)", url)
    return m.group(1) if m else ""

def get_server_for_season(season: int) -> str:
    """Return the MFL server number (as string) for a given season."""
    server = SERVER_MAP.get(season)

    # Handle tuple form (server, league_id) for backwards compatibility
    if isinstance(server, (list, tuple)) and server:
        server = server[0]

    norm = _normalize_server_value(server)
    if norm:
        return norm

    if server:
        return str(server)

    # Default to current-style server if we ever go beyond mapped years
    return "48"


def fetch_json(url: str, max_retries: int = 6):
    """
    Fetch JSON with throttling + retries + backoff on 429.

    Returns:
        Parsed JSON dict on success, or None on unrecoverable error.
    """
    for attempt in range(max_retries):
        try:
            # Throttle before each request
            sleep_for = REQUEST_DELAY + random.uniform(-REQUEST_JITTER, REQUEST_JITTER)
            if sleep_for < 0:
                sleep_for = REQUEST_DELAY
            time.sleep(sleep_for)

            logger.info(f"Requesting URL (attempt {attempt+1}/{max_retries}): {url}")
            resp = urlopen(url, timeout=20)
            text = resp.read().decode("utf-8")
            return json.loads(text)

        except HTTPError as e:
            if e.code == 429:
                backoff = BASE_BACKOFF * (2 ** attempt)
                logger.warning(
                    f"429 Too Many Requests for {url}. "
                    f"Sleeping {backoff:.1f}s before retry."
                )
                time.sleep(backoff)
                continue
            logger.error(f"HTTP error {e.code} for {url}: {e}")
            return None

        except URLError as e:
            logger.error(f"URL error for {url}: {e}")
            return None

        except Exception as e:
            logger.error(f"Unexpected error fetching {url}: {e}")
            return None

    logger.error(f"Max retries exceeded for {url}")
    return None


def init_server_map_from_league_years(conn: sqlite3.Connection) -> Dict[int, str]:
    """
    Populate SERVER_MAP from league_years table:
        season -> server (numeric string)

    Safe to call multiple times; updates the global map in place.
    """
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT season, server
        FROM league_years
        WHERE season IS NOT NULL
          AND server IS NOT NULL
        """
    ).fetchall()

    mapping: Dict[int, str] = {}
    for season, server in rows:
        norm = _normalize_server_value(server)
        if not norm:
            continue
        try:
            mapping[int(season)] = norm
        except Exception:
            continue

    if mapping:
        SERVER_MAP.update(mapping)
    return SERVER_MAP


def _ensure_server_map(conn: sqlite3.Connection) -> None:
    """
    Initialize SERVER_MAP lazily from league_years if it's empty.
    """
    if SERVER_MAP:
        return
    try:
        init_server_map_from_league_years(conn)
    except Exception as e:
        logger.warning(f"Could not initialize SERVER_MAP from league_years: {e}")


def build_export_url(server: str, season: int, params: dict) -> str:
    """Build a full MFL export URL for a given server + season + params."""
    base = f"https://www{server}.myfantasyleague.com/{season}/export"
    qs = urlencode(params)
    return f"{base}?{qs}"


def get_nfl_schedule(season: int, week: str | int | None = "ALL") -> dict | None:
    """
    Fetch NFL schedule from MFL (global, not league-specific).
    """
    params = {"TYPE": "nflSchedule", "JSON": 1}
    if week is not None:
        params["W"] = week
    base = f"https://api.myfantasyleague.com/{season}/export"
    qs = urlencode(params)
    return fetch_json(f"{base}?{qs}")


def get_league_id(conn, season: int) -> str:
    """Look up the league_id for a season from league_years."""

    # Allow mapping to include league_id (tuple form)
    mapped = SERVER_MAP.get(season)
    if isinstance(mapped, (list, tuple)) and len(mapped) > 1 and mapped[1]:
        return str(mapped[1])

    cur = conn.cursor()
    row = cur.execute(
        "SELECT league_id FROM league_years WHERE season = ?",
        (season,),
    ).fetchone()
    if not row:
        raise ValueError(f"No league_id found in league_years for season {season}")
    return str(row[0])


def init_server_map_from_history(conn: sqlite3.Connection) -> Dict[int, Tuple[int, str]]:
    """
    Build SERVER_MAP using ONLY rows where season = current season,
    mapping:

        history_year -> (history_server, league_id_from_history_url)

    Example row:
    season = 2025
    history_year = 2012
    history_url = 'https://www45.myfantasyleague.com/2012/home/37227'
    history_server = 45

    => mapping[2012] = (45, '37227')
    """
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 1) Find current season = max(season)
    cur.execute("SELECT MAX(season) AS current_season FROM metadata_leaguehistory")
    row = cur.fetchone()
    if not row or row["current_season"] is None:
        raise RuntimeError("metadata_leaguehistory has no seasons")

    current_season = int(row["current_season"])

    # 2) Pull history rows for that season
    cur.execute(
        """
        SELECT history_year,
            history_server,
            history_url
        FROM metadata_leaguehistory
        WHERE season = ?
        AND history_year IS NOT NULL
        AND history_server IS NOT NULL
        AND history_url IS NOT NULL
        """,
        (current_season,),
    )

    mapping: Dict[int, Tuple[int, str]] = {}
    for r in cur.fetchall():
        history_year = int(r["history_year"])
        server_num   = int(r["history_server"])
        url          = r["history_url"]

        league_id = _parse_league_id_from_url(url)
        if not league_id:
            logger.warning(
                "Could not parse league_id from history_url=%r for history_year=%s",
                url, history_year,
            )
            continue

        mapping[history_year] = (server_num, league_id)

    if not mapping:
        raise RuntimeError(
            f"No history mappings found for current season={current_season} "
            "in metadata_leaguehistory"
        )

    # Store in global
    global SERVER_MAP
    SERVER_MAP = mapping

    # Optional debug print
    print("League/server mapping (from history_year):")
    for yr in sorted(SERVER_MAP):
        server_num, league_id = SERVER_MAP[yr]
        print(f"  {yr}: www{server_num}.myfantasyleague.com, league {league_id}")

    return SERVER_MAP
# --------------------------------------------------------------------
# Public API helpers: players & rosters
# --------------------------------------------------------------------

def get_players(conn, season: int, details: bool = True):
    """Return JSON for players for a given season."""
    _ensure_server_map(conn)
    server = get_server_for_season(season)
    league_id = get_league_id(conn, season)

    params = {
        "TYPE": "players",
        "L": league_id,
        "JSON": "1",
    }
    if APIKEY:
        params["APIKEY"] = APIKEY
    if details:
        params["DETAILS"] = "1"

    url = build_export_url(server, season, params)
    return fetch_json(url)


def get_rosters(conn, season: int, week: int | None = None):
    """Return JSON for rosters for a given season and optional week."""
    _ensure_server_map(conn)
    server = get_server_for_season(season)
    league_id = get_league_id(conn, season)

    params = {
        "TYPE": "rosters",
        "L": league_id,
        "JSON": "1",
        "FRANCHISE": "",
    }
    if APIKEY:
        params["APIKEY"] = APIKEY
    if week is not None:
        params["W"] = str(week)

    url = build_export_url(server, season, params)
    return fetch_json(url)


# --------------------------------------------------------------------
# playerScores API wrapper
# --------------------------------------------------------------------

def _has_player_scores(data: dict) -> bool:
    """Internal: check if JSON payload contains any playerScore entries."""
    if not data or "playerScores" not in data:
        return False
    ps_block = data["playerScores"]
    if not isinstance(ps_block, dict):
        return False
    if "playerScore" not in ps_block:
        return False
    # playerScore can be list or single dict
    val = ps_block["playerScore"]
    if isinstance(val, list):
        return len(val) > 0
    return True  # single dict


def get_player_scores(
    conn,
    season: int,
    week: int,
    mode: str = "auto",
):
    """
    Return JSON for playerScores for a given season + week.

    Args:
        conn: sqlite3 connection (for league_years lookup).
        season: fantasy season (int).
        week: week number (int).
        mode:
            - "auto": try league-scoped playerScores first; if no results or
                      league_id missing, fall back to global playerScores
                      (no L/APIKEY).
            - "league": only call league-scoped playerScores (requires league_id).
            - "global": only call global playerScores (no L/APIKEY).

    Returns:
        JSON dict from MFL or None on error.
    """
    _ensure_server_map(conn)
    server = get_server_for_season(season)
    mode = (mode or "auto").lower()

    league_json = None

    # ------------------------
    # 1) League-scoped attempt
    # ------------------------
    if mode in ("auto", "league"):
        try:
            league_id = get_league_id(conn, season)
        except ValueError as e:
            logger.warning(f"get_player_scores: {e}")
            league_id = None

        if league_id:
            league_params = {
                "TYPE": "playerScores",
                "L": league_id,
                "W": str(week),
                "YEAR": str(season),
                "JSON": "1",
            }
            if APIKEY:
                league_params["APIKEY"] = APIKEY
            league_url = build_export_url(server, season, league_params)
            league_json = fetch_json(league_url)

            # If caller explicitly wants league-only, just return what we got
            if mode == "league":
                return league_json

            # In auto mode: if this has real scores, use it
            if _has_player_scores(league_json):
                return league_json
            else:
                logger.info(
                    f"get_player_scores(auto): no league-scoped scores for "
                    f"season={season}, week={week}; falling back to global."
                )

        elif mode == "league":
            # No league_id available but caller insisted on league-only
            logger.error(
                f"get_player_scores(mode='league'): no league_id for season {season}"
            )
            return None

    # ------------------------
    # 2) Global fallback (no league)
    # ------------------------
    if mode in ("auto", "global"):
        global_params = {
            "TYPE": "playerScores",
            "W": str(week),
            "YEAR": str(season),
            "JSON": "1",
        }
        global_url = build_export_url(server, season, global_params)
        global_json = fetch_json(global_url)

        if not _has_player_scores(global_json):
            logger.warning(
                f"get_player_scores({mode}): no global scores for "
                f"season={season}, week={week}"
            )
        return global_json

    # Should never hit here
    logger.error(f"get_player_scores: invalid mode '{mode}'")
    return None


# -------------------------------------------------------------------
# Transactions API wrapper
# -------------------------------------------------------------------

def get_transactions(conn, season: int | None):
    """
    Return JSON for transactions.

    - If season is None: detect the current MFL season (fantasy year).
    - Uses same server/year/league_id/APIKEY + throttling as rosters/players.
    """
    _ensure_server_map(conn)
    # Determine season if missing
    if season is None:
        today = date.today()
        season = today.year

    server = get_server_for_season(season)
    league_id = get_league_id(conn, season)

    params = {
        "TYPE": "transactions",
        "L": league_id,
        "JSON": "1",
    }
    if APIKEY:
        params["APIKEY"] = APIKEY

    url = build_export_url(server, season, params)
    return fetch_json(url)

# --------------------------------------------------------------------
# League metadata (TYPE=league)
# --------------------------------------------------------------------

def get_metadata_rawjson(conn, season: int):
    """
    Fetch TYPE=league JSON for a given season.

    IMPORTANT:
    - APIKEY must NOT be included. Older leagues reject APIKEY entirely.
    - TYPE=league is public on MFL, so API key is unnecessary.
    """
    _ensure_server_map(conn)
    server = get_server_for_season(season)
    league_id = get_league_id(conn, season)

    params = {
        "TYPE": "league",
        "L": league_id,
        "JSON": "1"
        # DO NOT include APIKEY here
    }

    url = build_export_url(server, season, params)
    return fetch_json(url)
    """
    Fetch TYPE=league JSON for a given season.

    Uses:
      - server = get_server_for_season(season)
      - league_id from league_years (if available)
      - APIKEY for league-scoped call

    Returns:
        Parsed JSON dict on success, or None on error.
    """
    server = get_server_for_season(season)

    # Try to get a league_id from league_years; if not there, we still
    # attempt a global TYPE=league call without L/APIKEY (just in case).
    try:
        league_id = get_league_id(conn, season)
    except ValueError as e:
        logger.warning(f"get_metadata_rawjson: {e}")
        league_id = None

    params = {
        "TYPE": "league",
        "JSON": "1",
    }

    # If we know the league_id, do a league-scoped call (this matches
    # the league2011 / league2025 JSON you've already pulled). Only
    # include an API key if one is configured via `MFL_APIKEY`.
    if league_id:
        params["L"] = league_id
        if APIKEY:
            params["APIKEY"] = APIKEY

    url = build_export_url(server, season, params)
    return fetch_json(url)
