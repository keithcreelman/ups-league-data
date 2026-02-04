#!/usr/bin/env python3
"""
Refresh mym_dashboard.json directly from MFL export data (no on-prem ETL run).

This script:
1) Reads the current mym_dashboard.json as a base.
2) Pulls live salaries/contracts from MFL (TYPE=salaries).
3) Updates contract fields in eligibility rows.
4) Marks players with MYM contract status as not eligible.
5) Recomputes MYM usage counts by franchise for the target season.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def default_year(today: date | None = None) -> int:
    d = today or date.today()
    # League year flips on March 1: before that, use prior year.
    return d.year if d >= date(d.year, 3, 1) else d.year - 1


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def pad4(fid: Any) -> str:
    digits = "".join(ch for ch in str(fid or "") if ch.isdigit())
    if not digits:
        return ""
    return digits.zfill(4)[-4:]


def normalize_cookie(raw_cookie: str) -> str:
    c = str(raw_cookie or "").strip()
    if not c:
        return ""
    return c if "=" in c else f"MFL_USER_ID={c}"


def fetch_json(url: str, cookie_header: str) -> Dict[str, Any]:
    req = Request(
        url,
        headers={
            "Cookie": cookie_header,
            "User-Agent": "ups-league-data-refresh-bot",
        },
    )
    with urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


def extract_salaries_map(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    salaries = payload.get("salaries") or {}
    league_unit = salaries.get("leagueUnit") or salaries.get("leagueunit") or {}
    players_raw = league_unit.get("player") or []
    if isinstance(players_raw, dict):
        players = [players_raw]
    elif isinstance(players_raw, list):
        players = players_raw
    else:
        players = []

    out: Dict[str, Dict[str, Any]] = {}
    for p in players:
        pid = str(p.get("id") or "").strip()
        if not pid:
            continue
        out[pid] = {
            "salary": safe_int(p.get("salary"), 0),
            "contractYear": safe_int(p.get("contractYear"), 0),
            "contractStatus": str(p.get("contractStatus") or "").strip(),
            "contractInfo": str(p.get("contractInfo") or "").strip(),
        }
    return out


def is_mym_status(status_value: Any) -> bool:
    return "mym" in str(status_value or "").strip().lower()


def update_eligibility_rows(
    eligibility: List[Dict[str, Any]],
    salary_map: Dict[str, Dict[str, Any]],
) -> Tuple[int, int]:
    changed_rows = 0
    mym_marked = 0

    for row in eligibility:
        pid = str(row.get("player_id") or "").strip()
        if not pid:
            continue
        src = salary_map.get(pid)
        if not src:
            continue

        changed = False

        if src["salary"] and safe_int(row.get("salary"), -1) != src["salary"]:
            row["salary"] = src["salary"]
            changed = True

        if src["contractYear"] and safe_int(row.get("contract_year"), -1) != src["contractYear"]:
            row["contract_year"] = src["contractYear"]
            changed = True

        if src["contractStatus"] and str(row.get("contract_status") or "") != src["contractStatus"]:
            row["contract_status"] = src["contractStatus"]
            changed = True

        if src["contractInfo"] and str(row.get("contract_info") or "") != src["contractInfo"]:
            row["contract_info"] = src["contractInfo"]
            changed = True

        if is_mym_status(row.get("contract_status")) and safe_int(row.get("eligible_flag"), 0) != 0:
            row["eligible_flag"] = 0
            row["rule_explanation"] = "Not eligible. MYM contract already submitted."
            changed = True
            mym_marked += 1

        if changed:
            changed_rows += 1

    return changed_rows, mym_marked


def rebuild_usage_rows(
    eligibility: List[Dict[str, Any]],
    usage_rows: List[Dict[str, Any]],
    season: int,
) -> int:
    season_str = str(season)
    team_name_by_fid: Dict[str, str] = {}
    mym_count: Dict[str, int] = {}

    for row in eligibility:
        if str(row.get("season")) != season_str:
            continue
        fid = pad4(row.get("franchise_id"))
        if not fid:
            continue
        if row.get("franchise_name"):
            team_name_by_fid[fid] = str(row.get("franchise_name"))
        if is_mym_status(row.get("contract_status")):
            mym_count[fid] = mym_count.get(fid, 0) + 1

    changed = 0
    usage_index = {
        (str(u.get("season")), pad4(u.get("franchise_id"))): u
        for u in usage_rows
    }

    for fid, used in mym_count.items():
        key = (season_str, fid)
        row = usage_index.get(key)
        if row is None:
            usage_rows.append(
                {
                    "season": season,
                    "franchise_id": fid,
                    "team_name": team_name_by_fid.get(fid, fid),
                    "mym_used": used,
                    "mym_remaining": max(0, 5 - used),
                }
            )
            changed += 1
            continue

        new_remaining = max(0, 5 - used)
        if safe_int(row.get("mym_used"), -1) != used:
            row["mym_used"] = used
            changed += 1
        if safe_int(row.get("mym_remaining"), -1) != new_remaining:
            row["mym_remaining"] = new_remaining
            changed += 1

    usage_rows.sort(
        key=lambda u: (
            -safe_int(u.get("season"), 0),
            str(u.get("team_name") or ""),
        )
    )
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-path", default="mym_dashboard.json")
    parser.add_argument("--league-id", default=os.environ.get("MFL_LEAGUE_ID", "74598"))
    year_env = (os.environ.get("MFL_YEAR") or "").strip()
    default_target_year = safe_int(year_env, default_year()) if year_env else default_year()
    parser.add_argument("--year", type=int, default=default_target_year)
    parser.add_argument("--cookie", default=os.environ.get("MFL_COOKIE", ""))
    args = parser.parse_args()

    cookie = normalize_cookie(args.cookie)
    if not cookie:
        raise RuntimeError("Missing MFL cookie. Set MFL_COOKIE in environment/secrets.")

    json_path = Path(args.json_path)
    if not json_path.exists():
        raise FileNotFoundError(f"JSON file not found: {json_path}")

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    eligibility = payload.get("eligibility") or []
    usage = payload.get("usage") or []
    if not isinstance(eligibility, list) or not isinstance(usage, list):
        raise RuntimeError("Unexpected mym_dashboard.json format")

    params = {
        "TYPE": "salaries",
        "L": str(args.league_id),
        "JSON": "1",
        "_": str(int(datetime.now().timestamp() * 1000)),
    }
    salaries_url = f"https://api.myfantasyleague.com/{args.year}/export?{urlencode(params)}"
    salaries_payload = fetch_json(salaries_url, cookie)
    salary_map = extract_salaries_map(salaries_payload)

    changed_rows, mym_marked = update_eligibility_rows(eligibility, salary_map)
    usage_changed = rebuild_usage_rows(eligibility, usage, args.year)

    total_changes = changed_rows + usage_changed
    if total_changes == 0:
        print("No MYM JSON changes detected.")
        return 0

    meta = payload.get("meta") or {}
    meta["generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    meta["source"] = "github-mfl-refresh"
    payload["meta"] = meta
    payload["eligibility"] = eligibility
    payload["usage"] = usage

    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"Updated {changed_rows} eligibility rows.")
    print(f"Marked {mym_marked} rows as MYM-ineligible.")
    print(f"Updated/added {usage_changed} usage rows.")
    print(f"Wrote {json_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
