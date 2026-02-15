#!/usr/bin/env python3
"""
Append an MCM vote record into mcm_votes.json.
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


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--json-path", default="mcm_votes.json")
    p.add_argument("--season-year", default=os.environ.get("SEASON_YEAR", "0"))
    p.add_argument("--week-no", default=os.environ.get("WEEK_NO", "0"))
    p.add_argument("--matchup-key", default=os.environ.get("MATCHUP_KEY", "regular"))
    p.add_argument("--nominee-id", default=os.environ.get("NOMINEE_ID", ""))
    p.add_argument("--ip-hash", default=os.environ.get("IP_HASH", ""))
    p.add_argument("--submitted-at", default=os.environ.get("SUBMITTED_AT_UTC", ""))
    p.add_argument("--source", default=os.environ.get("SOURCE", "worker-mcm-vote"))
    return p.parse_args()


def load_doc(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not path.exists():
        return {"schema_version": "v1", "meta": {}, "votes": []}, []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        votes = raw.get("votes") or []
        if not isinstance(votes, list):
            votes = []
        return raw, votes
    return {"schema_version": "v1", "meta": {}, "votes": []}, []


def build_vote_id(entry: Dict[str, Any]) -> str:
    raw = "|".join(
        [
            safe_str(entry.get("season_year")),
            safe_str(entry.get("week_no")),
            safe_str(entry.get("matchup_key")),
            safe_str(entry.get("ip_hash")),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:18]


def sort_key(item: Dict[str, Any]) -> Tuple[int, str]:
    ts = safe_str(item.get("submitted_at_utc"))
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        val = int(dt.timestamp())
    except ValueError:
        val = 0
    return (-val, safe_str(item.get("vote_id")))


def main() -> int:
    args = parse_args()

    season_year = safe_int(args.season_year, 0)
    week_no = safe_int(args.week_no, 0)
    matchup_key = safe_str(args.matchup_key) or "regular"
    nominee_id = safe_str(args.nominee_id)
    ip_hash = safe_str(args.ip_hash)
    submitted_at = safe_str(args.submitted_at) or utc_now_iso()

    if season_year <= 0 or week_no <= 0:
        raise RuntimeError("Missing required fields: season_year/week_no")
    if not nominee_id:
        raise RuntimeError("Missing required field: nominee_id")
    if not ip_hash:
        raise RuntimeError("Missing required field: ip_hash")
    if len(matchup_key) > 40:
        raise RuntimeError("matchup_key too long")

    entry: Dict[str, Any] = {
        "vote_id": "",
        "season_year": season_year,
        "week_no": week_no,
        "matchup_key": matchup_key,
        "nominee_id": nominee_id,
        "ip_hash": ip_hash,
        "submitted_at_utc": submitted_at,
        "source": safe_str(args.source) or "worker-mcm-vote",
    }
    entry["vote_id"] = build_vote_id(entry)

    json_path = Path(args.json_path)
    doc, votes = load_doc(json_path)

    existing_ids = {safe_str(v.get("vote_id")) for v in votes}
    if entry["vote_id"] in existing_ids:
        print(f"Vote already logged: {entry['vote_id']}")
        return 0

    votes.append(entry)
    votes.sort(key=sort_key)
    doc["votes"] = votes
    doc["schema_version"] = "v1"
    doc["meta"] = {"generated_at_utc": utc_now_iso(), "count": len(votes)}
    json_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"Logged MCM vote for nominee {nominee_id}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

