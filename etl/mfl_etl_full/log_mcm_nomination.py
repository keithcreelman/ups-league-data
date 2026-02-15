#!/usr/bin/env python3
"""
Append an MCM nomination record into mcm_nominations.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--json-path", default="mcm_nominations.json")
    p.add_argument("--display-name", default=os.environ.get("DISPLAY_NAME", ""))
    p.add_argument("--genre-id", default=os.environ.get("GENRE_ID", ""))
    p.add_argument("--primary-url", default=os.environ.get("PRIMARY_URL", ""))
    p.add_argument("--image-url", default=os.environ.get("IMAGE_URL", ""))
    p.add_argument("--notes", default=os.environ.get("NOTES", ""))
    p.add_argument("--ip-hash", default=os.environ.get("IP_HASH", ""))
    p.add_argument("--attestation-adult", default=os.environ.get("ATTESTATION_ADULT", "0"))
    p.add_argument("--attestation-respectful", default=os.environ.get("ATTESTATION_RESPECTFUL", "0"))
    p.add_argument("--created-at", default=os.environ.get("CREATED_AT_UTC", ""))
    p.add_argument("--status", default=os.environ.get("STATUS", "approved"))
    p.add_argument("--source", default=os.environ.get("SOURCE", "worker-mcm-nominate"))
    return p.parse_args()


def load_doc(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not path.exists():
        return {"schema_version": "v1", "meta": {}, "nominations": []}, []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        rows = raw.get("nominations") or []
        if not isinstance(rows, list):
            rows = []
        return raw, rows
    return {"schema_version": "v1", "meta": {}, "nominations": []}, []


def build_nomination_id(entry: Dict[str, Any]) -> str:
    raw = "|".join(
        [
            safe_str(entry.get("display_name")).lower(),
            safe_str(entry.get("genre_id")).lower(),
            safe_str(entry.get("primary_url")).lower(),
            safe_str(entry.get("ip_hash")),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:18]


def sort_key(item: Dict[str, Any]) -> Tuple[int, str]:
    ts = safe_str(item.get("created_at_utc"))
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        val = int(dt.timestamp())
    except ValueError:
        val = 0
    return (-val, safe_str(item.get("nomination_id")))


def main() -> int:
    args = parse_args()

    display_name = safe_str(args.display_name)
    genre_id = safe_str(args.genre_id)
    primary_url = safe_str(args.primary_url)
    image_url = safe_str(args.image_url)
    notes = safe_str(args.notes)
    ip_hash = safe_str(args.ip_hash)
    created_at = safe_str(args.created_at) or utc_now_iso()

    att_adult = 1 if safe_int(args.attestation_adult, 0) else 0
    att_respectful = 1 if safe_int(args.attestation_respectful, 0) else 0

    if len(display_name) < 2:
        raise RuntimeError("display_name required")
    if not genre_id:
        raise RuntimeError("genre_id required")
    if not primary_url:
        raise RuntimeError("primary_url required")
    if not ip_hash:
        raise RuntimeError("ip_hash required")
    if not att_adult or not att_respectful:
        raise RuntimeError("attestations required")

    status = safe_str(args.status) or "approved"
    if status not in ("pending", "approved", "rejected"):
        status = "pending"

    entry: Dict[str, Any] = {
        "nomination_id": "",
        "display_name": display_name,
        "genre_id": genre_id,
        "primary_url": primary_url,
        "image_url": image_url,
        "notes": notes,
        "ip_hash": ip_hash,
        "attestation_adult": att_adult,
        "attestation_respectful": att_respectful,
        "created_at_utc": created_at,
        "status": status,
        "source": safe_str(args.source) or "worker-mcm-nominate",
    }
    entry["nomination_id"] = build_nomination_id(entry)

    json_path = Path(args.json_path)
    doc, nominations = load_doc(json_path)
    existing = {safe_str(n.get("nomination_id")) for n in nominations}
    if entry["nomination_id"] in existing:
        print(f"Nomination already logged: {entry['nomination_id']}")
        return 0

    nominations.append(entry)
    nominations.sort(key=sort_key)
    doc["nominations"] = nominations
    doc["schema_version"] = "v1"
    doc["meta"] = {"generated_at_utc": utc_now_iso(), "count": len(nominations)}
    json_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"Logged MCM nomination: {display_name}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

