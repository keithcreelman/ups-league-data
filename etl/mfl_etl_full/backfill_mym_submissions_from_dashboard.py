#!/usr/bin/env python3
"""
Backfill mym_submissions.json from MYM statuses in mym_dashboard.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def safe_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def normalize_ts(raw: str) -> str:
    s = safe_str(raw)
    if not s:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if "T" in s:
        return s
    # "YYYY-mm-dd HH:MM:SS" -> ISO Z
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        return dt.replace(microsecond=0).isoformat() + "Z"
    except ValueError:
        return s


def submission_id(entry: Dict[str, Any]) -> str:
    raw = "|".join(
        [
            safe_str(entry.get("league_id")),
            safe_str(entry.get("season")),
            safe_str(entry.get("player_id")),
            safe_str(entry.get("contract_year")),
            safe_str(entry.get("contract_status")),
            safe_str(entry.get("contract_info")),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--dashboard-path", default="mym_dashboard.json")
    p.add_argument("--submissions-path", default="mym_submissions.json")
    p.add_argument("--league-id", default="74598")
    p.add_argument(
        "--submitted-at",
        default="",
        help="Optional timestamp for all backfilled rows.",
    )
    p.add_argument(
        "--commish-override-flag",
        type=int,
        default=1,
        help="Set 1 to mark backfilled rows as commish overrides.",
    )
    p.add_argument(
        "--override-as-of-date",
        default="",
        help='Optional display text like "2026-02-04 08:24".',
    )
    return p.parse_args()


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    args = parse_args()

    dashboard_path = Path(args.dashboard_path)
    submissions_path = Path(args.submissions_path)

    dashboard = load_json(dashboard_path, {})
    elig = dashboard.get("eligibility") or []
    meta = dashboard.get("meta") or {}
    generated_at = safe_str(meta.get("generated_at"))
    submitted_at = normalize_ts(args.submitted_at or generated_at)
    override_as_of = safe_str(args.override_as_of_date)

    existing_doc = load_json(submissions_path, {"meta": {}, "submissions": []})
    existing_rows = existing_doc.get("submissions") if isinstance(existing_doc, dict) else []
    if not isinstance(existing_rows, list):
        existing_rows = []

    existing_ids = {safe_str(r.get("submission_id")) for r in existing_rows}
    out_rows: List[Dict[str, Any]] = list(existing_rows)
    added = 0

    for row in elig:
        status = safe_str(row.get("contract_status")).lower()
        if "mym" not in status:
            continue

        entry = {
            "submission_id": "",
            "league_id": safe_str(args.league_id),
            "season": safe_str(row.get("season")),
            "player_id": safe_str(row.get("player_id")),
            "player_name": safe_str(row.get("player_name")),
            "position": safe_str(row.get("positional_grouping") or row.get("position")),
            "franchise_id": safe_str(row.get("franchise_id")),
            "franchise_name": safe_str(row.get("franchise_name")),
            "salary": safe_int(row.get("salary")),
            "contract_year": safe_int(row.get("contract_year")),
            "contract_status": safe_str(row.get("contract_status")),
            "contract_info": safe_str(row.get("contract_info")),
            "submitted_at_utc": submitted_at,
            "commish_override_flag": 1 if safe_int(args.commish_override_flag) else 0,
            "override_as_of_date": override_as_of,
            "source": "backfill-from-dashboard",
        }
        entry["submission_id"] = submission_id(entry)
        if entry["submission_id"] in existing_ids:
            continue
        existing_ids.add(entry["submission_id"])
        out_rows.append(entry)
        added += 1

    out_rows.sort(
        key=lambda r: (
            safe_str(r.get("submitted_at_utc")),
            safe_str(r.get("player_name")).lower(),
        ),
        reverse=True,
    )

    out_doc = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "source": "mym-submission-log",
            "count": len(out_rows),
        },
        "submissions": out_rows,
    }

    submissions_path.write_text(json.dumps(out_doc, indent=2), encoding="utf-8")
    print(f"Added {added} backfilled submissions.")
    print(f"Wrote {submissions_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
