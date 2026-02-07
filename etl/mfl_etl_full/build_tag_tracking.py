#!/usr/bin/env python3
"""
Build in-season tag tracking JSON.

Tag tracking (current season):
- Candidates are players on active rosters with contract_year = 1.
- Ranking source is player_pointssummary.pos_rank for the same season.
- Tag tier is determined by positional rank ranges.
- Tag salary is determined by tier formula:
  - Most positions: average week-1 AAV of players in the tier's salary-rank band.
  - Kickers (PK): prior season salary + 1,000 (tracked as current salary + 1,000 in-season).
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from db_utils import DEFAULT_DB_PATH, get_conn


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUT_PATH = ROOT_DIR / "tag_tracking.json"


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
    t = safe_str(token).upper().replace(",", "")
    if not t:
        return 0
    if t.endswith("K"):
        num = t[:-1].strip()
        try:
            return int(round(float(num) * 1000))
        except ValueError:
            return 0
    return safe_int(t, 0)


def parse_aav_from_contract_info(contract_info: str) -> int:
    txt = safe_str(contract_info)
    if not txt:
        return 0
    import re

    m = re.search(r"\bAAV\s+([0-9]+(?:\.[0-9]+)?K?)", txt, re.IGNORECASE)
    if not m:
        return 0
    return parse_money_token(m.group(1))


def effective_aav(db_aav: int, salary: int, contract_info: str) -> int:
    parsed = parse_aav_from_contract_info(contract_info)
    if parsed > 0:
        return parsed
    # Guard against historical parser artifacts (e.g., 4,656,000 from "46K, 56K").
    if db_aav > 0 and db_aav <= 200000:
        return db_aav
    return max(0, salary)


def round_up_1000(value: float) -> int:
    return int(max(1000, math.ceil(float(value) / 1000.0) * 1000))


def is_non_rookie_contract_status(status: str) -> bool:
    s = safe_str(status).upper()
    if not s:
        return False
    # Not a contract type for tagging.
    blocked_fragments = ("ROOKIE", "WW", "WAIVER", "BL", "FA", "FREE")
    return not any(tok in s for tok in blocked_fragments)


def now_local_stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def default_tracking_season() -> int:
    # Match your existing March 1 rollover behavior.
    now = datetime.now()
    return now.year if now.month >= 3 else now.year - 1


def normalize_pos_group(position: str, pos_group: str) -> str:
    g = safe_str(pos_group).upper()
    p = safe_str(position).upper()
    if g:
        if g in {"K", "PK", "PN"}:
            return "PK"
        return g
    if p in {"CB", "S", "DB"}:
        return "DB"
    if p in {"DE", "DT", "DL"}:
        return "DL"
    if p in {"K", "PK", "PN"}:
        return "PK"
    return p


@dataclass(frozen=True)
class TierRule:
    tier: int
    rank_min: int
    rank_max: Optional[int]
    avg_rank_min: Optional[int]
    avg_rank_max: Optional[int]
    rule_label: str


TAG_RULES: Dict[str, List[TierRule]] = {
    "QB": [
        TierRule(1, 1, 5, 1, 5, "Avg Top 1-5 QB AAV"),
        TierRule(2, 6, 15, 6, 15, "Avg Top 6-15 QB AAV"),
        TierRule(3, 16, None, 16, None, "Avg Top 16+ QB AAV"),
    ],
    "RB": [
        TierRule(1, 1, 4, 1, 4, "Avg Top 1-4 RB AAV"),
        TierRule(2, 5, 8, 5, 8, "Avg Top 5-8 RB AAV"),
        TierRule(3, 9, None, 9, 31, "Avg Top 9-31 RB AAV"),
    ],
    "WR": [
        TierRule(1, 1, 6, 1, 6, "Avg Top 1-6 WR AAV"),
        TierRule(2, 7, 14, 7, 14, "Avg Top 7-14 WR AAV"),
        TierRule(3, 15, None, 15, 40, "Avg Top 15-40 WR AAV"),
    ],
    "TE": [
        TierRule(1, 1, 3, 1, 3, "Avg Top 1-3 TE AAV"),
        TierRule(2, 4, 6, 4, 6, "Avg Top 4-6 TE AAV"),
        TierRule(3, 7, None, 7, 13, "Avg Top 7-13 TE AAV"),
    ],
    "DL": [
        TierRule(1, 1, 6, 1, 6, "Avg Top 1-6 DL AAV"),
        TierRule(2, 7, None, 7, 12, "Avg Top 7-12 DL AAV"),
    ],
    "LB": [
        TierRule(1, 1, 6, 1, 6, "Avg Top 1-6 LB AAV"),
        TierRule(2, 7, None, 7, 12, "Avg Top 7-12 LB AAV"),
    ],
    "DB": [
        TierRule(1, 1, 6, 1, 6, "Avg Top 1-6 DB AAV"),
        TierRule(2, 7, None, 7, 12, "Avg Top 7-12 DB AAV"),
    ],
    "PK": [
        TierRule(1, 1, None, None, None, "Prior salary + 1K"),
    ],
}


def lookup_tier_rule(pos_group: str, pos_rank: int) -> Optional[TierRule]:
    rules = TAG_RULES.get(pos_group, [])
    if pos_rank <= 0:
        return None
    for rule in rules:
        upper_ok = True if rule.rank_max is None else pos_rank <= rule.rank_max
        if pos_rank >= rule.rank_min and upper_ok:
            return rule
    return None


def fetch_league_id(conn, season: int) -> str:
    row = conn.execute(
        "SELECT league_id FROM league_years WHERE season = ? LIMIT 1",
        (season,),
    ).fetchone()
    return safe_str(row[0]) if row else ""


def fetch_regular_season_week(conn, season: int) -> int:
    row = conn.execute(
        "SELECT end_week, last_regular_season_week FROM metadata_leaguedetails WHERE season = ? LIMIT 1",
        (season,),
    ).fetchone()
    if not row:
        return 17
    end_week = safe_int(row[0], 0)
    last_reg_week = safe_int(row[1], 0)
    # UPS rulebook uses NFL schedule length: 17 (modern) or 16 (legacy).
    if end_week in (16, 17):
        return end_week
    if last_reg_week in (16, 17):
        return last_reg_week
    return 17


def fetch_candidates(conn, season: int) -> List[Dict[str, Any]]:
    sql = """
    SELECT
      rc.season,
      rc.franchise_id,
      COALESCE(rc.team_name, '') AS franchise_name,
      rc.player_id,
      COALESCE(rc.player_name, '') AS player_name,
      COALESCE(rc.position, '') AS position,
      COALESCE(rc.salary, 0) AS salary,
      COALESCE(rc.aav, 0) AS aav_db,
      COALESCE(rc.contract_year, 0) AS contract_year,
      COALESCE(rc.contract_status, '') AS contract_status,
      COALESCE(rc.contract_info, '') AS contract_info,
      COALESCE(rc.status, '') AS roster_status
    FROM rosters_current rc
    WHERE rc.season = ?
      AND rc.contract_year = 1
      AND rc.status IN ('ROSTER', 'INJURED_RESERVE')
    """
    rows = []
    for r in conn.execute(sql, (season,)).fetchall():
        contract_status = safe_str(r[9])
        if not is_non_rookie_contract_status(contract_status):
            continue
        rows.append(
            {
                "season": safe_int(r[0], season),
                "franchise_id": safe_str(r[1]).zfill(4)[-4:],
                "franchise_name": safe_str(r[2]),
                "player_id": safe_str(r[3]),
                "player_name": safe_str(r[4]),
                "position": safe_str(r[5]),
                "positional_grouping": normalize_pos_group(r[5], ""),
                "salary": safe_int(r[6], 0),
                "aav_db": safe_int(r[7], 0),
                "contract_year": safe_int(r[8], 0),
                "contract_status": contract_status,
                "contract_info": safe_str(r[10]),
                "roster_status": safe_str(r[11]),
            }
        )
    for row in rows:
        row["aav"] = effective_aav(row["aav_db"], row["salary"], row["contract_info"])
    return rows


def fetch_scoring_rank_map(
    conn, season: int, last_regular_week: int
) -> Dict[str, Dict[str, Any]]:
    sql = """
    WITH pts AS (
      SELECT
        CAST(player_id AS TEXT) AS player_id,
        COALESCE(MAX(player_name), '') AS player_name,
        COALESCE(MAX(position), '') AS position,
        COALESCE(MAX(pos_group), '') AS pos_group,
        SUM(COALESCE(score, 0)) AS points_total,
        SUM(CASE WHEN COALESCE(score, 0) > 0 THEN 1 ELSE 0 END) AS games_played
      FROM player_weeklyscoringresults
      WHERE season = ?
        AND week BETWEEN 1 AND ?
      GROUP BY CAST(player_id AS TEXT)
    ),
    ranked AS (
      SELECT
        player_id,
        player_name,
        position,
        pos_group,
        points_total,
        games_played
      FROM pts
    )
    SELECT
      player_id,
      player_name,
      position,
      pos_group,
      points_total,
      games_played
    FROM ranked
    """
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in conn.execute(sql, (season, last_regular_week)).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        pos_group = normalize_pos_group(row[2], row[3])
        points_total = float(row[4] or 0)
        games_played = safe_int(row[5], 0)
        ppg = points_total / games_played if games_played > 0 else 0.0
        grouped.setdefault(pos_group, []).append(
            {
                "player_id": pid,
                "player_name": safe_str(row[1]),
                "position": safe_str(row[2]),
                "positional_grouping": pos_group,
                "points_total": points_total,
                "games_played": games_played,
                "points_per_game": ppg,
            }
        )

    out: Dict[str, Dict[str, Any]] = {}
    min_games = int(math.ceil(last_regular_week / 2.0))
    for pos_group, items in grouped.items():
        items.sort(key=lambda x: (-float(x["points_total"]), safe_str(x["player_name"]).lower()))
        for idx, item in enumerate(items, start=1):
            out[item["player_id"]] = {
                **item,
                "pos_rank": idx,
                "ppg_rank": 0,
                "ppg_min_games": min_games,
            }

        eligible = [i for i in items if safe_int(i["games_played"]) >= min_games]
        eligible.sort(
            key=lambda x: (
                -float(x["points_per_game"]),
                -float(x["points_total"]),
                safe_str(x["player_name"]).lower(),
            )
        )
        for idx, item in enumerate(eligible, start=1):
            if item["player_id"] in out:
                out[item["player_id"]]["ppg_rank"] = idx
    return out


def fetch_week1_aav_map(conn, season: int) -> Dict[str, int]:
    sql = """
    SELECT
      CAST(player_id AS TEXT) AS player_id,
      COALESCE(position, '') AS position,
      COALESCE(status, '') AS roster_status,
      COALESCE(contract_status, '') AS contract_status,
      COALESCE(salary, 0) AS salary,
      COALESCE(contract_info, '') AS contract_info
    FROM rosters_weekly
    WHERE season = ?
      AND week = 1
    """
    out: Dict[str, int] = {}
    for row in conn.execute(sql, (season,)).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        roster_status = safe_str(row[2]).upper()
        if roster_status and roster_status not in {"ROSTER", "INJURED_RESERVE"}:
            continue
        salary = safe_int(row[4], 0)
        info = safe_str(row[5])
        aav = effective_aav(0, salary, info)
        if aav > 0:
            out[pid] = max(safe_int(out.get(pid), 0), aav)
    return out


def avg_values(vals: List[int]) -> int:
    if not vals:
        return 0
    avg = sum(vals) / len(vals)
    return round_up_1000(avg)


def fetch_week1_aav_by_pos(conn, season: int) -> Dict[str, List[Dict[str, Any]]]:
    sql = """
    SELECT
      CAST(player_id AS TEXT) AS player_id,
      COALESCE(player_name, '') AS player_name,
      COALESCE(position, '') AS position,
      COALESCE(status, '') AS roster_status,
      COALESCE(salary, 0) AS salary,
      COALESCE(contract_info, '') AS contract_info
    FROM rosters_weekly
    WHERE season = ?
      AND week = 1
    """
    per_player: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in conn.execute(sql, (season,)).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        name = safe_str(row[1])
        pos_group = normalize_pos_group(row[2], "")
        if pos_group not in TAG_RULES:
            continue
        roster_status = safe_str(row[3]).upper()
        if roster_status and roster_status not in {"ROSTER", "INJURED_RESERVE"}:
            continue
        salary = safe_int(row[4], 0)
        info = safe_str(row[5])
        aav = effective_aav(0, salary, info)
        if aav <= 0:
            continue
        key = (pos_group, pid)
        existing = per_player.get(key)
        if not existing or aav > safe_int(existing.get("aav"), 0):
            per_player[key] = {
                "player_id": pid,
                "player_name": name,
                "aav": aav,
            }

    by_pos: Dict[str, List[Dict[str, Any]]] = {}
    for (pos_group, _pid), rec in per_player.items():
        by_pos.setdefault(pos_group, []).append(rec)
    for pos_group in by_pos:
        by_pos[pos_group].sort(
            key=lambda x: (-safe_int(x.get("aav"), 0), safe_str(x.get("player_name")).lower())
        )
    return by_pos


def fetch_tagged_season_ids(conn, season: int) -> set[str]:
    if season <= 0:
        return set()
    tagged: set[str] = set()
    sql_weekly = """
    SELECT DISTINCT CAST(player_id AS TEXT) AS player_id
    FROM rosters_weekly
    WHERE season = ?
      AND UPPER(COALESCE(contract_status, '')) LIKE '%TAG%'
    """
    for row in conn.execute(sql_weekly, (season,)).fetchall():
        pid = safe_str(row[0])
        if pid:
            tagged.add(pid)
    sql_current = """
    SELECT DISTINCT CAST(player_id AS TEXT) AS player_id
    FROM rosters_current
    WHERE season = ?
      AND UPPER(COALESCE(contract_status, '')) LIKE '%TAG%'
    """
    for row in conn.execute(sql_current, (season,)).fetchall():
        pid = safe_str(row[0])
        if pid:
            tagged.add(pid)
    return tagged


def resolve_exclude_tag_season(season: int, override: int = 0) -> int:
    if override and override > 0:
        return override
    # Offseason logic: if we're in Jan/Feb and tracking the prior season,
    # exclude tags from that same season (since we're preparing for next year).
    now = datetime.now()
    if now.month < 3 and season == now.year - 1:
        return season
    return season - 1


def extract_aav_list(values: List[Any]) -> List[int]:
    if not values:
        return []
    if isinstance(values[0], dict):
        return [safe_int(v.get("aav"), 0) for v in values if safe_int(v.get("aav"), 0) > 0]
    return [safe_int(v, 0) for v in values if safe_int(v, 0) > 0]


def build_tier_bid_map(
    week1_aav_by_pos: Dict[str, List[Dict[str, Any]]]
) -> Dict[Tuple[str, int], int]:
    out: Dict[Tuple[str, int], int] = {}
    for pos_group, rules in TAG_RULES.items():
        salary_ranked_aavs = extract_aav_list(week1_aav_by_pos.get(pos_group, []))
        for rule in rules:
            if pos_group == "PK":
                # PK/PN tier bid comes from player-specific prior AAV + 1K.
                # Keep base at 0 to indicate per-player computation.
                out[(pos_group, rule.tier)] = 0
                continue
            if rule.avg_rank_min is None:
                out[(pos_group, rule.tier)] = 0
                continue
            start = max(0, rule.avg_rank_min - 1)
            if rule.avg_rank_max is None:
                end = len(salary_ranked_aavs)
            else:
                end = max(start, rule.avg_rank_max)
            vals = salary_ranked_aavs[start:end]
            out[(pos_group, rule.tier)] = avg_values(vals)
    return out


def tag_side(pos_group: str) -> str:
    p = safe_str(pos_group).upper()
    if p in {"QB", "RB", "WR", "TE"}:
        return "OFFENSE"
    if p in {"DL", "LB", "DB", "PK"}:
        return "IDP_K"
    return "OTHER"


def build_calc_breakdown(
    week1_aav_by_pos: Dict[str, List[Dict[str, Any]]]
) -> Dict[str, Dict[str, Any]]:
    breakdown: Dict[str, Dict[str, Any]] = {}
    for pos_group, rules in TAG_RULES.items():
        players = week1_aav_by_pos.get(pos_group, [])
        ranked = [
            {
                "rank": idx + 1,
                "player_id": safe_str(p.get("player_id")),
                "player_name": safe_str(p.get("player_name")),
                "aav": safe_int(p.get("aav"), 0),
            }
            for idx, p in enumerate(players)
        ]
        tiers: List[Dict[str, Any]] = []
        for rule in rules:
            players_in_range: List[Dict[str, Any]] = []
            if rule.avg_rank_min is None:
                if pos_group == "PK":
                    players_in_range = ranked
            else:
                start = max(1, rule.avg_rank_min)
                end = rule.avg_rank_max if rule.avg_rank_max is not None else len(ranked)
                players_in_range = [p for p in ranked if start <= safe_int(p["rank"]) <= end]
            base_bid = 0
            if pos_group != "PK" and players_in_range:
                base_bid = avg_values([safe_int(p.get("aav"), 0) for p in players_in_range])
            tiers.append(
                {
                    "tier": rule.tier,
                    "label": rule.rule_label,
                    "rank_min": rule.avg_rank_min,
                    "rank_max": rule.avg_rank_max,
                    "base_bid": base_bid,
                    "players": players_in_range,
                }
            )
        breakdown[pos_group] = {"tiers": tiers}
    return breakdown


def build_rows(
    conn, season: int, exclude_tag_season: int, week1_aav_by_pos: Dict[str, List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    league_id = fetch_league_id(conn, season)
    last_regular_week = fetch_regular_season_week(conn, season)
    candidates = fetch_candidates(conn, season)
    tagged_prev = fetch_tagged_season_ids(conn, exclude_tag_season)
    scoring_map = fetch_scoring_rank_map(conn, season, last_regular_week)
    prior_aav_map = fetch_week1_aav_map(conn, season)
    tier_bid_map = build_tier_bid_map(week1_aav_by_pos)

    # Fallback for missing week 1 AAVs.
    for c in candidates:
        pid = safe_str(c["player_id"])
        if pid and pid not in prior_aav_map and safe_int(c["aav"], 0) > 0:
            prior_aav_map[pid] = safe_int(c["aav"], 0)

    out = []
    for c in candidates:
        pid = safe_str(c["player_id"])
        pos_group = safe_str(c["positional_grouping"]).upper()
        if pos_group not in TAG_RULES:
            continue
        score = scoring_map.get(pid, {})
        rank = safe_int(score.get("pos_rank"), 0)
        points_total = float(score.get("points_total") or 0)
        points_per_game = float(score.get("points_per_game") or 0)
        games_played = safe_int(score.get("games_played"), 0)
        ppg_rank = safe_int(score.get("ppg_rank"), 0)
        ppg_min_games = safe_int(score.get("ppg_min_games"), 0)
        rule = lookup_tier_rule(pos_group, rank)

        tier = safe_int(rule.tier, 0) if rule else 0
        rank_band = ""
        base_bid = 0
        prior_aav = safe_int(prior_aav_map.get(pid), 0)
        tag_bid = 0
        formula = ""
        bump_applied = 0

        if rule:
            if rule.rank_max is None:
                rank_band = f"{rule.rank_min}+"
            else:
                rank_band = f"{rule.rank_min}-{rule.rank_max}"

            if pos_group == "PK":
                base_bid = max(1000, prior_aav + 1000)
                tag_bid = base_bid
                formula = "K/P rule: prior AAV + 1,000"
            else:
                base_bid = safe_int(tier_bid_map.get((pos_group, tier)), 0)
                tag_bid = base_bid
                formula = rule.rule_label
                if prior_aav >= base_bid and prior_aav > 0:
                    tag_bid = round_up_1000(prior_aav * 1.10)
                    bump_applied = 1
                    formula += " | 10% prior AAV bump (rounded up)"

        was_tagged_prev = pid in tagged_prev
        is_eligible = 1 if (rule is not None and tier > 0 and tag_bid > 0) else 0
        eligibility_reason = ""
        if not is_eligible:
            if rank <= 0:
                eligibility_reason = "No positional rank yet (insufficient scoring sample)."
            elif not rule:
                eligibility_reason = "No tier rule matched for position/rank."
            elif prior_aav <= 0:
                eligibility_reason = "Missing prior-season AAV from week 1 snapshot."
            elif tag_bid <= 0:
                eligibility_reason = "Could not compute tag bid."
            else:
                eligibility_reason = "Not eligible."
        if was_tagged_prev:
            is_eligible = 0
            eligibility_reason = f"Tagged in {exclude_tag_season} (ineligible)."

        row = {
            "league_id": league_id,
            "season": season,
            "franchise_id": c["franchise_id"],
            "franchise_name": c["franchise_name"],
            "player_id": c["player_id"],
            "player_name": c["player_name"],
            "position": c["position"],
            "positional_grouping": pos_group,
            "salary": c["salary"],
            "aav": c["aav"],
            "prior_aav_week1": prior_aav,
            "contract_year": c["contract_year"],
            "contract_status": c["contract_status"],
            "contract_info": c["contract_info"],
            "points_total": points_total,
            "points_per_game": points_per_game,
            "games_played": games_played,
            "ppg_rank": ppg_rank,
            "ppg_min_games": ppg_min_games,
            "pos_rank": rank,
            "tag_tier": tier,
            "tag_rank_band": rank_band,
            "tag_base_bid": base_bid,
            "tag_bid": tag_bid,
            "tag_salary": tag_bid,
            "tag_bid_bump_applied": bump_applied,
            "tag_side": tag_side(pos_group),
            "tag_limit_per_side": 1,
            "is_tag_eligible": is_eligible,
            "eligibility_reason": eligibility_reason,
            "tag_prev_season": 1 if was_tagged_prev else 0,
            "tag_prev_season_year": exclude_tag_season if was_tagged_prev else 0,
            "tag_formula": formula,
            "tracking_context": "in-season",
            "scoring_weeks_used": f"1-{last_regular_week}",
        }
        out.append(row)

    out.sort(
        key=lambda r: (
            safe_str(r["franchise_name"]).lower(),
            safe_str(r["positional_grouping"]).lower(),
            safe_int(r["pos_rank"], 99999),
            safe_str(r["player_name"]).lower(),
        )
    )
    return out


def build_meta(
    rows: List[Dict[str, Any]],
    season: int,
    scoring_last_week: int,
    exclude_tag_season: int,
    tracking_for_season: int,
    calc_breakdown: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    by_pos: Dict[str, int] = {}
    for r in rows:
        p = safe_str(r.get("positional_grouping"))
        by_pos[p] = by_pos.get(p, 0) + 1
    return {
        "generated_at": now_local_stamp(),
        "season": season,
        "tracking_for_season": tracking_for_season,
        "count": len(rows),
        "source": "tag-tracking-v1",
        "scoring_weeks_used": f"1-{scoring_last_week}",
        "aav_snapshot_week": 1,
        "by_position": by_pos,
        "exclude_tagged_season": exclude_tag_season,
        "calc_breakdown": calc_breakdown or {},
        "notes": "Tracking uses current season scoring and non-rookie expiring contracts (contract_year=1). Excludes players tagged in the specified prior season.",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--season", type=int, default=0)
    parser.add_argument(
        "--exclude-tagged-season",
        type=int,
        default=0,
        help="Season to exclude players tagged in that year (0 uses automatic logic).",
    )
    parser.add_argument("--out-path", default=str(DEFAULT_OUT_PATH))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    season = args.season if args.season > 0 else default_tracking_season()
    out_path = Path(args.out_path)
    exclude_tag_season = resolve_exclude_tag_season(season, args.exclude_tagged_season)
    tracking_for_season = season + 1 if exclude_tag_season == season else season

    conn = get_conn(args.db_path)
    try:
        last_regular_week = fetch_regular_season_week(conn, season)
        week1_aav_by_pos = fetch_week1_aav_by_pos(conn, season)
        rows = build_rows(conn, season, exclude_tag_season, week1_aav_by_pos)
        calc_breakdown = build_calc_breakdown(week1_aav_by_pos)
    finally:
        conn.close()

    doc = {
        "meta": build_meta(
            rows,
            season,
            last_regular_week,
            exclude_tag_season,
            tracking_for_season,
            calc_breakdown,
        ),
        "rows": rows,
    }
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    print(f"Wrote {out_path}")
    print(f"Season: {season}")
    print(f"Rows: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
