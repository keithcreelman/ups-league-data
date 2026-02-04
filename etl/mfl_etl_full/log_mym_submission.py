#!/usr/bin/env python3
"""
Append a MYM submission record into mym_submissions.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-path", default="mym_submissions.json")
    parser.add_argument("--league-id", default=os.environ.get("LEAGUE_ID", ""))
    parser.add_argument("--season", default=os.environ.get("SEASON", ""))
    parser.add_argument("--year", default=os.environ.get("YEAR", ""))
    parser.add_argument("--player-id", default=os.environ.get("PLAYER_ID", ""))
    parser.add_argument("--player-name", default=os.environ.get("PLAYER_NAME", ""))
    parser.add_argument("--position", default=os.environ.get("POSITION", ""))
    parser.add_argument("--franchise-id", default=os.environ.get("FRANCHISE_ID", ""))
    parser.add_argument("--franchise-name", default=os.environ.get("FRANCHISE_NAME", ""))
    parser.add_argument("--salary", default=os.environ.get("SALARY", "0"))
    parser.add_argument("--contract-year", default=os.environ.get("CONTRACT_YEAR", "0"))
    parser.add_argument("--contract-status", default=os.environ.get("CONTRACT_STATUS", ""))
    parser.add_argument("--contract-info", default=os.environ.get("CONTRACT_INFO", ""))
    parser.add_argument("--submitted-at", default=os.environ.get("SUBMITTED_AT_UTC", ""))
    parser.add_argument(
        "--commish-override-flag",
        default=os.environ.get("COMMISH_OVERRIDE_FLAG", "0"),
    )
    parser.add_argument(
        "--override-as-of-date",
        default=os.environ.get("OVERRIDE_AS_OF_DATE", ""),
    )
    parser.add_argument("--source", default=os.environ.get("SOURCE", "worker-offer-mym"))
    parser.add_argument(
        "--submission-id",
        default=os.environ.get("SUBMISSION_ID", ""),
        help="Optional stable id. If omitted, one is derived from payload fields.",
    )
    return parser.parse_args()


def load_doc(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not path.exists():
        return {"meta": {}, "submissions": []}, []

    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return {"meta": {}, "submissions": raw}, raw

    if isinstance(raw, dict):
        subs = raw.get("submissions") or raw.get("rows") or []
        if not isinstance(subs, list):
            subs = []
        return raw, subs

    return {"meta": {}, "submissions": []}, []


def normalize_timestamp(raw_ts: str) -> str:
    ts = safe_str(raw_ts)
    if not ts:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return ts


def build_submission_id(entry: Dict[str, Any]) -> str:
    raw = "|".join(
        [
            safe_str(entry.get("league_id")),
            safe_str(entry.get("season")),
            safe_str(entry.get("player_id")),
            safe_str(entry.get("contract_year")),
            safe_str(entry.get("contract_status")),
            safe_str(entry.get("contract_info")),
            safe_str(entry.get("submitted_at_utc")),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def sort_key(item: Dict[str, Any]) -> Tuple[int, str]:
    ts = safe_str(item.get("submitted_at_utc") or item.get("submitted_at"))
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        val = int(dt.timestamp())
    except ValueError:
        val = 0
    return (-val, safe_str(item.get("player_name")).lower())


def main() -> int:
    args = parse_args()

    season = safe_str(args.season) or safe_str(args.year)
    submitted_at = normalize_timestamp(args.submitted_at)

    required = {
        "league_id": safe_str(args.league_id),
        "season": season,
        "player_id": safe_str(args.player_id),
        "contract_year": safe_int(args.contract_year, 0),
        "contract_status": safe_str(args.contract_status),
    }
    missing = [k for k, v in required.items() if v in ("", 0)]
    if missing:
        raise RuntimeError(f"Missing required submission fields: {', '.join(missing)}")

    entry: Dict[str, Any] = {
        "submission_id": safe_str(args.submission_id),
        "league_id": required["league_id"],
        "season": required["season"],
        "player_id": required["player_id"],
        "player_name": safe_str(args.player_name),
        "position": safe_str(args.position),
        "franchise_id": safe_str(args.franchise_id),
        "franchise_name": safe_str(args.franchise_name),
        "salary": safe_int(args.salary, 0),
        "contract_year": required["contract_year"],
        "contract_status": required["contract_status"],
        "contract_info": safe_str(args.contract_info),
        "submitted_at_utc": submitted_at,
        "commish_override_flag": 1 if safe_int(args.commish_override_flag, 0) else 0,
        "override_as_of_date": safe_str(args.override_as_of_date),
        "source": safe_str(args.source) or "worker-offer-mym",
    }
    if not entry["submission_id"]:
        entry["submission_id"] = build_submission_id(entry)

    json_path = Path(args.json_path)
    doc, submissions = load_doc(json_path)

    existing_ids = {safe_str(x.get("submission_id")) for x in submissions}
    if entry["submission_id"] in existing_ids:
        print(f"Submission already logged: {entry['submission_id']}")
        return 0

    submissions.append(entry)
    submissions.sort(key=sort_key)

    doc["submissions"] = submissions
    doc["meta"] = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "source": "mym-submission-log",
        "count": len(submissions),
    }

    json_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"Logged MYM submission for player {entry['player_id']} ({entry['player_name']}).")
    print(f"Wrote {json_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
