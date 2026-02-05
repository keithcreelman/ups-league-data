#!/usr/bin/env python3
"""
Build in-season tag tracking JSON.

Tag tracking (current season):
- Candidates are players on active rosters with contract_year = 1.
- Ranking source is player_pointssummary.pos_rank for the same season.
- Tag tier is determined by positional rank ranges.
- Tag salary is determined by tier formula:
  - Most positions: average AAV of players in the tier's rank band.
  - Kickers (PK): prior season salary + 1,000 (tracked as current salary + 1,000 in-season).
"""

from __future__ import annotations

import argparse
import json
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
        if g in {"K", "PK"}:
            return "PK"
        return g
    if p in {"CB", "S", "DB"}:
        return "DB"
    if p in {"DE", "DT", "DL"}:
        return "DL"
    if p in {"K", "PK"}:
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
        TierRule(1, 1, 3, 1, 3, "Avg Top 1-3 QB AAV"),
        TierRule(2, 4, 6, 4, 6, "Avg Top 4-6 QB AAV"),
        TierRule(3, 7, None, 7, 12, "Avg Top 7-12 QB AAV"),
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


def fetch_candidates(conn, season: int) -> List[Dict[str, Any]]:
    sql = """
    SELECT
      rc.season,
      rc.franchise_id,
      COALESCE(rc.team_name, '') AS franchise_name,
      rc.player_id,
      COALESCE(rc.player_name, '') AS player_name,
      COALESCE(rc.position, '') AS position,
      COALESCE(pps.positional_grouping, '') AS positional_grouping,
      COALESCE(pps.pos_rank, 0) AS pos_rank,
      COALESCE(pps.points_total, 0) AS points_total,
      COALESCE(rc.salary, 0) AS salary,
      COALESCE(rc.aav, 0) AS aav_db,
      COALESCE(rc.contract_year, 0) AS contract_year,
      COALESCE(rc.contract_status, '') AS contract_status,
      COALESCE(rc.contract_info, '') AS contract_info,
      COALESCE(rc.status, '') AS roster_status
    FROM rosters_current rc
    LEFT JOIN player_pointssummary pps
      ON pps.season = rc.season
     AND CAST(pps.player_id AS TEXT) = CAST(rc.player_id AS TEXT)
    WHERE rc.season = ?
      AND rc.contract_year = 1
      AND rc.status IN ('ROSTER', 'INJURED_RESERVE')
    """
    rows = []
    for r in conn.execute(sql, (season,)).fetchall():
        rows.append(
            {
                "season": safe_int(r[0], season),
                "franchise_id": safe_str(r[1]).zfill(4)[-4:],
                "franchise_name": safe_str(r[2]),
                "player_id": safe_str(r[3]),
                "player_name": safe_str(r[4]),
                "position": safe_str(r[5]),
                "positional_grouping": normalize_pos_group(r[5], r[6]),
                "pos_rank": safe_int(r[7], 0),
                "points_total": float(r[8] or 0),
                "salary": safe_int(r[9], 0),
                "aav_db": safe_int(r[10], 0),
                "contract_year": safe_int(r[11], 0),
                "contract_status": safe_str(r[12]),
                "contract_info": safe_str(r[13]),
                "roster_status": safe_str(r[14]),
            }
        )
    for row in rows:
        row["aav"] = effective_aav(row["aav_db"], row["salary"], row["contract_info"])
    return rows


def fetch_aav_rank_rows(conn, season: int) -> Dict[str, List[Tuple[int, int]]]:
    sql = """
    SELECT
      COALESCE(pps.positional_grouping, '') AS positional_grouping,
      COALESCE(rc.position, '') AS position,
      COALESCE(pps.pos_rank, 0) AS pos_rank,
      COALESCE(rc.salary, 0) AS salary,
      COALESCE(rc.aav, 0) AS aav_db,
      COALESCE(rc.contract_info, '') AS contract_info
    FROM rosters_current rc
    LEFT JOIN player_pointssummary pps
      ON pps.season = rc.season
     AND CAST(pps.player_id AS TEXT) = CAST(rc.player_id AS TEXT)
    WHERE rc.season = ?
      AND rc.status IN ('ROSTER', 'INJURED_RESERVE')
      AND COALESCE(pps.pos_rank, 0) > 0
    """
    out: Dict[str, List[Tuple[int, int]]] = {}
    for row in conn.execute(sql, (season,)).fetchall():
        pos = normalize_pos_group(row[1], row[0])
        rank = safe_int(row[2], 0)
        salary = safe_int(row[3], 0)
        aav_db = safe_int(row[4], 0)
        info = safe_str(row[5])
        aav = effective_aav(aav_db, salary, info)
        if rank > 0 and aav > 0:
            out.setdefault(pos, []).append((rank, aav))
    for pos in out:
        out[pos].sort(key=lambda x: x[0])
    return out


def avg_aav_for_rank_band(
    aav_rank_rows: Dict[str, List[Tuple[int, int]]], pos_group: str, rank_min: int, rank_max: int
) -> int:
    rows = aav_rank_rows.get(pos_group, [])
    vals = [aav for rank, aav in rows if rank >= rank_min and rank <= rank_max and aav > 0]
    if not vals:
        return 0
    avg = sum(vals) / len(vals)
    rounded = int(round(avg / 1000.0) * 1000)
    return max(1000, rounded)


def build_rows(conn, season: int) -> List[Dict[str, Any]]:
    league_id = fetch_league_id(conn, season)
    candidates = fetch_candidates(conn, season)
    aav_rank_rows = fetch_aav_rank_rows(conn, season)

    out = []
    for c in candidates:
        pos_group = safe_str(c["positional_grouping"]).upper()
        if pos_group not in TAG_RULES:
            continue
        rank = safe_int(c["pos_rank"], 0)
        rule = lookup_tier_rule(pos_group, rank)

        tier = safe_int(rule.tier, 0) if rule else 0
        rank_band = ""
        tag_salary = 0
        formula = ""

        if rule:
            if rule.rank_max is None:
                rank_band = f"{rule.rank_min}+"
            else:
                rank_band = f"{rule.rank_min}-{rule.rank_max}"

            if pos_group == "PK":
                tag_salary = max(1000, safe_int(c["salary"], 0) + 1000)
                formula = "Prior salary + 1,000"
            elif rule.avg_rank_min is not None and rule.avg_rank_max is not None:
                tag_salary = avg_aav_for_rank_band(
                    aav_rank_rows,
                    pos_group,
                    rule.avg_rank_min,
                    rule.avg_rank_max,
                )
                formula = rule.rule_label

        if tag_salary <= 0:
            # Fallback for unranked/unmapped rows.
            tag_salary = max(1000, safe_int(c["aav"], 0))
            if not formula:
                formula = "Fallback: current AAV"

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
            "contract_year": c["contract_year"],
            "contract_status": c["contract_status"],
            "contract_info": c["contract_info"],
            "points_total": c["points_total"],
            "pos_rank": rank,
            "tag_tier": tier,
            "tag_rank_band": rank_band,
            "tag_salary": tag_salary,
            "tag_formula": formula,
            "tracking_context": "in-season",
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


def build_meta(rows: List[Dict[str, Any]], season: int) -> Dict[str, Any]:
    by_pos: Dict[str, int] = {}
    for r in rows:
        p = safe_str(r.get("positional_grouping"))
        by_pos[p] = by_pos.get(p, 0) + 1
    return {
        "generated_at": now_local_stamp(),
        "season": season,
        "count": len(rows),
        "source": "tag-tracking-v1",
        "by_position": by_pos,
        "notes": "Tracking uses current season scoring/rank and expiring contracts (contract_year=1).",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--season", type=int, default=0)
    parser.add_argument("--out-path", default=str(DEFAULT_OUT_PATH))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    season = args.season if args.season > 0 else default_tracking_season()
    out_path = Path(args.out_path)

    conn = get_conn(args.db_path)
    try:
        rows = build_rows(conn, season)
    finally:
        conn.close()

    doc = {"meta": build_meta(rows, season), "rows": rows}
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    print(f"Wrote {out_path}")
    print(f"Season: {season}")
    print(f"Rows: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
