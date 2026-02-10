#!/usr/bin/env python3
"""
Build season-by-season contract lineage snapshots.

This starts with a single position group (default QB) and creates:
1) CSV output for review
2) SQLite table: contract_history_snapshots

Key rollover rule:
- If prior season ends with contract_year = 1, that contract is treated as expired
  at the next season start (expected rollover under-contract = 0).
- If such a player is still under contract at next season week 1, and did not come
  through auction or BBID_WAIVER, we infer an extension.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from db_utils import DEFAULT_DB_PATH, get_conn
from mfl_api import get_nfl_schedule

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - best-effort fallback
    ZoneInfo = None


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = ROOT_DIR / "reports"
DEFAULT_TABLE = "contract_history_snapshots"
DEFAULT_OWNER_LINEAGE_TABLE = "contract_history_owner_lineage"
DEFAULT_TXN_SNAPSHOT_TABLE = "contract_history_transaction_snapshots"
EASTERN_TZ = ZoneInfo("America/New_York") if ZoneInfo else None
SCHEDULE_CACHE: Dict[int, Dict[int, Tuple[date, date]]] = {}
FRANCHISE_NAME_CACHE: Dict[Tuple[int, str], str] = {}


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def parse_money_token(token: str) -> int:
    t = safe_str(token).upper().replace("$", "").replace(",", "")
    if not t:
        return 0
    t = re.sub(r"[^0-9K.\-]", "", t)
    if not t:
        return 0
    mult = 1
    if "K" in t:
        t = t.replace("K", "")
        mult = 1000
    if not t:
        return 0
    try:
        val = float(t)
    except ValueError:
        return 0
    out = int(val * mult)
    # Fallback for shorthand numbers without K.
    if mult == 1 and out > 0 and out < 1000:
        out *= 1000
    return out


@dataclass
class ContractParts:
    contract_length: int
    tcv: int
    aav: int
    year_values_json: str
    year_values_count: int
    extension_flag: int
    multi_aav_flag: int
    parsed_aav_source: str


def parse_contract_parts(contract_info: str, salary: int, contract_year: int) -> ContractParts:
    txt = safe_str(contract_info)

    m_cl = re.search(r"\bCL\s+([0-9]+)\b", txt, re.IGNORECASE)
    cl = safe_int(m_cl.group(1), contract_year if contract_year > 0 else 1) if m_cl else (
        contract_year if contract_year > 0 else 1
    )
    if cl <= 0:
        cl = 1

    m_tcv = re.search(r"\bTCV\s+([0-9]+(?:\.[0-9]+)?K?)", txt, re.IGNORECASE)
    tcv = parse_money_token(m_tcv.group(1)) if m_tcv else 0

    # Some rows contain multiple AAV labels. Per your rule, if multiple are present,
    # use the second one and flag it for review.
    aav_tokens = re.findall(r"\bAAV\s+([0-9]+(?:\.[0-9]+)?K?)", txt, re.IGNORECASE)
    multi_aav_flag = 1 if len(aav_tokens) >= 2 else 0
    if len(aav_tokens) >= 2:
        aav = parse_money_token(aav_tokens[1])
        aav_source = "aav_token_2"
    elif len(aav_tokens) == 1:
        # Handle split forms like "AAV 5K/15K" by taking first segment.
        aav = parse_money_token(aav_tokens[0].split("/")[0])
        aav_source = "aav_token_1"
    else:
        aav = 0
        aav_source = ""

    year_values: Dict[str, int] = {}
    for yidx, amt in re.findall(r"\bY([0-9]+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)", txt, re.IGNORECASE):
        yval = parse_money_token(amt)
        if yval > 0:
            year_values[f"Y{safe_int(yidx, 0)}"] = yval

    # Handle legacy bracket lists like "[5K, 3K, 1K]"
    if not year_values:
        m_list = re.search(r"\[([0-9Kk.,\s]+)\]", txt)
        if m_list:
            tokens = re.findall(r"[0-9]+(?:\.[0-9]+)?K?", m_list.group(1))
            for idx, tok in enumerate(tokens, 1):
                val = parse_money_token(tok)
                if val > 0:
                    year_values[f"Y{idx}"] = val

    if tcv <= 0 and year_values:
        tcv = sum(year_values.values())
    if tcv <= 0 and salary > 0 and cl > 0:
        tcv = salary * cl

    if aav <= 0:
        if tcv > 0 and cl > 0:
            aav = safe_int(tcv / cl, salary)
            aav_source = "tcv_div_cl"
        else:
            aav = salary
            aav_source = "salary"

    extension_flag = 1 if "EXT:" in txt.upper() else 0

    return ContractParts(
        contract_length=cl,
        tcv=tcv,
        aav=aav,
        year_values_json=json.dumps(year_values, separators=(",", ":")),
        year_values_count=len(year_values),
        extension_flag=extension_flag,
        multi_aav_flag=multi_aav_flag,
        parsed_aav_source=aav_source,
    )


def parse_iso_date(value: str) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_kickoff_to_date(value: Any) -> Optional[date]:
    s = safe_str(value)
    if not s:
        return None
    try:
        if s.isdigit():
            dt = datetime.fromtimestamp(int(s), tz=timezone.utc)
        else:
            # Handles "YYYY-MM-DD HH:MM:SS" and ISO-8601.
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
    except (ValueError, OSError):
        return None
    if EASTERN_TZ:
        dt = dt.astimezone(EASTERN_TZ)
    return dt.date()


def calc_earned_to_date(contract_length: int, years_remaining: int, aav: int, year_values_json: str) -> int:
    if contract_length <= 0 or aav <= 0:
        return 0
    elapsed = max(0, contract_length - max(0, years_remaining))
    if elapsed <= 0:
        return 0
    try:
        year_values = json.loads(year_values_json or "{}")
    except json.JSONDecodeError:
        year_values = {}
    total = 0
    for yr in range(1, elapsed + 1):
        key = f"Y{yr}"
        val = safe_int(year_values.get(key), 0)
        total += val if val > 0 else aav
    return total


def is_contract_status(status: str) -> bool:
    s = safe_str(status).upper()
    if not s:
        return False
    blocked = ("WW", "WAIVER", "FA", "FREE")
    return not any(tok in s for tok in blocked)


def normalize_position(pos: str) -> str:
    p = safe_str(pos).upper()
    if p in {"K", "PK", "PN"}:
        return "PK"
    return p


def format_k(amount: int) -> str:
    amt = safe_int(amount, 0)
    if amt <= 0:
        return "0K"
    if amt % 1000 == 0:
        return f"{amt // 1000}K"
    sval = f"{(amt / 1000):.1f}".rstrip("0").rstrip(".")
    return f"{sval}K"


def parse_year_values_json(raw: str) -> Dict[int, int]:
    out: Dict[int, int] = {}
    txt = safe_str(raw)
    if not txt:
        return out
    try:
        obj = json.loads(txt)
    except json.JSONDecodeError:
        return out
    if not isinstance(obj, dict):
        return out
    for k, v in obj.items():
        m = re.match(r"^Y([0-9]+)$", safe_str(k), re.IGNORECASE)
        if not m:
            continue
        idx = safe_int(m.group(1), 0)
        val = safe_int(v, 0)
        if idx > 0 and val > 0:
            out[idx] = val
    return out


def parse_id_list(value: str) -> List[str]:
    if not value:
        return []
    parts = [p.strip() for p in value.split(",") if p.strip()]
    return [p for p in parts if p.isdigit()]


def parse_transaction_ids(raw_transaction: str) -> Tuple[List[str], List[str]]:
    """
    Parse MFL transaction field into (added_ids, dropped_ids).

    Examples:
      "13589,|2000|13215," -> add 13589, drop 13215
      "|13589,12630,"     -> drop 13589,12630
    """
    if not raw_transaction:
        return [], []
    parts = raw_transaction.split("|")
    if len(parts) == 1:
        add_ids = parse_id_list(parts[0])
        return add_ids, []
    add_ids = parse_id_list(parts[0]) if parts[0] else []
    drop_ids = parse_id_list(parts[-1]) if parts[-1] else []
    return add_ids, drop_ids


def lookup_franchise_name(conn: sqlite3.Connection, season: int, franchise_id: str) -> str:
    fid = safe_str(franchise_id).zfill(4)[-4:]
    if not fid:
        return ""
    key = (season, fid)
    if key in FRANCHISE_NAME_CACHE:
        return FRANCHISE_NAME_CACHE[key]
    name = ""
    row = conn.execute(
        "SELECT franchise_name FROM metadata_franchise WHERE season = ? AND franchise_id = ? LIMIT 1",
        (season, fid),
    ).fetchone()
    if row and safe_str(row[0]):
        name = safe_str(row[0])
    if not name:
        row2 = conn.execute(
            "SELECT team_name FROM franchises WHERE season = ? AND franchise_id = ? LIMIT 1",
            (season, fid),
        ).fetchone()
        name = safe_str(row2[0]) if row2 else ""
    FRANCHISE_NAME_CACHE[key] = name
    return name


def build_contract_info_string(
    contract_length: int,
    tcv: int,
    aav_label: str,
    year_values: Dict[int, int],
    suffix: str = "",
) -> str:
    cl = max(1, safe_int(contract_length, 1))
    parts = [f"CL {cl}", f"TCV {format_k(tcv)}", f"AAV {aav_label}"]
    if year_values:
        ytxt = ", ".join([f"Y{i}-{format_k(year_values[i])}" for i in sorted(year_values.keys())])
        parts.append(ytxt)
    if suffix:
        parts.append(suffix)
    return "| ".join(parts)


def contract_signature(parts: ContractParts) -> Tuple[int, int, int]:
    return (safe_int(parts.contract_length, 0), safe_int(parts.tcv, 0), safe_int(parts.aav, 0))


def detect_mym_flag(contract_status: str, contract_info: str) -> int:
    txt = f"{safe_str(contract_status)} {safe_str(contract_info)}".upper()
    return 1 if "MYM" in txt else 0


def detect_restructure_flag(contract_status: str, contract_info: str) -> int:
    txt = f"{safe_str(contract_status)} {safe_str(contract_info)}".upper()
    if "RESTRUCT" in txt:
        return 1
    if "RSTR" in txt:
        return 1
    return 0


def pick_year_value(
    year_values: Dict[int, int],
    year_index: int,
    fallback_aav: int,
    fallback_salary: int,
) -> int:
    if year_index > 0 and year_index in year_values and year_values[year_index] > 0:
        return year_values[year_index]
    if fallback_aav > 0:
        return fallback_aav
    return fallback_salary


def prorate_earned_for_drop(
    season: int,
    amount: int,
    drop_date_obj: Optional[date],
    season_end_date: Optional[date],
) -> int:
    if amount <= 0 or not drop_date_obj:
        return 0
    milestones = []
    try:
        milestones = [
            date(season, 9, 30),
            date(season, 10, 31),
            date(season, 11, 30),
            season_end_date or date(season, 12, 31),
        ]
    except ValueError:
        milestones = [season_end_date or date(season, 12, 31)]
    earned_steps = sum(1 for m in milestones if drop_date_obj >= m)
    earned_steps = min(earned_steps, 4)
    return int(round((amount / 4.0) * earned_steps))

def fetch_deadline(conn: sqlite3.Connection, season: int) -> str:
    row = conn.execute(
        "SELECT date FROM leagueevents WHERE event = 'ups_contract_deadline' AND nfl_season = ? LIMIT 1",
        (str(season),),
    ).fetchone()
    return safe_str(row[0]) if row else ""


def get_league_event_date(conn: sqlite3.Connection, season: int, event_name: str) -> str:
    row = conn.execute(
        "SELECT date FROM leagueevents WHERE event = ? AND nfl_season = ? LIMIT 1",
        (event_name, str(season)),
    ).fetchone()
    return safe_str(row[0]) if row else ""


def fetch_max_week(conn: sqlite3.Connection, season: int) -> int:
    row = conn.execute(
        "SELECT MAX(week) FROM rosters_weekly WHERE season = ?",
        (season,),
    ).fetchone()
    return safe_int(row[0], 0) if row else 0


def estimate_week_from_date(
    drop_date: Optional[date],
    kickoff_date: Optional[date],
    max_week: int,
) -> int:
    if not drop_date or not kickoff_date:
        return 0
    delta = (drop_date - kickoff_date).days
    if delta < 0:
        return 0
    week = int(delta // 7) + 1
    if max_week > 0:
        week = min(week, max_week)
    return max(week, 1)


def estimate_week_from_schedule(
    drop_date: Optional[date],
    week_dates: Dict[int, Tuple[date, date]],
) -> int:
    if not drop_date or not week_dates:
        return 0
    items = sorted(week_dates.items(), key=lambda x: x[1][0])
    for idx, (wk, (start_date, _end_date)) in enumerate(items):
        next_start = items[idx + 1][1][0] if idx + 1 < len(items) else None
        if drop_date >= start_date and (next_start is None or drop_date < next_start):
            return wk
    return 0


def fetch_auction_start_date(conn: sqlite3.Connection, season: int) -> str:
    row = conn.execute(
        "SELECT MIN(date_et) FROM transactions_auction WHERE season = ? AND date_et IS NOT NULL",
        (season,),
    ).fetchone()
    return safe_str(row[0]) if row else ""


def fetch_season_end_week(conn: sqlite3.Connection, season: int) -> int:
    """
    Prefer end_week for season completion; fall back to last_regular_season_week.
    """
    try:
        row = conn.execute(
            """
            SELECT end_week, last_regular_season_week
            FROM metadata_leaguedetails
            WHERE season = ?
            LIMIT 1
            """,
            (season,),
        ).fetchone()
    except sqlite3.Error:
        return 0
    if not row:
        return 0
    end_week = safe_int(row[0], 0)
    if end_week > 0:
        return end_week
    return safe_int(row[1], 0)


def extract_schedule_blocks(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not payload:
        return []
    if "fullNflSchedule" in payload:
        blocks = payload.get("fullNflSchedule", {}).get("nflSchedule", [])
    elif "nflSchedule" in payload:
        blocks = payload.get("nflSchedule", [])
    else:
        return []
    if isinstance(blocks, dict):
        blocks = [blocks]
    return [b for b in blocks if isinstance(b, dict)]


def fetch_nfl_schedule_week_dates(season: int) -> Dict[int, Tuple[date, date]]:
    cached = SCHEDULE_CACHE.get(season)
    if cached is not None:
        return cached
    week_dates: Dict[int, Tuple[date, date]] = {}
    payload = get_nfl_schedule(season, week="ALL")
    for block in extract_schedule_blocks(payload or {}):
        week = safe_int(block.get("week"), 0)
        matchups = block.get("matchup", [])
        if isinstance(matchups, dict):
            matchups = [matchups]
        for matchup in matchups:
            if not isinstance(matchup, dict):
                continue
            kickoff_date = parse_kickoff_to_date(matchup.get("kickoff"))
            if not kickoff_date or week <= 0:
                continue
            if week not in week_dates:
                week_dates[week] = (kickoff_date, kickoff_date)
            else:
                start, end = week_dates[week]
                week_dates[week] = (min(start, kickoff_date), max(end, kickoff_date))
    SCHEDULE_CACHE[season] = week_dates
    return week_dates


def get_season_bounds(
    conn: sqlite3.Connection,
    season: int,
) -> Tuple[Optional[date], Optional[date], Dict[int, Tuple[date, date]], int]:
    week_dates = fetch_nfl_schedule_week_dates(season)
    kickoff_date = None
    season_end_date = None
    last_regular_week = fetch_season_end_week(conn, season)

    if week_dates:
        if last_regular_week <= 0:
            last_regular_week = max(week_dates.keys())
        week_numbers = sorted([w for w in week_dates.keys() if w > 0])
        kickoff_date = week_dates[week_numbers[0]][0] if week_numbers else None
        last_week_use = last_regular_week if last_regular_week in week_dates else (week_numbers[-1] if week_numbers else 0)
        if last_week_use and last_week_use in week_dates:
            season_end_date = week_dates[last_week_use][1]

    if not kickoff_date:
        kickoff_date = parse_iso_date(get_league_event_date(conn, season, "nfl_kickoff"))
    if not season_end_date:
        season_end_date = parse_iso_date(get_league_event_date(conn, season, "ups_season_complete"))

    return kickoff_date, season_end_date, week_dates, last_regular_week


def fetch_extension_rate_map(conn: sqlite3.Connection, season: int) -> Dict[str, Dict[str, int]]:
    """
    Return per-position extension rates for a season.
    Keys are normalized positions and positional groupings.
    """
    chosen_season = season
    exact = conn.execute(
        "SELECT COUNT(*) FROM conformance_extensions WHERE season = ?",
        (season,),
    ).fetchone()
    if safe_int(exact[0] if exact else 0, 0) == 0:
        row = conn.execute(
            "SELECT MAX(season) FROM conformance_extensions WHERE season <= ?",
            (season,),
        ).fetchone()
        chosen_season = safe_int(row[0] if row else 0, 0)
        if chosen_season <= 0:
            row2 = conn.execute("SELECT MAX(season) FROM conformance_extensions").fetchone()
            chosen_season = safe_int(row2[0] if row2 else 0, 0)
    if chosen_season <= 0:
        return {}

    sql = """
    SELECT
      COALESCE(position, '') AS position,
      COALESCE(positional_grouping, '') AS positional_grouping,
      COALESCE(extensionrate_1yr, 0) AS extensionrate_1yr,
      COALESCE(extensionrate_2yr, 0) AS extensionrate_2yr
    FROM conformance_extensions
    WHERE season = ?
    """
    out: Dict[str, Dict[str, int]] = {}
    for row in conn.execute(sql, (chosen_season,)).fetchall():
        pos = normalize_position(row[0])
        grp = normalize_position(row[1])
        rate_1 = safe_int(row[2], 0)
        rate_2 = safe_int(row[3], 0)
        if pos:
            out[pos] = {"rate_1yr": rate_1, "rate_2yr": rate_2}
        if grp and grp not in out:
            out[grp] = {"rate_1yr": rate_1, "rate_2yr": rate_2}
    return out


def get_extension_rate(
    rate_map: Dict[str, Dict[str, int]],
    position: str,
    extension_term_years: int,
) -> int:
    rates = rate_map.get(normalize_position(position), {})
    if extension_term_years >= 2:
        return safe_int(rates.get("rate_2yr"), 0)
    if extension_term_years == 1:
        return safe_int(rates.get("rate_1yr"), 0)
    return 0


def fetch_snapshot(
    conn: sqlite3.Connection,
    season: int,
    week: int,
    position: str,
) -> Dict[str, Dict[str, Any]]:
    sql = """
    SELECT
      season, week, franchise_id, team_name, player_id, player_name,
      position, nfl_team, status, salary, contract_year, contract_status, contract_info
    FROM rosters_weekly
    WHERE season = ?
      AND week = ?
      AND UPPER(COALESCE(position, '')) = ?
      AND UPPER(COALESCE(status, '')) IN ('ROSTER', 'INJURED_RESERVE', 'TAXI_SQUAD')
    """
    out: Dict[str, Dict[str, Any]] = {}
    for row in conn.execute(sql, (season, week, position.upper())).fetchall():
        pid = safe_str(row[4])
        if not pid:
            continue
        salary = safe_int(row[9], 0)
        contract_year = safe_int(row[10], 0)
        parts = parse_contract_parts(safe_str(row[12]), salary, contract_year)
        out[pid] = {
            "season": safe_int(row[0], season),
            "week": safe_int(row[1], week),
            "franchise_id": safe_str(row[2]).zfill(4)[-4:],
            "team_name": safe_str(row[3]),
            "player_id": pid,
            "player_name": safe_str(row[5]),
            "position": safe_str(row[6]).upper(),
            "nfl_team": safe_str(row[7]).upper(),
            "status": safe_str(row[8]).upper(),
            "salary": salary,
            "contract_year": contract_year,
            "contract_status": safe_str(row[11]),
            "contract_info": safe_str(row[12]),
            "contract_length": parts.contract_length,
            "tcv": parts.tcv,
            "aav": parts.aav,
            "year_values_json": parts.year_values_json,
            "year_values_count": parts.year_values_count,
            "extension_flag": parts.extension_flag,
            "multi_aav_flag": parts.multi_aav_flag,
            "parsed_aav_source": parts.parsed_aav_source,
        }
    return out


def fetch_seasons(conn: sqlite3.Connection) -> List[int]:
    rows = conn.execute(
        "SELECT DISTINCT season FROM rosters_weekly WHERE week = 1 ORDER BY season"
    ).fetchall()
    return [safe_int(r[0], 0) for r in rows if safe_int(r[0], 0) > 0]


def fetch_prior_week(conn: sqlite3.Connection, season: int) -> int:
    row = conn.execute(
        "SELECT MAX(week) FROM rosters_weekly WHERE season = ?",
        (season,),
    ).fetchone()
    return safe_int(row[0], 0) if row else 0


def fetch_draft_map(
    conn: sqlite3.Connection,
    season: int,
    position: str,
) -> Dict[str, Dict[str, Any]]:
    sql = """
    SELECT d.player_id, d.player_name, d.draftpick_round, d.draftpick_roundorder, d.draftpick_overall,
           d.date_et,
           p.position
    FROM draftresults_mfl d
    LEFT JOIN players p
      ON p.season = d.season
     AND CAST(p.player_id AS TEXT) = CAST(d.player_id AS TEXT)
    WHERE d.season = ?
    """
    out: Dict[str, Dict[str, Any]] = {}
    for row in conn.execute(sql, (season,)).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        pos = normalize_position(row[5])
        if pos != position.upper():
            continue
        overall = safe_int(row[4], 9999)
        if pid in out and overall >= safe_int(out[pid]["draftpick_overall"], 9999):
            continue
        out[pid] = {
            "player_id": pid,
            "player_name": safe_str(row[1]),
            "draftpick_round": safe_int(row[2], 0),
            "draftpick_roundorder": safe_int(row[3], 0),
            "draftpick_overall": overall,
            "date_et": safe_str(row[5]),
        }
    return out


def fetch_auction_winners(
    conn: sqlite3.Connection,
    season: int,
    position: str,
    deadline_date: str,
) -> Dict[str, Dict[str, Any]]:
    sql = """
    SELECT player_id, player_name, bid_amount, auction_type, date_et, unix_timestamp, team_name, franchise_id
    FROM transactions_auction
    WHERE season = ?
      AND finalbid_ind = 1
      AND UPPER(COALESCE(position, '')) = ?
    """
    out: Dict[str, Dict[str, Any]] = {}
    for row in conn.execute(sql, (season, position.upper())).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        date_et = safe_str(row[4])
        if deadline_date and date_et and date_et > deadline_date:
            continue
        ts = safe_int(row[5], 0)
        if pid in out and ts <= safe_int(out[pid]["unix_timestamp"], 0):
            continue
        out[pid] = {
            "player_id": pid,
            "player_name": safe_str(row[1]),
            "bid_amount": safe_int(row[2], 0),
            "auction_type": safe_str(row[3]),
            "date_et": date_et,
            "unix_timestamp": ts,
            "team_name": safe_str(row[6]),
            "franchise_id": safe_str(row[7]).zfill(4)[-4:],
        }
    return out


def fetch_adddrop_events(
    conn: sqlite3.Connection,
    season: int,
    position: str,
    deadline_date: str,
) -> Tuple[Dict[str, List[Dict[str, Any]]], Dict[str, List[Dict[str, Any]]]]:
    sql = """
    SELECT
      player_id, player_name, move_type, method, salary,
      date_et, time_et, unix_timestamp, franchise_id, franchise_name, raw_json
    FROM transactions_adddrop
    WHERE season = ?
      AND UPPER(COALESCE(player_position, '')) = ?
    """
    adds: Dict[str, List[Dict[str, Any]]] = {}
    drops: Dict[str, List[Dict[str, Any]]] = {}

    for row in conn.execute(sql, (season, position.upper())).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        date_et = safe_str(row[5])
        if deadline_date and date_et and date_et > deadline_date:
            continue
        raw_type = ""
        raw_json_txt = safe_str(row[10])
        if raw_json_txt:
            try:
                payload = json.loads(raw_json_txt)
                raw_type = safe_str(payload.get("type"))
            except json.JSONDecodeError:
                raw_type = ""
        item = {
            "player_id": pid,
            "player_name": safe_str(row[1]),
            "move_type": safe_str(row[2]).upper(),
            "method": safe_str(row[3]).upper(),
            "salary": safe_int(row[4], 0),
            "date_et": date_et,
            "time_et": safe_str(row[6]),
            "unix_timestamp": safe_int(row[7], 0),
            "franchise_id": safe_str(row[8]).zfill(4)[-4:],
            "franchise_name": safe_str(row[9]),
            "raw_type": raw_type,
        }
        if item["move_type"] == "ADD":
            adds.setdefault(pid, []).append(item)
        elif item["move_type"] == "DROP":
            drops.setdefault(pid, []).append(item)

    # Include FREE_AGENT drops from transactions_base (older seasons often only live there).
    base_sql = """
    SELECT date_et, time_et, unix_timestamp, raw_json
    FROM transactions_base
    WHERE season = ?
      AND type = 'FREE_AGENT'
    """
    for row in conn.execute(base_sql, (season,)).fetchall():
        raw_json_txt = safe_str(row[3])
        if not raw_json_txt:
            continue
        try:
            payload = json.loads(raw_json_txt)
        except json.JSONDecodeError:
            continue
        drop_ids = []
        add_ids = []
        add_ids, drop_ids = parse_transaction_ids(safe_str(payload.get("transaction")))
        if not drop_ids:
            continue
        franchise_id = safe_str(payload.get("franchise")).zfill(4)[-4:]
        franchise_name = lookup_franchise_name(conn, season, franchise_id)
        date_et = safe_str(row[0])
        if deadline_date and date_et and date_et > deadline_date:
            continue
        for pid in drop_ids:
            prow = conn.execute(
                "SELECT position FROM players WHERE season = ? AND CAST(player_id AS TEXT) = ? LIMIT 1",
                (season, pid),
            ).fetchone()
            if normalize_position(prow[0] if prow else "") != position.upper():
                continue
            drops.setdefault(pid, []).append(
                {
                    "player_id": pid,
                    "player_name": "",
                    "move_type": "DROP",
                    "method": "FREE_AGENT",
                    "salary": 0,
                    "date_et": date_et,
                    "time_et": safe_str(row[1]),
                    "unix_timestamp": safe_int(row[2], 0),
                    "franchise_id": franchise_id,
                    "franchise_name": franchise_name,
                    "raw_type": "FREE_AGENT",
                }
            )

    for values in adds.values():
        values.sort(key=lambda x: (x["unix_timestamp"], x["date_et"], x["time_et"]))
    for values in drops.values():
        values.sort(key=lambda x: (x["unix_timestamp"], x["date_et"], x["time_et"]))
    return adds, drops


def fetch_trade_events(
    conn: sqlite3.Connection,
    season: int,
    position: str,
    deadline_date: str,
) -> Dict[str, List[Dict[str, Any]]]:
    sql = """
    SELECT
      player_id, player_name, date_et, time_et, unix_timestamp,
      franchise_id, franchise_name, franchise_role, asset_role, trade_group_id
    FROM transactions_trades
    WHERE season = ?
      AND UPPER(COALESCE(asset_type, '')) = 'PLAYER'
    """
    out: Dict[str, List[Dict[str, Any]]] = {}
    for row in conn.execute(sql, (season,)).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        # Only keep matching position via players table for same season.
        prow = conn.execute(
            "SELECT position FROM players WHERE season = ? AND CAST(player_id AS TEXT) = ? LIMIT 1",
            (season, pid),
        ).fetchone()
        if normalize_position(prow[0] if prow else "") != position.upper():
            continue
        date_et = safe_str(row[2])
        if deadline_date and date_et and date_et > deadline_date:
            continue
        out.setdefault(pid, []).append(
            {
                "player_id": pid,
                "player_name": safe_str(row[1]),
                "date_et": date_et,
                "time_et": safe_str(row[3]),
                "unix_timestamp": safe_int(row[4], 0),
                "franchise_id": safe_str(row[5]).zfill(4)[-4:],
                "franchise_name": safe_str(row[6]),
                "franchise_role": safe_str(row[7]),
                "asset_role": safe_str(row[8]),
                "trade_group_id": safe_str(row[9]),
            }
        )
    for values in out.values():
        values.sort(key=lambda x: (x["unix_timestamp"], x["date_et"], x["time_et"]))
    return out


def parse_contract_years_from_text(raw_text: str) -> int:
    txt = safe_str(raw_text).upper()
    if not txt:
        return 0
    if 'DEFAULT 1YR' in txt or 'DEFAULT 1 YEAR' in txt:
        return 0
    m = re.search(r"(\d+)\s*(?:YR|YRS|YEAR|YEARS)", txt)
    if m:
        return safe_int(m.group(1), 0)
    return 0


def parse_submitted_at_to_et(value: str) -> tuple[str, str]:
    if not value:
        return "", ""
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return "", ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if EASTERN_TZ:
        dt = dt.astimezone(EASTERN_TZ)
    return dt.strftime('%Y-%m-%d'), dt.strftime('%H:%M:%S')


def fetch_contract_submission_events(
    conn: sqlite3.Connection,
    season: int,
    position: str,
) -> List[Dict[str, Any]]:
    sql = """
    SELECT submission_type, source, season, franchise_id, franchise_name,
           player_id, player_name, position, submitted_at_utc, raw_text
    FROM contract_submissions
    WHERE season = ?
    """
    events: List[Dict[str, Any]] = []
    for row in conn.execute(sql, (season,)).fetchall():
        pid = safe_str(row[5])
        if not pid:
            continue
        pos = normalize_position(row[7])
        if pos != position.upper():
            continue
        raw_text = safe_str(row[9])
        years = parse_contract_years_from_text(raw_text)
        if years <= 0:
            continue
        date_et, time_et = parse_submitted_at_to_et(safe_str(row[8]))
        source = safe_str(row[0]).upper()
        event_source = f"CONTRACT_SUBMISSION:{source}" if source else "CONTRACT_SUBMISSION"
        detail = raw_text if raw_text else f"years={years}"
        if raw_text and f"years={years}" not in raw_text.lower():
            detail = f"{raw_text}|years={years}"
        events.append(
            {
                "season": season,
                "position_filter": position.upper(),
                "player_id": pid,
                "player_name": safe_str(row[6]),
                "nfl_team": "",
                "event_seq": 0,
                "event_type": "CONTRACT_SUBMISSION",
                "event_source": event_source,
                "event_date": date_et,
                "event_time": time_et,
                "franchise_id": safe_str(row[3]).zfill(4)[-4:],
                "team_name": safe_str(row[4]),
                "detail": detail,
                "contract_length_override": years,
                "contract_raw_text": raw_text,
                "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            }
        )
    return events


def fetch_owner_change_events(
    conn: sqlite3.Connection,
    season: int,
    position: str,
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Build owner-change timeline events for a player within a season.
    Includes:
      - TRADE acquire (transactions_trades.asset_role = ACQUIRE)
      - AUCTION winner (transactions_auction.finalbid_ind = 1)
      - ADD / DROP waiver and free-agent events (transactions_adddrop)
    """
    out: Dict[str, List[Dict[str, Any]]] = {}

    # Trades (acquire side only)
    sql_trades = """
    SELECT
      player_id, player_name, date_et, time_et, unix_timestamp,
      franchise_id, franchise_name, trade_group_id
    FROM transactions_trades
    WHERE season = ?
      AND UPPER(COALESCE(asset_type, '')) = 'PLAYER'
      AND UPPER(COALESCE(asset_role, '')) = 'ACQUIRE'
    """
    for row in conn.execute(sql_trades, (season,)).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        prow = conn.execute(
            "SELECT position FROM players WHERE season = ? AND CAST(player_id AS TEXT) = ? LIMIT 1",
            (season, pid),
        ).fetchone()
        if normalize_position(prow[0] if prow else "") != position.upper():
            continue
        out.setdefault(pid, []).append(
            {
                "event_type": "ACQUIRE",
                "event_source": "TRADE",
                "event_date": safe_str(row[2]),
                "event_time": safe_str(row[3]),
                "unix_timestamp": safe_int(row[4], 0),
                "franchise_id": safe_str(row[5]).zfill(4)[-4:],
                "team_name": safe_str(row[6]),
                "detail": safe_str(row[7]),
            }
        )

    # Auction winners
    sql_auction = """
    SELECT
      player_id, player_name, date_et, time_et, unix_timestamp,
      franchise_id, team_name, auction_type, bid_amount
    FROM transactions_auction
    WHERE season = ?
      AND finalbid_ind = 1
      AND UPPER(COALESCE(position, '')) = ?
    """
    for row in conn.execute(sql_auction, (season, position.upper())).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        out.setdefault(pid, []).append(
            {
                "event_type": "ACQUIRE",
                "event_source": f"AUCTION:{safe_str(row[7])}",
                "event_date": safe_str(row[2]),
                "event_time": safe_str(row[3]),
                "unix_timestamp": safe_int(row[4], 0),
                "franchise_id": safe_str(row[5]).zfill(4)[-4:],
                "team_name": safe_str(row[6]),
                "detail": f"bid={safe_int(row[8],0)}",
            }
        )

    # Add/Drop
    sql_adddrop = """
    SELECT
      player_id, player_name, move_type, method, salary, date_et, time_et, unix_timestamp,
      franchise_id, franchise_name, raw_json
    FROM transactions_adddrop
    WHERE season = ?
      AND UPPER(COALESCE(player_position, '')) = ?
    """
    for row in conn.execute(sql_adddrop, (season, position.upper())).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        move_type = safe_str(row[2]).upper()
        if move_type not in {"ADD", "DROP"}:
            continue
        raw_type = ""
        raw_json_txt = safe_str(row[9])
        if raw_json_txt:
            try:
                payload = json.loads(raw_json_txt)
                raw_type = safe_str(payload.get("type"))
            except json.JSONDecodeError:
                raw_type = ""
        salary = safe_int(row[4], 0)
        detail = ""
        if salary > 0:
            detail = f"salary={salary}"
        source_suffix = raw_type if raw_type else safe_str(row[3]).upper()
        out.setdefault(pid, []).append(
            {
                "event_type": "ACQUIRE" if move_type == "ADD" else "DROP",
                "event_source": f"ADDDROP:{source_suffix}",
                "event_date": safe_str(row[5]),
                "event_time": safe_str(row[6]),
                "unix_timestamp": safe_int(row[7], 0),
                "franchise_id": safe_str(row[8]).zfill(4)[-4:],
                "team_name": safe_str(row[9]),
                "detail": detail,
            }
        )

    # Base transactions (FREE_AGENT drops, TAXI demotions/promotions)
    sql_base = """
    SELECT type, date_et, time_et, unix_timestamp, raw_json
    FROM transactions_base
    WHERE season = ?
      AND type IN ('FREE_AGENT', 'TAXI')
    """
    for row in conn.execute(sql_base, (season,)).fetchall():
        ttype = safe_str(row[0]).upper()
        raw_json_txt = safe_str(row[4])
        if not raw_json_txt:
            continue
        try:
            payload = json.loads(raw_json_txt)
        except json.JSONDecodeError:
            continue
        franchise_id = safe_str(payload.get("franchise")).zfill(4)[-4:]
        date_et = safe_str(row[1])
        time_et = safe_str(row[2])
        unix_ts = safe_int(row[3], 0)

        if ttype == "FREE_AGENT":
            _add_ids, drop_ids = parse_transaction_ids(safe_str(payload.get("transaction")))
            for pid in drop_ids:
                prow = conn.execute(
                    "SELECT position FROM players WHERE season = ? AND CAST(player_id AS TEXT) = ? LIMIT 1",
                    (season, pid),
                ).fetchone()
                if normalize_position(prow[0] if prow else "") != position.upper():
                    continue
                team_name = lookup_franchise_name(conn, season, franchise_id)
                out.setdefault(pid, []).append(
                    {
                        "event_type": "DROP",
                        "event_source": "FREE_AGENT",
                        "event_date": date_et,
                        "event_time": time_et,
                        "unix_timestamp": unix_ts,
                        "franchise_id": franchise_id,
                        "team_name": team_name,
                        "detail": "",
                    }
                )
        elif ttype == "TAXI":
            demoted_ids = parse_id_list(safe_str(payload.get("demoted")))
            promoted_ids = parse_id_list(safe_str(payload.get("promoted")))
            for pid in demoted_ids:
                prow = conn.execute(
                    "SELECT position FROM players WHERE season = ? AND CAST(player_id AS TEXT) = ? LIMIT 1",
                    (season, pid),
                ).fetchone()
                if normalize_position(prow[0] if prow else "") != position.upper():
                    continue
                team_name = lookup_franchise_name(conn, season, franchise_id)
                out.setdefault(pid, []).append(
                    {
                        "event_type": "STATUS",
                        "event_source": "TAXI_DEMOTE",
                        "event_date": date_et,
                        "event_time": time_et,
                        "unix_timestamp": unix_ts,
                        "franchise_id": franchise_id,
                        "team_name": team_name,
                        "detail": "",
                    }
                )
            for pid in promoted_ids:
                prow = conn.execute(
                    "SELECT position FROM players WHERE season = ? AND CAST(player_id AS TEXT) = ? LIMIT 1",
                    (season, pid),
                ).fetchone()
                if normalize_position(prow[0] if prow else "") != position.upper():
                    continue
                team_name = lookup_franchise_name(conn, season, franchise_id)
                out.setdefault(pid, []).append(
                    {
                        "event_type": "STATUS",
                        "event_source": "TAXI_PROMOTE",
                        "event_date": date_et,
                        "event_time": time_et,
                        "unix_timestamp": unix_ts,
                        "franchise_id": franchise_id,
                        "team_name": team_name,
                        "detail": "",
                    }
                )

    # Sort + de-dupe same season/player exact stamp/source/owner duplicates.
    for pid, events in out.items():
        events.sort(
            key=lambda x: (
                safe_int(x.get("unix_timestamp"), 0),
                safe_str(x.get("event_date")),
                safe_str(x.get("event_time")),
                safe_str(x.get("event_type")),
                safe_str(x.get("franchise_id")),
                safe_str(x.get("event_source")),
            )
        )
        deduped: List[Dict[str, Any]] = []
        last_key: Optional[Tuple[str, str, str, str, str]] = None
        for ev in events:
            k = (
                safe_str(ev.get("event_type")),
                safe_str(ev.get("event_date")),
                safe_str(ev.get("event_time")),
                safe_str(ev.get("franchise_id")),
                safe_str(ev.get("event_source")),
            )
            if k == last_key:
                continue
            deduped.append(ev)
            last_key = k
        out[pid] = deduped

    return out


def classify_change(
    prior: Optional[Dict[str, Any]],
    current: Optional[Dict[str, Any]],
    draft_pick: Optional[Dict[str, Any]],
    auction_win: Optional[Dict[str, Any]],
    last_add: Optional[Dict[str, Any]],
    last_drop: Optional[Dict[str, Any]],
) -> Tuple[str, int]:
    prior_is_contract = is_contract_status(prior.get("contract_status", "")) if prior else False
    current_is_contract = is_contract_status(current.get("contract_status", "")) if current else False
    prior_years = safe_int(prior.get("contract_year"), 0) if prior else 0
    current_years = safe_int(current.get("contract_year"), 0) if current else 0
    current_status_upper = safe_str(current.get("contract_status", "")).upper() if current else ""

    prior_rollover_expected = 1 if (prior_is_contract and prior_years > 1) else 0
    prior_expiring = 1 if (prior_is_contract and prior_years == 1) else 0
    expected_rollover_years = max(0, prior_years - 1) if prior_is_contract else 0

    went_through_waiver = 0
    if last_add:
        if last_add.get("raw_type", "").upper() == "BBID_WAIVER":
            went_through_waiver = 1
        elif last_add.get("method", "").upper() == "BBID":
            went_through_waiver = 1

    if current and "TAG" == current_status_upper:
        return "tagged", 0
    if auction_win:
        at = safe_str(auction_win.get("auction_type"))
        if at == "FreeAgent":
            return "fa_auction", 0
        if at == "TagOrExpiredRookie":
            return "expired_rookie_or_tag_auction", 0
        return "auction_other", 0
    if last_add and went_through_waiver:
        if prior_is_contract:
            return "dropped_then_waiver_readd", 0
        return "waiver_contract_add", 0
    if draft_pick and current:
        return "rookie_draft_contract", 0
    # Extension inference: current remaining years are larger than expected rollover
    # and we do not see an auction/waiver path.
    if (
        prior_is_contract
        and current_is_contract
        and current_status_upper != "TAG"
        and not auction_win
        and not went_through_waiver
        and current_years > expected_rollover_years
    ):
        return "extension_inferred", 1
    if prior_rollover_expected and current_is_contract:
        return "carryover_contract", 0
    if prior and not current:
        if last_drop:
            return "dropped_off_roster", 0
        return "missing_week1_snapshot", 0
    if current and not current_is_contract:
        return "week1_not_under_contract", 0
    return "manual_review", 0


def pick_current_transaction(
    category: str,
    prior: Optional[Dict[str, Any]],
    current: Optional[Dict[str, Any]],
    draft_pick: Optional[Dict[str, Any]],
    auction_win: Optional[Dict[str, Any]],
    last_add: Optional[Dict[str, Any]],
    last_trade: Optional[Dict[str, Any]],
) -> Tuple[str, str]:
    """
    Return a single 'current transaction' date + source label.
    Priority:
      1) Auction
      2) Waiver/add event
      3) Rookie draft
      4) Trade (when team changed)
      5) Blank for pure carryover/unknown
    """
    if auction_win:
        return safe_str(auction_win.get("date_et")), f"AUCTION:{safe_str(auction_win.get('auction_type'))}"

    if last_add and category in {"dropped_then_waiver_readd", "waiver_contract_add"}:
        source = safe_str(last_add.get("raw_type")) or safe_str(last_add.get("method")) or "ADD"
        return safe_str(last_add.get("date_et")), source

    if draft_pick and category == "rookie_draft_contract":
        return safe_str(draft_pick.get("date_et")), "ROOKIE_DRAFT"

    prior_team = safe_str(prior.get("franchise_id")) if prior else ""
    current_team = safe_str(current.get("franchise_id")) if current else ""
    if last_trade and prior_team and current_team and prior_team != current_team:
        return safe_str(last_trade.get("date_et")), "TRADE"

    return "", ""


def build_rows_for_season(
    conn: sqlite3.Connection,
    season: int,
    position: str,
) -> List[Dict[str, Any]]:
    prior_season = season - 1
    prior_week = fetch_prior_week(conn, prior_season)

    deadline_date = fetch_deadline(conn, season)
    auction_start_date = fetch_auction_start_date(conn, season)
    kickoff_date, season_end_date, week_date_map, last_regular_week = get_season_bounds(conn, season)
    kickoff_date_str = kickoff_date.isoformat() if kickoff_date else ""
    season_end_date_str = season_end_date.isoformat() if season_end_date else ""
    max_week = fetch_max_week(conn, season)
    extension_rates = fetch_extension_rate_map(conn, season)
    prior_snap = (
        fetch_snapshot(conn, prior_season, prior_week, position)
        if prior_week > 0
        else {}
    )
    current_snap = fetch_snapshot(conn, season, 1, position)
    end_snap = (
        fetch_snapshot(conn, season, last_regular_week, position)
        if last_regular_week > 0
        else {}
    )
    draft_map = fetch_draft_map(conn, season, position)
    auction_map = fetch_auction_winners(conn, season, position, deadline_date)
    adds_map, drops_map = fetch_adddrop_events(conn, season, position, deadline_date)
    adds_all_map, drops_all_map = fetch_adddrop_events(conn, season, position, "")
    trades_map = fetch_trade_events(conn, season, position, deadline_date)

    all_ids = set(prior_snap.keys()) | set(current_snap.keys()) | set(end_snap.keys())
    rows: List[Dict[str, Any]] = []

    for pid in sorted(all_ids):
        prior = prior_snap.get(pid)
        current = current_snap.get(pid)
        end_season = end_snap.get(pid)
        draft_pick = draft_map.get(pid)
        auction_win = auction_map.get(pid)
        adds = adds_map.get(pid, [])
        drops = drops_map.get(pid, [])
        adds_all = adds_all_map.get(pid, [])
        drops_all = drops_all_map.get(pid, [])
        trades = trades_map.get(pid, [])
        last_add = adds[-1] if adds else None
        last_drop = drops[-1] if drops else None
        last_add_any = adds_all[-1] if adds_all else last_add
        last_drop_any = drops_all[-1] if drops_all else last_drop
        last_trade = trades[-1] if trades else None

        category, extension_inferred = classify_change(
            prior=prior,
            current=current,
            draft_pick=draft_pick,
            auction_win=auction_win,
            last_add=last_add,
            last_drop=last_drop,
        )

        prior_is_contract = is_contract_status(prior.get("contract_status", "")) if prior else False
        current_is_contract = is_contract_status(current.get("contract_status", "")) if current else False
        prior_years = safe_int(prior.get("contract_year"), 0) if prior else 0
        prior_rollover_expected = 1 if (prior_is_contract and prior_years > 1) else 0
        prior_expiring = 1 if (prior_is_contract and prior_years == 1) else 0

        base = current if current else prior
        if not base:
            continue

        prior_earned = (
            calc_earned_to_date(
                safe_int(prior.get("contract_length"), 0),
                safe_int(prior.get("contract_year"), 0),
                safe_int(prior.get("aav"), 0),
                safe_str(prior.get("year_values_json")),
            )
            if prior
            else 0
        )
        current_earned = (
            calc_earned_to_date(
                safe_int(current.get("contract_length"), 0),
                safe_int(current.get("contract_year"), 0),
                safe_int(current.get("aav"), 0),
                safe_str(current.get("year_values_json")),
            )
            if current
            else 0
        )

        source_detail_parts = [category]
        if extension_inferred:
            source_detail_parts.append("expiring prior-year contract but still under contract without auction/waiver")
        if last_add:
            source_detail_parts.append(
                f"last_add={last_add.get('date_et','')} {last_add.get('raw_type') or last_add.get('method')}"
            )
        if last_drop:
            source_detail_parts.append(
                f"last_drop={last_drop.get('date_et','')} {last_drop.get('raw_type') or last_drop.get('method')}"
            )
        source_detail = " | ".join([p for p in source_detail_parts if p])
        current_txn_date, current_txn_source = pick_current_transaction(
            category=category,
            prior=prior,
            current=current,
            draft_pick=draft_pick,
            auction_win=auction_win,
            last_add=last_add,
            last_trade=last_trade,
        )
        # Contract roll-forward baseline: if no concrete transaction date is found,
        # anchor to Mar 1 of the season for consistent ordering/review.
        if not current_txn_date and category in {"carryover_contract", "extension_inferred"}:
            current_txn_date = f"{season}-03-01"
            if not current_txn_source:
                current_txn_source = "ROLLOVER_BASELINE"

        inferred_extension_term = 0
        inferred_extension_rate = 0
        inferred_contract_info = ""
        inferred_year_values: Dict[int, int] = {}
        inferred_tcv = 0

        if current:
            curr_salary = safe_int(current.get("salary"), 0)
            curr_years = safe_int(current.get("contract_year"), 0)
            curr_cl = max(
                safe_int(current.get("contract_length"), 0),
                curr_years,
                1,
            )
            curr_year_values = parse_year_values_json(safe_str(current.get("year_values_json")))
            curr_aav = safe_int(current.get("aav"), curr_salary)
            curr_tcv = safe_int(current.get("tcv"), 0)

            if category == "extension_inferred" and prior and current:
                expected_rollover_years = max(0, prior_years - 1) if prior_is_contract else 0
                inferred_extension_term = max(0, curr_years - expected_rollover_years)
                inferred_extension_rate = get_extension_rate(
                    extension_rates,
                    safe_str(current.get("position")),
                    inferred_extension_term,
                )
                # Extension model:
                #   Y1 = current salary
                #   Y2..Yn = current salary + extension_rate
                ext_cl = max(curr_years, 1)
                ext_y1 = curr_salary
                ext_y_other = curr_salary + max(0, inferred_extension_rate)
                ext_year_values: Dict[int, int] = {1: ext_y1}
                for yidx in range(2, ext_cl + 1):
                    ext_year_values[yidx] = ext_y_other
                ext_tcv = sum(ext_year_values.values())
                inferred_year_values = ext_year_values
                inferred_tcv = ext_tcv
                if ext_cl > 1:
                    aav_label = f"{format_k(ext_y1)}/{format_k(ext_y_other)}"
                else:
                    aav_label = format_k(ext_y1)
                inferred_contract_info = build_contract_info_string(
                    contract_length=ext_cl,
                    tcv=ext_tcv,
                    aav_label=aav_label,
                    year_values=ext_year_values,
                    suffix="Inferred Extension",
                )
            else:
                if not curr_year_values and curr_salary > 0:
                    curr_year_values = {1: curr_salary}
                    for yidx in range(2, curr_cl + 1):
                        curr_year_values[yidx] = curr_aav if curr_aav > 0 else curr_salary
                if curr_tcv <= 0:
                    if curr_year_values:
                        curr_tcv = sum(curr_year_values.values())
                    elif curr_salary > 0:
                        curr_tcv = curr_salary * curr_cl
                inferred_year_values = curr_year_values
                inferred_tcv = curr_tcv
                if curr_cl > 1 and curr_year_values.get(1) and curr_year_values.get(2):
                    if curr_year_values[1] != curr_year_values[2]:
                        aav_label = f"{format_k(curr_year_values[1])}/{format_k(curr_year_values[2])}"
                    else:
                        aav_label = format_k(curr_aav if curr_aav > 0 else curr_salary)
                else:
                    aav_label = format_k(curr_aav if curr_aav > 0 else curr_salary)
                inferred_contract_info = build_contract_info_string(
                    contract_length=curr_cl,
                    tcv=curr_tcv,
                    aav_label=aav_label,
                    year_values=curr_year_values,
                )

        # --- Drop / taxi / guarantee logic ---
        drop_in_season_flag = 0
        drop_on_taxi_flag = 0
        taxi_eligible_drop_flag = 0
        taxi_eligible_reason = ""
        tag_cut_pre_auction_flag = 0
        waiver_pickup_flag = 0
        waiver_guarantee_pct = 0.0
        waiver_guarantee_amount = 0
        drop_earned_amount = 0
        drop_guarantee_amount = 0

        drop_date_obj = parse_iso_date(last_drop.get("date_et") if last_drop else "")
        if drop_date_obj and kickoff_date and season_end_date:
            if kickoff_date <= drop_date_obj <= season_end_date:
                drop_in_season_flag = 1
        elif drop_date_obj and kickoff_date:
            if drop_date_obj >= kickoff_date:
                drop_in_season_flag = 1

        drop_week_guess = 0
        if drop_date_obj:
            drop_week_guess = estimate_week_from_schedule(drop_date_obj, week_date_map)
            if drop_week_guess <= 0 and kickoff_date:
                drop_week_guess = estimate_week_from_date(drop_date_obj, kickoff_date, max_week)

        if drop_week_guess > 0 and last_drop:
            row = conn.execute(
                """
                SELECT status
                FROM rosters_weekly
                WHERE season = ?
                  AND week = ?
                  AND player_id = ?
                  AND franchise_id = ?
                LIMIT 1
                """,
                (
                    season,
                    drop_week_guess,
                    safe_str(current.get("player_id") if current else pid),
                    safe_str(last_drop.get("franchise_id")),
                ),
            ).fetchone()
            if row and safe_str(row[0]).upper() == "TAXI_SQUAD":
                drop_on_taxi_flag = 1

        if last_add:
            if safe_str(last_add.get("raw_type")).upper() == "BBID_WAIVER":
                waiver_pickup_flag = 1
            elif safe_str(last_add.get("method")).upper() == "BBID":
                waiver_pickup_flag = 1

        # Taxi eligible drops (rookies round 2+ cut before contract deadline)
        if drop_date_obj and deadline_date:
            deadline_obj = parse_iso_date(deadline_date)
            if deadline_obj and drop_date_obj <= deadline_obj:
                if draft_pick and safe_int(draft_pick.get("draftpick_round"), 0) >= 2:
                    taxi_eligible_drop_flag = 1
                    taxi_eligible_reason = "rookie_round_2_plus_pre_deadline"

        if drop_on_taxi_flag:
            taxi_eligible_drop_flag = 1
            if taxi_eligible_reason:
                taxi_eligible_reason = f"{taxi_eligible_reason}|on_taxi"
            else:
                taxi_eligible_reason = "on_taxi"

        # Tag cut before auction start => no penalty
        if (
            prior
            and safe_str(prior.get("contract_status")).upper() == "TAG"
            and last_drop
            and auction_start_date
        ):
            auction_start_obj = parse_iso_date(auction_start_date)
            if auction_start_obj and drop_date_obj and drop_date_obj < auction_start_obj:
                tag_cut_pre_auction_flag = 1

        salary_basis = safe_int(last_add.get("salary"), 0) if last_add else 0
        if salary_basis <= 0:
            salary_basis = safe_int(current.get("salary"), 0) if current else 0

        # Guarantee / earned rules
        if taxi_eligible_drop_flag or tag_cut_pre_auction_flag:
            drop_guarantee_amount = 0
            drop_earned_amount = 0
        elif waiver_pickup_flag and salary_basis > 4000:
            waiver_guarantee_pct = 0.35
            waiver_guarantee_amount = int(round(salary_basis * waiver_guarantee_pct))
            drop_guarantee_amount = waiver_guarantee_amount
            # no earnings until season end
            if drop_date_obj and season_end_date and drop_date_obj >= season_end_date:
                drop_earned_amount = salary_basis
            else:
                drop_earned_amount = 0
        else:
            # Monthly accrual (Sep 30, Oct 31, Nov 30, season complete)
            if drop_date_obj and salary_basis > 0:
                drop_earned_amount = prorate_earned_for_drop(
                    season=season,
                    amount=salary_basis,
                    drop_date_obj=drop_date_obj,
                    season_end_date=season_end_date,
                )
            drop_guarantee_amount = drop_earned_amount

        # --- Season earned / total earned ---
        current_ctx = current or {}
        current_salary = safe_int(current_ctx.get("salary"), 0)
        current_years_remaining = safe_int(current_ctx.get("contract_year"), 0)
        current_contract_length = safe_int(current_ctx.get("contract_length"), 0)
        contract_year_index = 0
        contract_year_value = 0
        earned_season_full = 0
        earned_season_prorated = 0
        total_contract_value = inferred_tcv if inferred_tcv > 0 else safe_int(current_ctx.get("tcv"), 0)
        if current:
            if current_contract_length <= 0:
                current_contract_length = max(current_years_remaining, 1)
            contract_year_index = max(1, current_contract_length - max(current_years_remaining, 1) + 1)
            contract_year_value = pick_year_value(
                year_values=inferred_year_values,
                year_index=contract_year_index,
                fallback_aav=safe_int(current_ctx.get("aav"), 0),
                fallback_salary=current_salary,
            )
            earned_season_full = contract_year_value if contract_year_value > 0 else current_salary
            earned_season_prorated = earned_season_full
            if drop_in_season_flag:
                # Use drop-earned calculation (handles waiver guarantees and taxi rules).
                earned_season_prorated = drop_earned_amount
        if total_contract_value <= 0 and current_salary > 0 and current_contract_length > 0:
            total_contract_value = current_salary * current_contract_length
        earned_total_through_season = safe_int(prior_earned, 0) + safe_int(earned_season_prorated, 0)
        earned_remaining_after_season = max(0, total_contract_value - earned_total_through_season)

        # --- Mid-year multi-year flag (post-drop pickups should reset to 1-year) ---
        mid_year_multi_flag = 0
        mid_year_multi_reason = ""
        end_contract_year = safe_int(end_season.get("contract_year"), 0) if end_season else 0
        if end_contract_year <= 0 and current:
            end_contract_year = current_contract_length
        if end_contract_year > 1 and not draft_pick:
            last_drop_date = safe_str(last_drop_any.get("date_et") if last_drop_any else "")
            last_add_date = safe_str(last_add_any.get("date_et") if last_add_any else "")
            add_in_season = False
            if last_add_date and kickoff_date_str:
                add_in_season = last_add_date >= kickoff_date_str
            if last_add_any and add_in_season and (category in {"waiver_contract_add", "dropped_then_waiver_readd"}):
                mid_year_multi_flag = 1
                mid_year_multi_reason = "multi_year_after_waiver"
            elif last_add_any and last_drop_any and add_in_season and last_drop_date and last_add_date and last_drop_date <= last_add_date:
                mid_year_multi_flag = 1
                mid_year_multi_reason = "multi_year_after_drop"
            if mid_year_multi_flag and last_add_date:
                mid_year_multi_reason = f"{mid_year_multi_reason}|add={last_add_date}"
            if mid_year_multi_flag and last_drop_date:
                mid_year_multi_reason = f"{mid_year_multi_reason}|drop={last_drop_date}"

        # --- Legacy vs current cap penalties ---
        status_for_penalty = safe_str(current_ctx.get("contract_status")) or safe_str(prior.get("contract_status") if prior else "")
        info_for_penalty = safe_str(current_ctx.get("contract_info")) or safe_str(prior.get("contract_info") if prior else "")
        gf_in_status = 1 if "GF" in status_for_penalty.upper() else 0
        gf_in_info = 1 if "GF" in info_for_penalty.upper() else 0
        legacy_gf_flag = 1 if (gf_in_status or gf_in_info) else 0
        legacy_rule_flag = 1 if (season < 2019 or legacy_gf_flag == 1) else 0
        remaining_tcv_at_drop = max(0, total_contract_value - safe_int(prior_earned, 0))

        legacy_cap_penalty_amount = 0
        if drop_in_season_flag and legacy_rule_flag:
            legacy_cap_penalty_amount = int(round(remaining_tcv_at_drop * 0.20))

        current_cap_penalty_amount = 0
        if drop_in_season_flag:
            current_cap_penalty_amount = safe_int(drop_guarantee_amount, 0)

        at_time_cap_penalty_amount = legacy_cap_penalty_amount if legacy_rule_flag else current_cap_penalty_amount

        # --- Manual review flags ---
        manual_review_reasons: List[str] = []
        if category == "manual_review":
            manual_review_reasons.append("change_category_manual_review")
        if safe_int(current_ctx.get("multi_aav_flag"), 0) == 1:
            manual_review_reasons.append("multiple_aav_tokens")
        if extension_inferred and "EXT:" in safe_str(current_ctx.get("contract_info")).upper():
            manual_review_reasons.append("extension_inferred_but_contract_info_has_ext")
        if gf_in_info == 1 and gf_in_status == 0:
            manual_review_reasons.append("gf_in_contract_info")
        if mid_year_multi_flag == 1:
            manual_review_reasons.append("mid_year_multi")

        # Contract info mismatch (prefer inferred values for consistency)
        if current and safe_str(current_ctx.get("contract_info")):
            parsed_parts = parse_contract_parts(
                safe_str(current_ctx.get("contract_info")),
                current_salary,
                current_years_remaining,
            )
            parsed_sig = contract_signature(parsed_parts)
            inferred_sig = (
                safe_int(current_contract_length, 0),
                safe_int(inferred_tcv, 0),
                safe_int(safe_int(current_ctx.get("aav"), 0), 0),
            )
            # Flag if TCV or CL differ materially from inferred values.
            if parsed_sig[0] != inferred_sig[0] or (parsed_sig[1] and inferred_sig[1] and abs(parsed_sig[1] - inferred_sig[1]) >= 1000):
                manual_review_reasons.append("contract_info_inconsistent")
        manual_review_flag = 1 if manual_review_reasons else 0
        manual_review_reason = "|".join(manual_review_reasons)

        mym_flag = detect_mym_flag(
            safe_str(current.get("contract_status") if current else ""),
            safe_str(current.get("contract_info") if current else ""),
        )
        restructure_flag = detect_restructure_flag(
            safe_str(current.get("contract_status") if current else ""),
            safe_str(current.get("contract_info") if current else ""),
        )
        cap_penalty_flag = 1 if (drop_in_season_flag and at_time_cap_penalty_amount > 0) else 0

        row = {
            "season": season,
            "position_filter": position.upper(),
            "player_id": pid,
            "player_name": safe_str(base.get("player_name")),
            "position": safe_str(base.get("position")).upper(),
            "nfl_team": safe_str(base.get("nfl_team")).upper(),
            "snapshot_week": 1,
            "cutoff_contract_deadline_date": deadline_date,
            "season_kickoff_date": kickoff_date_str,
            "season_end_date": season_end_date_str,
            "season_end_week": safe_int(last_regular_week, 0),
            "franchise_id": safe_str(current.get("franchise_id") if current else ""),
            "team_name": safe_str(current.get("team_name") if current else ""),
            "status": safe_str(current.get("status") if current else ""),
            "salary": safe_int(current.get("salary"), 0) if current else 0,
            "contract_year": safe_int(current.get("contract_year"), 0) if current else 0,
            "contract_status": safe_str(current.get("contract_status") if current else ""),
            "contract_info": safe_str(current.get("contract_info") if current else ""),
            "inferred_contract_info": inferred_contract_info,
            "extension_flag": 1 if extension_inferred else 0,
            "restructure_flag": restructure_flag,
            "mym_flag": mym_flag,
            "cap_penalty_flag": cap_penalty_flag,
            "mid_year_multi_flag": mid_year_multi_flag,
            "mid_year_multi_reason": mid_year_multi_reason,
            "end_season_contract_year": end_contract_year,
            "legacy_gf_flag": legacy_gf_flag,
            "legacy_rule_flag": legacy_rule_flag,
            "remaining_tcv_at_drop": remaining_tcv_at_drop,
            "legacy_cap_penalty_amount": legacy_cap_penalty_amount,
            "current_cap_penalty_amount": current_cap_penalty_amount,
            "at_time_cap_penalty_amount": at_time_cap_penalty_amount,
            "contract_length": safe_int(current.get("contract_length"), 0) if current else 0,
            "tcv": safe_int(current.get("tcv"), 0) if current else 0,
            "aav": safe_int(current.get("aav"), 0) if current else 0,
            "year_values_json": safe_str(current.get("year_values_json") if current else "{}"),
            "inferred_extension_term": inferred_extension_term,
            "inferred_extension_rate": inferred_extension_rate,
            "contract_year_index": contract_year_index,
            "contract_year_value": contract_year_value,
            "earned_to_date": current_earned,
            "earned_season_full": earned_season_full,
            "earned_season_prorated": earned_season_prorated,
            "earned_total_through_season": earned_total_through_season,
            "earned_remaining_after_season": earned_remaining_after_season,
            "earned_as_of_date": season_end_date_str,
            "multi_aav_flag": safe_int(current.get("multi_aav_flag"), 0) if current else 0,
            "parsed_aav_source": safe_str(current.get("parsed_aav_source") if current else ""),
            "manual_review_flag": manual_review_flag,
            "manual_review_reason": manual_review_reason,
            "prior_season": prior_season,
            "prior_season_last_week": prior_week,
            "prior_franchise_id": safe_str(prior.get("franchise_id") if prior else ""),
            "prior_team_name": safe_str(prior.get("team_name") if prior else ""),
            "prior_status": safe_str(prior.get("status") if prior else ""),
            "prior_salary": safe_int(prior.get("salary"), 0) if prior else 0,
            "prior_contract_year": safe_int(prior.get("contract_year"), 0) if prior else 0,
            "prior_contract_status": safe_str(prior.get("contract_status") if prior else ""),
            "prior_contract_info": safe_str(prior.get("contract_info") if prior else ""),
            "prior_contract_length": safe_int(prior.get("contract_length"), 0) if prior else 0,
            "prior_tcv": safe_int(prior.get("tcv"), 0) if prior else 0,
            "prior_aav": safe_int(prior.get("aav"), 0) if prior else 0,
            "prior_year_values_json": safe_str(prior.get("year_values_json") if prior else "{}"),
            "prior_extension_flag": safe_int(prior.get("extension_flag"), 0) if prior else 0,
            "prior_multi_aav_flag": safe_int(prior.get("multi_aav_flag"), 0) if prior else 0,
            "prior_parsed_aav_source": safe_str(prior.get("parsed_aav_source") if prior else ""),
            "prior_earned_to_date": prior_earned,
            "prior_was_contract_status": 1 if prior_is_contract else 0,
            "prior_rollover_expected_under_contract": prior_rollover_expected,
            "prior_expiring_contract": prior_expiring,
            "week1_is_contract_status": 1 if current_is_contract else 0,
            "change_category": category,
            "current_transaction_date": current_txn_date,
            "current_transaction_source": current_txn_source,
            "source_detail": source_detail,
            "drop_in_season_flag": drop_in_season_flag,
            "drop_week_guess": drop_week_guess,
            "drop_on_taxi_flag": drop_on_taxi_flag,
            "taxi_eligible_drop_flag": taxi_eligible_drop_flag,
            "taxi_eligible_reason": taxi_eligible_reason,
            "tag_cut_pre_auction_flag": tag_cut_pre_auction_flag,
            "waiver_pickup_flag": waiver_pickup_flag,
            "waiver_guarantee_pct": waiver_guarantee_pct,
            "waiver_guarantee_amount": waiver_guarantee_amount,
            "drop_earned_amount": drop_earned_amount,
            "drop_guarantee_amount": drop_guarantee_amount,
            "draftpick_round": safe_int(draft_pick.get("draftpick_round"), 0) if draft_pick else 0,
            "draftpick_roundorder": safe_int(draft_pick.get("draftpick_roundorder"), 0) if draft_pick else 0,
            "draftpick_overall": safe_int(draft_pick.get("draftpick_overall"), 0) if draft_pick else 0,
            "auction_type": safe_str(auction_win.get("auction_type") if auction_win else ""),
            "auction_bid_amount": safe_int(auction_win.get("bid_amount"), 0) if auction_win else 0,
            "auction_date": safe_str(auction_win.get("date_et") if auction_win else ""),
            "drop_count_pre_deadline": len(drops),
            "last_drop_date": safe_str(last_drop.get("date_et") if last_drop else ""),
            "last_drop_team": safe_str(last_drop.get("franchise_name") if last_drop else ""),
            "last_drop_method": safe_str(last_drop.get("method") if last_drop else ""),
            "last_drop_raw_type": safe_str(last_drop.get("raw_type") if last_drop else ""),
            "add_count_pre_deadline": len(adds),
            "last_add_date": safe_str(last_add.get("date_et") if last_add else ""),
            "last_add_team": safe_str(last_add.get("franchise_name") if last_add else ""),
            "last_add_method": safe_str(last_add.get("method") if last_add else ""),
            "last_add_raw_type": safe_str(last_add.get("raw_type") if last_add else ""),
            "last_add_salary": safe_int(last_add.get("salary"), 0) if last_add else 0,
            "trade_count_pre_deadline": len(trades),
            "last_trade_date": safe_str(last_trade.get("date_et") if last_trade else ""),
            "last_trade_group_id": safe_str(last_trade.get("trade_group_id") if last_trade else ""),
            "cap_penalty": at_time_cap_penalty_amount if drop_in_season_flag else 0,
            "cap_penalty_note": "legacy" if legacy_rule_flag else "current",
            "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        }
        rows.append(row)
    return rows


def build_owner_lineage_rows_for_season(
    conn: sqlite3.Connection,
    season: int,
    position: str,
) -> List[Dict[str, Any]]:
    """
    Build one row per owner stint (within season) for each player.
    This preserves intra-season ownership lineage (e.g. trade chain).
    """
    prior_season = season - 1
    prior_week = fetch_prior_week(conn, prior_season)
    prior_snap = (
        fetch_snapshot(conn, prior_season, prior_week, position)
        if prior_week > 0
        else {}
    )
    week1_snap = fetch_snapshot(conn, season, 1, position)
    owner_events = fetch_owner_change_events(conn, season, position)
    _kickoff, season_end_date, _week_dates, _last_week = get_season_bounds(conn, season)
    season_end = season_end_date.isoformat() if season_end_date else f"{season}-12-31"
    season_start = f"{season}-03-01"

    all_ids = set(prior_snap.keys()) | set(week1_snap.keys()) | set(owner_events.keys())
    rows: List[Dict[str, Any]] = []

    for pid in sorted(all_ids):
        prior = prior_snap.get(pid)
        week1 = week1_snap.get(pid)
        events = owner_events.get(pid, [])

        player_name = safe_str((week1 or prior or {}).get("player_name"))
        nfl_team = safe_str((week1 or prior or {}).get("nfl_team"))

        current_owner_id = ""
        current_owner_team = ""
        current_start = season_start
        current_acquire_source = ""

        if prior:
            current_owner_id = safe_str(prior.get("franchise_id"))
            current_owner_team = safe_str(prior.get("team_name"))
            current_acquire_source = "ROLLOVER_BASELINE"
        elif week1:
            current_owner_id = safe_str(week1.get("franchise_id"))
            current_owner_team = safe_str(week1.get("team_name"))
            current_acquire_source = "WEEK1_SNAPSHOT"
        elif events:
            first_acq = next((e for e in events if safe_str(e.get("event_type")) == "ACQUIRE"), None)
            if first_acq:
                current_owner_id = safe_str(first_acq.get("franchise_id"))
                current_owner_team = safe_str(first_acq.get("team_name"))
                current_start = safe_str(first_acq.get("event_date")) or season_start
                current_acquire_source = safe_str(first_acq.get("event_source"))

        lineage_seq = 0
        for ev in events:
            ev_type = safe_str(ev.get("event_type"))
            ev_date = safe_str(ev.get("event_date"))
            ev_owner_id = safe_str(ev.get("franchise_id"))
            ev_owner_team = safe_str(ev.get("team_name"))
            ev_source = safe_str(ev.get("event_source"))

            if ev_type == "DROP":
                if current_owner_id and ev_owner_id == current_owner_id:
                    lineage_seq += 1
                    rows.append(
                        {
                            "season": season,
                            "position_filter": position.upper(),
                            "player_id": pid,
                            "player_name": player_name,
                            "nfl_team": nfl_team,
                            "lineage_seq": lineage_seq,
                            "owner_franchise_id": current_owner_id,
                            "owner_team_name": current_owner_team,
                            "stint_start_date": current_start,
                            "stint_end_date": ev_date,
                            "acquire_source": current_acquire_source,
                            "close_source": ev_source,
                            "week1_owner_franchise_id": safe_str(week1.get("franchise_id") if week1 else ""),
                            "week1_owner_team_name": safe_str(week1.get("team_name") if week1 else ""),
                            "prior_owner_franchise_id": safe_str(prior.get("franchise_id") if prior else ""),
                            "prior_owner_team_name": safe_str(prior.get("team_name") if prior else ""),
                            "week1_contract_info": safe_str(week1.get("contract_info") if week1 else ""),
                            "prior_contract_info": safe_str(prior.get("contract_info") if prior else ""),
                            "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                        }
                    )
                    current_owner_id = ""
                    current_owner_team = ""
                    current_start = ""
                    current_acquire_source = ""
                continue

            if ev_type != "ACQUIRE":
                continue

            if not current_owner_id:
                current_owner_id = ev_owner_id
                current_owner_team = ev_owner_team
                current_start = ev_date or season_start
                current_acquire_source = ev_source
                continue

            if ev_owner_id == current_owner_id:
                # same owner action; keep the existing stint
                continue

            lineage_seq += 1
            rows.append(
                {
                    "season": season,
                    "position_filter": position.upper(),
                    "player_id": pid,
                    "player_name": player_name,
                    "nfl_team": nfl_team,
                    "lineage_seq": lineage_seq,
                    "owner_franchise_id": current_owner_id,
                    "owner_team_name": current_owner_team,
                    "stint_start_date": current_start,
                    "stint_end_date": ev_date,
                    "acquire_source": current_acquire_source,
                    "close_source": ev_source,
                    "week1_owner_franchise_id": safe_str(week1.get("franchise_id") if week1 else ""),
                    "week1_owner_team_name": safe_str(week1.get("team_name") if week1 else ""),
                    "prior_owner_franchise_id": safe_str(prior.get("franchise_id") if prior else ""),
                    "prior_owner_team_name": safe_str(prior.get("team_name") if prior else ""),
                    "week1_contract_info": safe_str(week1.get("contract_info") if week1 else ""),
                    "prior_contract_info": safe_str(prior.get("contract_info") if prior else ""),
                    "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                }
            )
            current_owner_id = ev_owner_id
            current_owner_team = ev_owner_team
            current_start = ev_date or season_start
            current_acquire_source = ev_source

        if current_owner_id:
            lineage_seq += 1
            rows.append(
                {
                    "season": season,
                    "position_filter": position.upper(),
                    "player_id": pid,
                    "player_name": player_name,
                    "nfl_team": nfl_team,
                    "lineage_seq": lineage_seq,
                    "owner_franchise_id": current_owner_id,
                    "owner_team_name": current_owner_team,
                    "stint_start_date": current_start if current_start else season_start,
                    "stint_end_date": season_end,
                    "acquire_source": current_acquire_source if current_acquire_source else "UNKNOWN_START",
                    "close_source": "SEASON_END",
                    "week1_owner_franchise_id": safe_str(week1.get("franchise_id") if week1 else ""),
                    "week1_owner_team_name": safe_str(week1.get("team_name") if week1 else ""),
                    "prior_owner_franchise_id": safe_str(prior.get("franchise_id") if prior else ""),
                    "prior_owner_team_name": safe_str(prior.get("team_name") if prior else ""),
                    "week1_contract_info": safe_str(week1.get("contract_info") if week1 else ""),
                    "prior_contract_info": safe_str(prior.get("contract_info") if prior else ""),
                    "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                }
            )

    return rows


def build_timeline_rows_for_season(
    conn: sqlite3.Connection,
    season: int,
    position: str,
) -> List[Dict[str, Any]]:
    prior_season = season - 1
    prior_week = fetch_prior_week(conn, prior_season)
    prior_snap = (
        fetch_snapshot(conn, prior_season, prior_week, position)
        if prior_week > 0
        else {}
    )
    week1_snap = fetch_snapshot(conn, season, 1, position)
    owner_events = fetch_owner_change_events(conn, season, position)

    rows: List[Dict[str, Any]] = []
    for pid, events in owner_events.items():
        player_name = safe_str((week1_snap.get(pid) or prior_snap.get(pid) or {}).get("player_name"))
        nfl_team = safe_str((week1_snap.get(pid) or prior_snap.get(pid) or {}).get("nfl_team"))
        seq = 0
        for ev in events:
            seq += 1
            rows.append(
                {
                    "season": season,
                    "position_filter": position.upper(),
                    "player_id": pid,
                    "player_name": player_name,
                    "nfl_team": nfl_team,
                    "event_seq": seq,
                    "event_type": safe_str(ev.get("event_type")),
                    "event_source": safe_str(ev.get("event_source")),
                    "event_date": safe_str(ev.get("event_date")),
                    "event_time": safe_str(ev.get("event_time")),
                    "franchise_id": safe_str(ev.get("franchise_id")),
                    "team_name": safe_str(ev.get("team_name")),
                    "detail": safe_str(ev.get("detail")),
                    "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                }
            )
    return rows


def build_transaction_snapshot_rows_for_season(
    conn: sqlite3.Connection,
    season: int,
    position: str,
) -> List[Dict[str, Any]]:
    timeline_rows = build_timeline_rows_for_season(conn, season, position)
    contract_submission_events = fetch_contract_submission_events(conn, season, position)
    if contract_submission_events:
        timeline_rows.extend(contract_submission_events)
    kickoff_date, season_end_date, week_dates, last_week = get_season_bounds(conn, season)
    snapshot_cache: Dict[int, Dict[str, Dict[str, Any]]] = {}
    week1_snap = fetch_snapshot(conn, season, 1, position)

    def get_week_snapshot(week: int) -> Dict[str, Dict[str, Any]]:
        if week <= 0:
            return {}
        if week not in snapshot_cache:
            snapshot_cache[week] = fetch_snapshot(conn, season, week, position)
        return snapshot_cache[week]

    rows: List[Dict[str, Any]] = []

    # Add rollover rows when a player has no transactions in-season.
    timeline_players = {safe_str(r.get("player_id")) for r in timeline_rows}
    for pid, snap in week1_snap.items():
        if pid in timeline_players:
            continue
        rows.append(
            {
                "season": season,
                "position_filter": position.upper(),
                "player_id": pid,
                "player_name": safe_str(snap.get("player_name")),
                "nfl_team": safe_str(snap.get("nfl_team")),
                "event_seq": 1,
                "event_type": "ROLLOVER",
                "event_source": "TRANSACTION_CONTRACT_ROLLOVER",
                "event_date": f"{season}-03-01",
                "event_time": "",
                "franchise_id": safe_str(snap.get("franchise_id")),
                "team_name": safe_str(snap.get("team_name")),
                "event_detail": "no_transactions",
                "snapshot_week": 1,
                "snapshot_source": "rollover",
                "salary": safe_int(snap.get("salary"), 0),
                "contract_year": safe_int(snap.get("contract_year"), 0),
                "contract_status": safe_str(snap.get("contract_status")),
                "contract_info": safe_str(snap.get("contract_info")),
                "inferred_contract_info": "",
                "contract_length": safe_int(snap.get("contract_length"), 0),
                "tcv": safe_int(snap.get("tcv"), 0),
                "aav": safe_int(snap.get("aav"), 0),
                "year_values_json": safe_str(snap.get("year_values_json") if snap else "{}"),
                "extension_flag": 1 if "EXT:" in safe_str(snap.get("contract_info")).upper() else 0,
                "restructure_flag": detect_restructure_flag(safe_str(snap.get("contract_status")), safe_str(snap.get("contract_info"))),
                "mym_flag": detect_mym_flag(safe_str(snap.get("contract_status")), safe_str(snap.get("contract_info"))),
                "post_add_multi_year_flag": 0,
                "post_add_multi_year_reason": "",
                "prior_snapshot_week": 0,
                "prior_snapshot_source": "",
                "prior_salary": 0,
                "prior_contract_year": 0,
                "prior_contract_status": "",
                "prior_contract_info": "",
                "prior_inferred_contract_info": "",
                "prior_contract_length": 0,
                "prior_tcv": 0,
                "prior_aav": 0,
                "prior_year_values_json": "{}",
                "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            }
        )

    for row in timeline_rows:
        pid = safe_str(row.get("player_id"))
        event_date = parse_iso_date(safe_str(row.get("event_date")))
        snapshot_week = estimate_week_from_schedule(event_date, week_dates)
        snapshot_source = "schedule"
        if snapshot_week <= 0:
            if event_date and kickoff_date and event_date < kickoff_date:
                snapshot_week = 1
                snapshot_source = "preseason"
            elif event_date and season_end_date and last_week > 0 and event_date > season_end_date:
                snapshot_week = last_week
                snapshot_source = "postseason"
            else:
                snapshot_week = 1
                snapshot_source = "fallback"

        snap = get_week_snapshot(snapshot_week).get(pid)
        if not snap and snapshot_week != 1:
            snap = get_week_snapshot(1).get(pid)
            if snap:
                snapshot_source = "fallback_week1"

        prior_snapshot_week = max(1, snapshot_week - 1) if snapshot_week > 1 else 1
        prior_snapshot_source = "week-1" if snapshot_week > 1 else "week1"
        prior_snap = get_week_snapshot(prior_snapshot_week).get(pid)
        if not prior_snap and prior_snapshot_week != 1:
            prior_snap = get_week_snapshot(1).get(pid)
            if prior_snap:
                prior_snapshot_source = "fallback_week1"

        event_type = safe_str(row.get("event_type")).upper()
        if not snap and prior_snap and event_type in {"DROP", "CONTRACT_SUBMISSION"}:
            snap = prior_snap
            snapshot_source = f"{snapshot_source}|prior_for_{event_type.lower()}"

        salary = safe_int(snap.get("salary"), 0) if snap else 0
        contract_year = safe_int(snap.get("contract_year"), 0) if snap else 0
        contract_status = safe_str(snap.get("contract_status") if snap else "")
        contract_info = safe_str(snap.get("contract_info") if snap else "")
        parts = parse_contract_parts(contract_info, salary, contract_year) if snap else None
        inferred_contract_info = ""
        if parts:
            year_values = parse_year_values_json(parts.year_values_json)
            inferred_contract_info = build_contract_info_string(
                contract_length=parts.contract_length,
                tcv=parts.tcv,
                aav_label=format_k(parts.aav),
                year_values=year_values,
            )

        contract_length_val = safe_int(parts.contract_length, 0) if parts else 0
        tcv_val = safe_int(parts.tcv, 0) if parts else 0
        aav_val = safe_int(parts.aav, 0) if parts else 0
        year_values_json_val = safe_str(parts.year_values_json) if parts else "{}"

        override_years = safe_int(row.get("contract_length_override"), 0)
        override_raw = safe_str(row.get("contract_raw_text"))
        if override_years > 0 and safe_str(row.get("event_type")).upper() == "CONTRACT_SUBMISSION":
            contract_year = override_years
            contract_length_val = override_years
            year_values = {}
            if salary > 0:
                tcv_val = salary * override_years
                aav_val = salary
                year_values = {i: salary for i in range(1, override_years + 1)}
                year_values_json_val = json.dumps({f"Y{i}": salary for i in range(1, override_years + 1)}, separators=(",", ":"))
            inferred_contract_info = build_contract_info_string(
                contract_length=contract_length_val,
                tcv=tcv_val,
                aav_label=format_k(aav_val),
                year_values=year_values,
                suffix="",
            )
            if override_raw:
                contract_info = override_raw

        extension_flag = 1 if "EXT:" in contract_info.upper() else 0
        mym_flag = detect_mym_flag(contract_status, contract_info)
        restructure_flag = detect_restructure_flag(contract_status, contract_info)
        post_add_multi_year_flag = 0
        post_add_multi_year_reason = ""
        if safe_int(contract_year, 0) > 1 and safe_str(row.get("event_type")).upper() == "ACQUIRE":
            src = safe_str(row.get("event_source")).upper()
            if src.startswith("ADDDROP") or src == "FREE_AGENT":
                post_add_multi_year_flag = 1
                post_add_multi_year_reason = src

        prior_salary = safe_int(prior_snap.get("salary"), 0) if prior_snap else 0
        prior_contract_year = safe_int(prior_snap.get("contract_year"), 0) if prior_snap else 0
        prior_contract_status = safe_str(prior_snap.get("contract_status") if prior_snap else "")
        prior_contract_info = safe_str(prior_snap.get("contract_info") if prior_snap else "")
        prior_parts = parse_contract_parts(prior_contract_info, prior_salary, prior_contract_year) if prior_snap else None
        prior_inferred_contract_info = ""
        if prior_parts:
            prior_year_values = parse_year_values_json(prior_parts.year_values_json)
            prior_inferred_contract_info = build_contract_info_string(
                contract_length=prior_parts.contract_length,
                tcv=prior_parts.tcv,
                aav_label=format_k(prior_parts.aav),
                year_values=prior_year_values,
            )

        base_row = {
            "season": season,
            "position_filter": position.upper(),
            "player_id": pid,
            "player_name": safe_str(row.get("player_name")),
            "nfl_team": safe_str(row.get("nfl_team")),
            "event_seq": safe_int(row.get("event_seq"), 0),
            "event_type": safe_str(row.get("event_type")),
            "event_source": safe_str(row.get("event_source")),
            "event_date": safe_str(row.get("event_date")),
            "event_time": safe_str(row.get("event_time")),
            "franchise_id": safe_str(row.get("franchise_id")),
            "team_name": safe_str(row.get("team_name")),
            "event_detail": safe_str(row.get("detail")),
            "snapshot_week": snapshot_week,
            "snapshot_source": snapshot_source,
            "salary": salary,
            "contract_year": contract_year,
            "contract_status": contract_status,
            "contract_info": contract_info,
            "inferred_contract_info": inferred_contract_info,
            "contract_length": contract_length_val,
            "tcv": tcv_val,
            "aav": aav_val,
            "year_values_json": year_values_json_val,
            "extension_flag": extension_flag,
            "restructure_flag": restructure_flag,
            "mym_flag": mym_flag,
            "post_add_multi_year_flag": post_add_multi_year_flag,
            "post_add_multi_year_reason": post_add_multi_year_reason,
            "prior_snapshot_week": prior_snapshot_week,
            "prior_snapshot_source": prior_snapshot_source,
            "prior_salary": prior_salary,
            "prior_contract_year": prior_contract_year,
            "prior_contract_status": prior_contract_status,
            "prior_contract_info": prior_contract_info,
            "prior_inferred_contract_info": prior_inferred_contract_info,
            "prior_contract_length": safe_int(prior_parts.contract_length, 0) if prior_parts else 0,
            "prior_tcv": safe_int(prior_parts.tcv, 0) if prior_parts else 0,
            "prior_aav": safe_int(prior_parts.aav, 0) if prior_parts else 0,
            "prior_year_values_json": safe_str(prior_parts.year_values_json) if prior_parts else "{}",
            "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        }

        rows.append(base_row)

    def is_add_source(item: Dict[str, Any]) -> bool:
        if safe_str(item.get("event_type")).upper() != "ACQUIRE":
            return False
        src = safe_str(item.get("event_source")).upper()
        return (
            src.startswith("ADDDROP")
            or src.startswith("AUCTION")
            or src.startswith("ROOKIE_DRAFT")
            or src == "FREE_AGENT"
        )

    def extract_event_amount(item: Dict[str, Any]) -> int:
        detail = safe_str(item.get("event_detail"))
        if not detail:
            return 0
        m = re.search(r"bid=([0-9]+)", detail)
        if m:
            return safe_int(m.group(1), 0)
        m = re.search(r"salary=([0-9]+)", detail)
        if m:
            return safe_int(m.group(1), 0)
        return 0

    def apply_default_add(row: Dict[str, Any]) -> Dict[str, Any]:
        amount = extract_event_amount(row)
        salary_amt = amount if amount > 0 else safe_int(row.get("salary"), 0)
        row["event_detail"] = (
            f"{row['event_detail']}|default_1yr" if row.get("event_detail") else "default_1yr"
        )
        row["contract_year"] = 1
        row["contract_length"] = 1
        row["contract_status"] = "ADD_DEFAULT_1YR"
        row["contract_info"] = ""
        row["tcv"] = salary_amt
        row["aav"] = salary_amt
        row["year_values_json"] = (
            json.dumps({"Y1": salary_amt}, separators=(",", ":")) if salary_amt > 0 else "{}"
        )
        row["inferred_contract_info"] = (
            build_contract_info_string(1, salary_amt, format_k(salary_amt), {1: salary_amt}, "Default Add")
            if salary_amt > 0
            else ""
        )
        row["extension_flag"] = 0
        row["restructure_flag"] = 0
        row["mym_flag"] = 0
        row["post_add_multi_year_flag"] = 0
        row["post_add_multi_year_reason"] = ""
        row["salary"] = salary_amt
        return row

    # Normalize add events to default 1-year baseline.
    grouped: Dict[Tuple[str, int], List[Dict[str, Any]]] = {}
    for r in rows:
        key = (safe_str(r.get("player_id")), safe_int(r.get("season"), 0))
        grouped.setdefault(key, []).append(r)

    final_rows: List[Dict[str, Any]] = []
    for _key, group in grouped.items():
        add_candidates = [r for r in group if is_add_source(r)]
        for r in add_candidates:
            apply_default_add(r)

        # Deduplicate same-timestamp add/drop duplicates (prefer ADDDROP over FREE_AGENT).
        deduped: Dict[Tuple[str, str, str, str], Dict[str, Any]] = {}
        for r in group:
            key = (
                safe_str(r.get("event_type")),
                safe_str(r.get("event_date")),
                safe_str(r.get("event_time")),
                safe_str(r.get("franchise_id")),
            )
            src = safe_str(r.get("event_source")).upper()
            priority = 0
            if src.startswith("ADDDROP"):
                priority = 2
            elif src == "FREE_AGENT":
                priority = 1
            existing = deduped.get(key)
            if existing is None:
                deduped[key] = r
                deduped[key]["_dedupe_priority"] = priority
            else:
                if priority > safe_int(existing.get("_dedupe_priority"), 0):
                    deduped[key] = r
                    deduped[key]["_dedupe_priority"] = priority

        group = list(deduped.values())
        for r in group:
            if "_dedupe_priority" in r:
                r.pop("_dedupe_priority", None)

        def _sort_key(item: Dict[str, Any]):
            etype = safe_str(item.get("event_type")).upper()
            etype_rank = 1
            if etype == "ACQUIRE":
                etype_rank = 0
            elif etype == "CONTRACT_SUBMISSION":
                etype_rank = 1
            return (
                safe_str(item.get("event_date")),
                safe_str(item.get("event_time")),
                etype_rank,
                safe_int(item.get("event_seq"), 0),
            )

        group.sort(key=_sort_key)

        last_contract = None
        for item in group:
            etype = safe_str(item.get("event_type")).upper()
            if etype == "CONTRACT_SUBMISSION":
                if last_contract:
                    if safe_int(item.get("salary"), 0) <= 0:
                        item["salary"] = safe_int(last_contract.get("salary"), 0)
                    if safe_int(item.get("contract_year"), 0) <= 0:
                        item["contract_year"] = safe_int(last_contract.get("contract_year"), 0)
                    if not safe_str(item.get("contract_status")):
                        item["contract_status"] = safe_str(last_contract.get("contract_status"))
                years = 0
                m = re.search(r"years=([0-9]+)", safe_str(item.get("event_detail")), re.IGNORECASE)
                if m:
                    years = safe_int(m.group(1), 0)
                if years <= 0:
                    years = safe_int(item.get("contract_year"), 0)
                if years > 0:
                    item["contract_year"] = years
                    salary_val = safe_int(item.get("salary"), 0)
                    tcv_val = salary_val * years if salary_val > 0 else 0
                    aav_val = salary_val
                    year_values = {i: salary_val for i in range(1, years + 1)} if salary_val > 0 else {}
                    item["contract_length"] = years
                    item["tcv"] = tcv_val
                    item["aav"] = aav_val
                    item["year_values_json"] = (
                        json.dumps({f"Y{i}": salary_val for i in range(1, years + 1)}, separators=(",", ":"))
                        if salary_val > 0
                        else "{}"
                    )
                    item["inferred_contract_info"] = build_contract_info_string(
                        contract_length=years,
                        tcv=tcv_val,
                        aav_label=format_k(aav_val),
                        year_values=year_values,
                    )
            elif etype == "DROP":
                if last_contract:
                    for key in (
                        "salary",
                        "contract_year",
                        "contract_status",
                        "contract_info",
                        "inferred_contract_info",
                        "contract_length",
                        "tcv",
                        "aav",
                        "year_values_json",
                    ):
                        if safe_str(item.get(key)) == "" or safe_int(item.get(key), 0) == 0:
                            item[key] = last_contract.get(key)

            if safe_int(item.get("salary"), 0) > 0 or safe_int(item.get("contract_year"), 0) > 0:
                last_contract = {
                    "salary": safe_int(item.get("salary"), 0),
                    "contract_year": safe_int(item.get("contract_year"), 0),
                    "contract_status": safe_str(item.get("contract_status")),
                    "contract_info": safe_str(item.get("contract_info")),
                    "inferred_contract_info": safe_str(item.get("inferred_contract_info")),
                    "contract_length": safe_int(item.get("contract_length"), 0),
                    "tcv": safe_int(item.get("tcv"), 0),
                    "aav": safe_int(item.get("aav"), 0),
                    "year_values_json": safe_str(item.get("year_values_json")),
                }

        for idx, item in enumerate(group, 1):
            item["event_seq"] = idx
            final_rows.append(item)

    # MYM baseline: assign MYM only to the last add (acquire) of the season.
    by_season: Dict[Tuple[str, int], List[Dict[str, Any]]] = {}
    for r in final_rows:
        key = (safe_str(r.get("player_id")), safe_int(r.get("season"), 0))
        by_season.setdefault(key, []).append(r)

    for _key, group in by_season.items():
        if not any(safe_int(r.get("mym_flag"), 0) == 1 for r in group):
            continue
        acquires = [r for r in group if safe_str(r.get("event_type")).upper() == "ACQUIRE"]
        if not acquires:
            continue
        acquires.sort(
            key=lambda r: (
                safe_str(r.get("event_date")),
                safe_str(r.get("event_time")),
                safe_int(r.get("event_seq"), 0),
            )
        )
        last_acq = acquires[-1]
        anchor = None
        for r in group:
            if (
                safe_str(r.get("event_type")).upper() == "CONTRACT_SUBMISSION"
                and safe_str(r.get("event_date")) == safe_str(last_acq.get("event_date"))
                and safe_str(r.get("event_time")) == safe_str(last_acq.get("event_time"))
            ):
                anchor = r
                break
        if anchor is None:
            anchor = last_acq
        for r in group:
            r["mym_flag"] = 0
        anchor["mym_flag"] = 1
        if anchor.get("event_detail"):
            anchor["event_detail"] = f"{anchor['event_detail']}|mym_last_add"
        else:
            anchor["event_detail"] = "mym_last_add"

    return final_rows


def ensure_table(conn: sqlite3.Connection, table_name: str) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
          season INTEGER NOT NULL,
          position_filter TEXT NOT NULL,
          player_id TEXT NOT NULL,
          player_name TEXT,
          position TEXT,
          nfl_team TEXT,
          snapshot_week INTEGER,
          cutoff_contract_deadline_date TEXT,
          season_kickoff_date TEXT,
          season_end_date TEXT,
          season_end_week INTEGER,
          prior_season INTEGER,
          prior_season_last_week INTEGER,
          franchise_id TEXT,
          team_name TEXT,
          status TEXT,
          salary INTEGER,
          contract_year INTEGER,
          contract_status TEXT,
          contract_info TEXT,
          inferred_contract_info TEXT,
          extension_flag INTEGER,
          restructure_flag INTEGER,
          mym_flag INTEGER,
          cap_penalty_flag INTEGER,
          mid_year_multi_flag INTEGER,
          mid_year_multi_reason TEXT,
          end_season_contract_year INTEGER,
          contract_length INTEGER,
          tcv INTEGER,
          aav INTEGER,
          year_values_json TEXT,
          inferred_extension_term INTEGER,
          inferred_extension_rate INTEGER,
          multi_aav_flag INTEGER,
          parsed_aav_source TEXT,
          earned_to_date INTEGER,
          contract_year_index INTEGER,
          contract_year_value INTEGER,
          earned_season_full INTEGER,
          earned_season_prorated INTEGER,
          earned_total_through_season INTEGER,
          earned_remaining_after_season INTEGER,
          earned_as_of_date TEXT,
          legacy_gf_flag INTEGER,
          legacy_rule_flag INTEGER,
          remaining_tcv_at_drop INTEGER,
          legacy_cap_penalty_amount INTEGER,
          current_cap_penalty_amount INTEGER,
          at_time_cap_penalty_amount INTEGER,
          manual_review_flag INTEGER,
          manual_review_reason TEXT,
          prior_franchise_id TEXT,
          prior_team_name TEXT,
          prior_status TEXT,
          prior_salary INTEGER,
          prior_contract_year INTEGER,
          prior_contract_status TEXT,
          prior_contract_info TEXT,
          prior_contract_length INTEGER,
          prior_tcv INTEGER,
          prior_aav INTEGER,
          prior_year_values_json TEXT,
          prior_extension_flag INTEGER,
          prior_multi_aav_flag INTEGER,
          prior_parsed_aav_source TEXT,
          prior_earned_to_date INTEGER,
          prior_was_contract_status INTEGER,
          prior_rollover_expected_under_contract INTEGER,
          prior_expiring_contract INTEGER,
          week1_is_contract_status INTEGER,
          change_category TEXT,
          current_transaction_date TEXT,
          current_transaction_source TEXT,
          source_detail TEXT,
          drop_in_season_flag INTEGER,
          drop_week_guess INTEGER,
          drop_on_taxi_flag INTEGER,
          taxi_eligible_drop_flag INTEGER,
          taxi_eligible_reason TEXT,
          tag_cut_pre_auction_flag INTEGER,
          waiver_pickup_flag INTEGER,
          waiver_guarantee_pct REAL,
          waiver_guarantee_amount INTEGER,
          drop_earned_amount INTEGER,
          drop_guarantee_amount INTEGER,
          draftpick_round INTEGER,
          draftpick_roundorder INTEGER,
          draftpick_overall INTEGER,
          auction_type TEXT,
          auction_bid_amount INTEGER,
          auction_date TEXT,
          drop_count_pre_deadline INTEGER,
          last_drop_date TEXT,
          last_drop_team TEXT,
          last_drop_method TEXT,
          last_drop_raw_type TEXT,
          add_count_pre_deadline INTEGER,
          last_add_date TEXT,
          last_add_team TEXT,
          last_add_method TEXT,
          last_add_raw_type TEXT,
          last_add_salary INTEGER,
          trade_count_pre_deadline INTEGER,
          last_trade_date TEXT,
          last_trade_group_id TEXT,
          cap_penalty INTEGER,
          cap_penalty_note TEXT,
          legacy_cap_penalty_amount INTEGER,
          current_cap_penalty_amount INTEGER,
          at_time_cap_penalty_amount INTEGER,
          generated_at_utc TEXT,
          PRIMARY KEY (season, position_filter, player_id)
        )
        """
    )
    # Lightweight schema migration for existing installs.
    existing = {
        safe_str(r[1]) for r in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    required_cols = {
        "season_kickoff_date": "TEXT",
        "season_end_date": "TEXT",
        "season_end_week": "INTEGER",
        "current_transaction_date": "TEXT",
        "current_transaction_source": "TEXT",
        "inferred_contract_info": "TEXT",
        "extension_flag": "INTEGER",
        "restructure_flag": "INTEGER",
        "mym_flag": "INTEGER",
        "cap_penalty_flag": "INTEGER",
        "mid_year_multi_flag": "INTEGER",
        "mid_year_multi_reason": "TEXT",
        "end_season_contract_year": "INTEGER",
        "contract_year_index": "INTEGER",
        "contract_year_value": "INTEGER",
        "earned_season_full": "INTEGER",
        "earned_season_prorated": "INTEGER",
        "earned_total_through_season": "INTEGER",
        "earned_remaining_after_season": "INTEGER",
        "earned_as_of_date": "TEXT",
        "inferred_extension_term": "INTEGER",
        "inferred_extension_rate": "INTEGER",
        "legacy_gf_flag": "INTEGER",
        "legacy_rule_flag": "INTEGER",
        "remaining_tcv_at_drop": "INTEGER",
        "legacy_cap_penalty_amount": "INTEGER",
        "current_cap_penalty_amount": "INTEGER",
        "at_time_cap_penalty_amount": "INTEGER",
        "manual_review_flag": "INTEGER",
        "manual_review_reason": "TEXT",
        "drop_in_season_flag": "INTEGER",
        "drop_week_guess": "INTEGER",
        "drop_on_taxi_flag": "INTEGER",
        "taxi_eligible_drop_flag": "INTEGER",
        "taxi_eligible_reason": "TEXT",
        "tag_cut_pre_auction_flag": "INTEGER",
        "waiver_pickup_flag": "INTEGER",
        "waiver_guarantee_pct": "REAL",
        "waiver_guarantee_amount": "INTEGER",
        "drop_earned_amount": "INTEGER",
        "drop_guarantee_amount": "INTEGER",
    }
    for col_name, col_type in required_cols.items():
        if col_name not in existing:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_type}")


def ensure_owner_lineage_table(conn: sqlite3.Connection, table_name: str) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
          season INTEGER NOT NULL,
          position_filter TEXT NOT NULL,
          player_id TEXT NOT NULL,
          lineage_seq INTEGER NOT NULL,
          player_name TEXT,
          nfl_team TEXT,
          owner_franchise_id TEXT,
          owner_team_name TEXT,
          stint_start_date TEXT,
          stint_end_date TEXT,
          acquire_source TEXT,
          close_source TEXT,
          week1_owner_franchise_id TEXT,
          week1_owner_team_name TEXT,
          prior_owner_franchise_id TEXT,
          prior_owner_team_name TEXT,
          week1_contract_info TEXT,
          prior_contract_info TEXT,
          generated_at_utc TEXT,
          PRIMARY KEY (season, position_filter, player_id, lineage_seq)
        )
        """
    )


def ensure_txn_snapshot_table(conn: sqlite3.Connection, table_name: str) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
          season INTEGER NOT NULL,
          position_filter TEXT NOT NULL,
          player_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL,
          player_name TEXT,
          nfl_team TEXT,
          event_type TEXT,
          event_source TEXT,
          event_date TEXT,
          event_time TEXT,
          franchise_id TEXT,
          team_name TEXT,
          event_detail TEXT,
          snapshot_week INTEGER,
          snapshot_source TEXT,
          salary INTEGER,
          contract_year INTEGER,
          contract_status TEXT,
          contract_info TEXT,
          inferred_contract_info TEXT,
          contract_length INTEGER,
          tcv INTEGER,
          aav INTEGER,
          year_values_json TEXT,
          extension_flag INTEGER,
          restructure_flag INTEGER,
          mym_flag INTEGER,
          post_add_multi_year_flag INTEGER,
          post_add_multi_year_reason TEXT,
          prior_snapshot_week INTEGER,
          prior_snapshot_source TEXT,
          prior_salary INTEGER,
          prior_contract_year INTEGER,
          prior_contract_status TEXT,
          prior_contract_info TEXT,
          prior_inferred_contract_info TEXT,
          prior_contract_length INTEGER,
          prior_tcv INTEGER,
          prior_aav INTEGER,
          prior_year_values_json TEXT,
          generated_at_utc TEXT,
          PRIMARY KEY (season, position_filter, player_id, event_seq)
        )
        """
    )

    existing = {
        safe_str(r[1]) for r in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    required_cols = {
        "prior_snapshot_week": "INTEGER",
        "prior_snapshot_source": "TEXT",
        "prior_salary": "INTEGER",
        "prior_contract_year": "INTEGER",
        "prior_contract_status": "TEXT",
        "prior_contract_info": "TEXT",
        "prior_inferred_contract_info": "TEXT",
        "prior_contract_length": "INTEGER",
        "prior_tcv": "INTEGER",
        "prior_aav": "INTEGER",
        "prior_year_values_json": "TEXT",
        "post_add_multi_year_flag": "INTEGER",
        "post_add_multi_year_reason": "TEXT",
    }
    for col_name, col_type in required_cols.items():
        if col_name not in existing:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_type}")


def sync_extension_flags(conn: sqlite3.Connection, table_name: str) -> None:
    existing = {
        safe_str(r[1]) for r in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    updates: List[str] = []
    if "extension_inferred" in existing:
        updates.append("extension_inferred = extension_flag")
    if "extension_inferred_flag" in existing:
        updates.append("extension_inferred_flag = extension_flag")
    if not updates:
        return
    conn.execute(f"UPDATE {table_name} SET {', '.join(updates)}")


def upsert_rows(
    conn: sqlite3.Connection,
    table_name: str,
    rows: List[Dict[str, Any]],
    pk_cols: Optional[List[str]] = None,
) -> int:
    if not rows:
        return 0
    if not pk_cols:
        pk_cols = ["season", "position_filter", "player_id"]
    cols = list(rows[0].keys())
    placeholders = ", ".join([f":{c}" for c in cols])
    col_csv = ", ".join(cols)
    update_cols = [c for c in cols if c not in set(pk_cols)]
    update_sql = ", ".join([f"{c}=excluded.{c}" for c in update_cols])
    pk_csv = ", ".join(pk_cols)
    sql = f"""
      INSERT INTO {table_name} ({col_csv})
      VALUES ({placeholders})
      ON CONFLICT({pk_csv}) DO UPDATE SET
      {update_sql}
    """
    conn.executemany(sql, rows)
    return len(rows)


def write_csv(path: Path, rows: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        with path.open("w", newline="") as f:
            f.write("")
        return
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--position", default="QB")
    parser.add_argument("--season", type=int, default=0, help="Optional single season to build")
    parser.add_argument("--start-season", type=int, default=0)
    parser.add_argument("--end-season", type=int, default=0)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--table-name", default=DEFAULT_TABLE)
    parser.add_argument("--owner-lineage-table", default=DEFAULT_OWNER_LINEAGE_TABLE)
    parser.add_argument("--txn-snapshot-table", default=DEFAULT_TXN_SNAPSHOT_TABLE)
    parser.add_argument("--write-table", type=int, default=1)
    args = parser.parse_args()

    position = normalize_position(args.position)
    out_dir = Path(args.out_dir)
    conn = get_conn(args.db_path)
    conn.row_factory = sqlite3.Row

    seasons = fetch_seasons(conn)
    if args.season > 0:
        seasons = [args.season]
    else:
        # Default baseline window starts in 2017 unless overridden.
        effective_start = args.start_season if args.start_season > 0 else 2017
        seasons = [s for s in seasons if s >= effective_start]
        if args.start_season > 0:
            seasons = [s for s in seasons if s >= args.start_season]
        if args.end_season > 0:
            seasons = [s for s in seasons if s <= args.end_season]

    all_rows: List[Dict[str, Any]] = []
    owner_lineage_rows: List[Dict[str, Any]] = []
    timeline_rows: List[Dict[str, Any]] = []
    txn_snapshot_rows: List[Dict[str, Any]] = []
    for season in seasons:
        season_rows = build_rows_for_season(conn, season, position)
        all_rows.extend(season_rows)
        owner_rows = build_owner_lineage_rows_for_season(conn, season, position)
        owner_lineage_rows.extend(owner_rows)
        timeline_rows.extend(build_timeline_rows_for_season(conn, season, position))
        txn_snapshot_rows.extend(build_transaction_snapshot_rows_for_season(conn, season, position))

    # Requested review order:
    # player_name, season, week, transaction_date.
    all_rows.sort(
        key=lambda r: (
            safe_str(r.get("player_name")).lower(),
            safe_int(r.get("season"), 0),
            safe_int(r.get("snapshot_week"), 0),
            safe_str(r.get("current_transaction_date")),
            safe_str(r.get("player_id")),
        )
    )

    # Primary full output.
    full_csv = out_dir / f"contract_history_{position.lower()}.csv"
    write_csv(full_csv, all_rows)

    # Owner lineage output (one row per owner stint within season).
    owner_lineage_rows.sort(
        key=lambda r: (
            safe_str(r.get("player_name")).lower(),
            safe_int(r.get("season"), 0),
            safe_str(r.get("stint_start_date")),
            safe_int(r.get("lineage_seq"), 0),
            safe_str(r.get("player_id")),
        )
    )
    owner_csv = out_dir / f"contract_history_{position.lower()}_owner_lineage.csv"
    write_csv(owner_csv, owner_lineage_rows)

    timeline_rows.sort(
        key=lambda r: (
            safe_str(r.get("player_name")).lower(),
            safe_int(r.get("season"), 0),
            safe_str(r.get("event_date")),
            safe_str(r.get("event_time")),
            safe_int(r.get("event_seq"), 0),
            safe_str(r.get("player_id")),
        )
    )
    timeline_csv = out_dir / f"contract_history_{position.lower()}_timeline.csv"
    write_csv(timeline_csv, timeline_rows)

    txn_snapshot_rows.sort(
        key=lambda r: (
            safe_str(r.get("player_name")).lower(),
            safe_int(r.get("season"), 0),
            safe_str(r.get("event_date")),
            safe_str(r.get("event_time")),
            safe_int(r.get("event_seq"), 0),
            safe_str(r.get("player_id")),
        )
    )
    txn_snapshot_csv = out_dir / f"contract_history_{position.lower()}_transaction_snapshots.csv"
    # Do not emit prior_* contract fields to CSV (kept in DB for audit).
    txn_snapshot_csv_rows = []
    preferred_order = [
        "season",
        "player_name",
        "event_type",
        "event_source",
        "event_date",
        "team_name",
        "salary",
        "contract_year",
        "contract_status",
        "contract_info",
        "inferred_contract_info",
        "contract_length",
        "tcv",
        "aav",
    ]
    for r in txn_snapshot_rows:
        filtered = {k: v for k, v in r.items() if not k.startswith("prior_")}
        ordered: Dict[str, Any] = {}
        for key in preferred_order:
            if key in filtered:
                ordered[key] = filtered[key]
        for key in filtered.keys():
            if key not in ordered:
                ordered[key] = filtered[key]
        txn_snapshot_csv_rows.append(ordered)
    write_csv(txn_snapshot_csv, txn_snapshot_csv_rows)

    # Focus output: players that were under contract in prior season and dropped pre-deadline.
    dropped_rows = [
        r
        for r in all_rows
        if safe_int(r.get("prior_was_contract_status"), 0) == 1
        and safe_int(r.get("drop_count_pre_deadline"), 0) > 0
    ]
    dropped_csv = out_dir / f"contract_history_{position.lower()}_dropped_under_contract.csv"
    write_csv(dropped_csv, dropped_rows)

    # Focus output: inferred extensions.
    extension_rows = [r for r in all_rows if safe_int(r.get("extension_flag"), 0) == 1]
    ext_csv = out_dir / f"contract_history_{position.lower()}_extension_inferred.csv"
    write_csv(ext_csv, extension_rows)

    # Focus output: manual review flags.
    manual_review_rows = [r for r in all_rows if safe_int(r.get("manual_review_flag"), 0) == 1]
    manual_review_csv = out_dir / f"contract_history_{position.lower()}_manual_review.csv"
    write_csv(manual_review_csv, manual_review_rows)

    wrote = 0
    wrote_owner = 0
    if args.write_table == 1:
        ensure_table(conn, args.table_name)
        wrote = upsert_rows(conn, args.table_name, all_rows)
        sync_extension_flags(conn, args.table_name)
        ensure_owner_lineage_table(conn, args.owner_lineage_table)
        wrote_owner = upsert_rows(
            conn,
            args.owner_lineage_table,
            owner_lineage_rows,
            pk_cols=["season", "position_filter", "player_id", "lineage_seq"],
        )
        ensure_txn_snapshot_table(conn, args.txn_snapshot_table)
        wrote_txn = upsert_rows(
            conn,
            args.txn_snapshot_table,
            txn_snapshot_rows,
            pk_cols=["season", "position_filter", "player_id", "event_seq"],
        )
        conn.commit()

    conn.close()

    print(f"Position: {position}")
    print(f"Seasons processed: {', '.join(map(str, seasons)) if seasons else '(none)'}")
    print(f"Rows: {len(all_rows)}")
    print(f"Dropped-under-contract rows: {len(dropped_rows)}")
    print(f"Extension-inferred rows: {len(extension_rows)}")
    print(f"Wrote CSV: {full_csv}")
    print(f"Wrote CSV: {owner_csv}")
    print(f"Wrote CSV: {timeline_csv}")
    print(f"Wrote CSV: {txn_snapshot_csv}")
    print(f"Wrote CSV: {dropped_csv}")
    print(f"Wrote CSV: {ext_csv}")
    print(f"Wrote CSV: {manual_review_csv}")
    if args.write_table == 1:
        print(f"Upserted rows in table {args.table_name}: {wrote}")
        print(f"Upserted rows in table {args.owner_lineage_table}: {wrote_owner}")
        print(f"Upserted rows in table {args.txn_snapshot_table}: {wrote_txn}")


if __name__ == "__main__":
    main()
