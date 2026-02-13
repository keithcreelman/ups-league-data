#!/usr/bin/env python3
"""
Merge MYM submission history from SQLite table `mym_submissions` into mym_submissions.json.

This preserves existing JSON rows and only appends DB rows that are not already present
by natural key (season + franchise + player + salary + contract_year).
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

from db_utils import DEFAULT_DB_PATH, get_conn


ATTR_RE = re.compile(r'([A-Za-z_]+)="([^"]*)"')


def safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


def pad4(v: Any) -> str:
    digits = re.sub(r"\D", "", str(v or ""))
    return digits.zfill(4)[-4:] if digits else ""


def load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"meta": {}, "submissions": []}
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def parse_xml_attrs(xml_payload: str) -> Dict[str, str]:
    attrs: Dict[str, str] = {}
    if not xml_payload:
        return attrs
    for k, v in ATTR_RE.findall(xml_payload):
        attrs[k] = v
    return attrs


def build_lookup_from_dashboard(dashboard_path: Path) -> Tuple[Dict[str, str], Dict[str, str]]:
    if not dashboard_path.exists():
        return {}, {}
    raw = json.loads(dashboard_path.read_text(encoding="utf-8"))
    all_rows = raw.get("View_MYM_All") or raw.get("eligibility") or []
    player_pos: Dict[str, str] = {}
    team_name: Dict[str, str] = {}
    for r in all_rows:
        pid = str(r.get("player_id") or "")
        pos = str(r.get("positional_grouping") or r.get("position") or "")
        fid = pad4(r.get("franchise_id"))
        fn = str(r.get("franchise_name") or "")
        if pid and pos and pid not in player_pos:
            player_pos[pid] = pos
        if fid and fn and fid not in team_name:
            team_name[fid] = fn
    return player_pos, team_name


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db-path", default=DEFAULT_DB_PATH)
    p.add_argument("--json-path", default="mym_submissions.json")
    p.add_argument("--dashboard-path", default="mym_dashboard.json")
    p.add_argument("--league-id", default="74598")
    args = p.parse_args()

    json_path = Path(args.json_path)
    dashboard_path = Path(args.dashboard_path)
    payload = load_json(json_path)
    existing_rows: List[Dict[str, Any]] = list(payload.get("submissions") or [])

    player_pos, team_name_lookup = build_lookup_from_dashboard(dashboard_path)
    existing_ids = {str(r.get("submission_id") or "").strip() for r in existing_rows}

    conn = get_conn(args.db_path)
    conn.row_factory = None
    db_rows = conn.execute(
        """
        SELECT id, created_at, franchise_id, player_id, player_name, option, tcv, guaranteed,
               per_year, xml_payload, franchise_name
        FROM mym_submissions
        ORDER BY created_at DESC, id DESC
        """
    ).fetchall()
    conn.close()

    inserted = 0
    for (
        row_id,
        created_at,
        franchise_id,
        player_id,
        player_name,
        option,
        _tcv,
        _guaranteed,
        per_year,
        xml_payload,
        franchise_name,
    ) in db_rows:
        attrs = parse_xml_attrs(xml_payload or "")
        season = str(created_at or "")[:4]
        fid = pad4(franchise_id)
        pid = str(player_id or "")
        salary = safe_int(attrs.get("salary"), safe_int(per_year, 0))
        contract_year = safe_int(
            attrs.get("contractYear"),
            3 if str(option or "").lower().strip() == "mym3" else 2,
        )
        contract_info = str(attrs.get("contractInfo") or "").strip()
        raw_status = str(attrs.get("contractStatus") or "Veteran").strip()
        contract_status = f"MYM - {'Rookie' if 'rookie' in raw_status.lower() else 'Vet'}"
        row = {
            "submission_id": f"db-{row_id}",
            "league_id": str(args.league_id),
            "season": season,
            "player_id": pid,
            "player_name": str(player_name or ""),
            "position": player_pos.get(pid, ""),
            "franchise_id": fid,
            "franchise_name": str(franchise_name or team_name_lookup.get(fid, fid)),
            "salary": salary,
            "contract_year": contract_year,
            "contract_status": contract_status,
            "contract_info": contract_info,
            "submitted_at_utc": str(created_at or ""),
            "commish_override_flag": 0,
            "override_as_of_date": "",
            "source": "db-mym-submissions",
        }
        submission_id = str(row.get("submission_id") or "").strip()
        if not season or not fid or not pid or not submission_id:
            continue
        if submission_id in existing_ids:
            continue
        existing_ids.add(submission_id)
        existing_rows.append(row)
        inserted += 1

    existing_rows.sort(
        key=lambda r: (
            str(r.get("submitted_at_utc") or ""),
            str(r.get("submission_id") or ""),
        ),
        reverse=True,
    )
    payload["submissions"] = existing_rows
    payload["meta"] = payload.get("meta") or {}
    payload["meta"]["count"] = len(existing_rows)
    payload["meta"]["source"] = "mym-submission-log+db"
    write_json(json_path, payload)
    print(f"merged_rows={inserted} total_rows={len(existing_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
