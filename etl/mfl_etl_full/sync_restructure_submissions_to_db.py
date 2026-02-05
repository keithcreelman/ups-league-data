#!/usr/bin/env python3
"""
Sync restructure submissions into SQLite.

Sources:
1) restructure_submissions.json (worker/log-driven submissions)
2) Historical inference from rosters_weekly rows that include "restruct" in contract_info
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

from db_utils import DEFAULT_DB_PATH, get_conn


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_JSON_PATH = ROOT_DIR / "restructure_submissions.json"


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_money_token(token: str) -> int:
    """
    Convert tokens like 3K, 11.2K, 1000 into integer dollars.
    """
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


def parse_contract_info(contract_info: str) -> Dict[str, int]:
    txt = safe_str(contract_info)
    out = {"tcv": 0, "aav": 0, "guaranteed": 0}
    if not txt:
        return out

    m_tcv = re.search(r"\bTCV\s+([0-9]+(?:\.[0-9]+)?K?)", txt, re.IGNORECASE)
    m_aav = re.search(r"\bAAV\s+([0-9]+(?:\.[0-9]+)?K?)", txt, re.IGNORECASE)
    m_gtd = re.search(r"\bGTD\s*:\s*([0-9]+(?:\.[0-9]+)?K?)", txt, re.IGNORECASE)

    if m_tcv:
        out["tcv"] = parse_money_token(m_tcv.group(1))
    if m_aav:
        out["aav"] = parse_money_token(m_aav.group(1))
    if m_gtd:
        out["guaranteed"] = parse_money_token(m_gtd.group(1))

    return out


def build_submission_id(payload: Dict[str, Any]) -> str:
    raw = "|".join(
        [
            safe_str(payload.get("league_id")),
            safe_str(payload.get("season")),
            safe_str(payload.get("franchise_id")),
            safe_str(payload.get("player_id")),
            safe_str(payload.get("contract_year")),
            safe_str(payload.get("contract_status")),
            safe_str(payload.get("contract_info")),
            safe_str(payload.get("submitted_at_utc")),
            safe_str(payload.get("source")),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def get_league_id_for_season(conn: sqlite3.Connection, season: str) -> str:
    s_int = safe_int(season, 0)
    if s_int <= 0:
        return ""
    row = conn.execute(
        "SELECT league_id FROM league_years WHERE season = ? LIMIT 1",
        (s_int,),
    ).fetchone()
    return safe_str(row[0]) if row else ""


def load_json_rows(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []

    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    if isinstance(raw, dict):
        rows = raw.get("submissions") or raw.get("rows") or []
        return [x for x in rows if isinstance(x, dict)]
    return []


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS restructure_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            submission_id TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            source TEXT,
            league_id TEXT,
            season TEXT,
            franchise_id TEXT,
            franchise_name TEXT,
            franchise_logo TEXT,
            player_id TEXT,
            player_name TEXT,
            position TEXT,
            salary INTEGER,
            contract_year INTEGER,
            contract_status TEXT,
            contract_info TEXT,
            tcv INTEGER,
            aav INTEGER,
            guaranteed INTEGER,
            submitted_at_utc TEXT,
            commish_override_flag INTEGER DEFAULT 0,
            override_as_of_date TEXT,
            commentary TEXT,
            xml_payload TEXT,
            inferred_flag INTEGER DEFAULT 0,
            inferred_from_season INTEGER,
            inferred_from_week INTEGER,
            inference_note TEXT
        );
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_restructure_submissions_season ON restructure_submissions(season)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_restructure_submissions_player ON restructure_submissions(player_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_restructure_submissions_team ON restructure_submissions(franchise_id)"
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(restructure_submissions)")}
    if "commentary" not in cols:
        conn.execute("ALTER TABLE restructure_submissions ADD COLUMN commentary TEXT")


def normalize_json_row(conn: sqlite3.Connection, row: Dict[str, Any]) -> Dict[str, Any]:
    season = safe_str(row.get("season") or row.get("year"))
    league_id = safe_str(row.get("league_id") or row.get("leagueId"))
    if not league_id:
        league_id = get_league_id_for_season(conn, season)

    contract_info = safe_str(row.get("contract_info"))
    parsed = parse_contract_info(contract_info)

    norm: Dict[str, Any] = {
        "submission_id": safe_str(row.get("submission_id")),
        "source": safe_str(row.get("source") or "worker-offer-restructure"),
        "league_id": league_id,
        "season": season,
        "franchise_id": safe_str(row.get("franchise_id")).zfill(4)[-4:],
        "franchise_name": safe_str(row.get("franchise_name")),
        "franchise_logo": safe_str(row.get("franchise_logo")),
        "player_id": safe_str(row.get("player_id")),
        "player_name": safe_str(row.get("player_name")),
        "position": safe_str(row.get("position")),
        "salary": safe_int(row.get("salary"), 0),
        "contract_year": safe_int(row.get("contract_year"), 0),
        "contract_status": safe_str(row.get("contract_status")),
        "contract_info": contract_info,
        "tcv": safe_int(row.get("tcv"), parsed["tcv"]),
        "aav": safe_int(row.get("aav"), parsed["aav"]),
        "guaranteed": safe_int(row.get("guaranteed"), parsed["guaranteed"]),
        "submitted_at_utc": safe_str(row.get("submitted_at_utc") or row.get("submitted_at")),
        "commish_override_flag": 1 if safe_int(row.get("commish_override_flag"), 0) else 0,
        "override_as_of_date": safe_str(row.get("override_as_of_date")),
        "commentary": safe_str(row.get("commentary") or row.get("notes")),
        "xml_payload": safe_str(row.get("xml_payload")),
        "inferred_flag": 0,
        "inferred_from_season": None,
        "inferred_from_week": None,
        "inference_note": "",
    }
    if not norm["submitted_at_utc"]:
        norm["submitted_at_utc"] = now_utc_iso()
    if not norm["submission_id"]:
        norm["submission_id"] = build_submission_id(norm)
    return norm


def infer_historical_rows(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    sql = """
    SELECT
      rw.season,
      MIN(rw.week) AS first_week,
      rw.franchise_id,
      COALESCE(MAX(rw.team_name), '') AS franchise_name,
      rw.player_id,
      COALESCE(MAX(rw.player_name), '') AS player_name,
      COALESCE(MAX(rw.position), '') AS position,
      COALESCE(MAX(rw.salary), 0) AS salary,
      COALESCE(MAX(rw.contract_year), 0) AS contract_year,
      COALESCE(MAX(rw.contract_status), '') AS contract_status,
      rw.contract_info
    FROM rosters_weekly rw
    WHERE lower(COALESCE(rw.contract_info, '')) LIKE '%restruct%'
    GROUP BY rw.season, rw.franchise_id, rw.player_id, rw.contract_info
    ORDER BY rw.season, first_week, rw.player_name
    """
    out: List[Dict[str, Any]] = []
    for row in conn.execute(sql).fetchall():
        season = safe_str(row["season"])
        contract_info = safe_str(row["contract_info"])
        parsed = parse_contract_info(contract_info)
        norm: Dict[str, Any] = {
            "submission_id": "",
            "source": "inferred-rosters-weekly",
            "league_id": get_league_id_for_season(conn, season),
            "season": season,
            "franchise_id": safe_str(row["franchise_id"]).zfill(4)[-4:],
            "franchise_name": safe_str(row["franchise_name"]),
            "franchise_logo": "",
            "player_id": safe_str(row["player_id"]),
            "player_name": safe_str(row["player_name"]),
            "position": safe_str(row["position"]),
            "salary": safe_int(row["salary"], 0),
            "contract_year": safe_int(row["contract_year"], 0),
            "contract_status": safe_str(row["contract_status"]),
            "contract_info": contract_info,
            "tcv": parsed["tcv"],
            "aav": parsed["aav"],
            "guaranteed": parsed["guaranteed"],
            "submitted_at_utc": "",
            "commish_override_flag": 0,
            "override_as_of_date": "",
            "commentary": f"Contract history note: {contract_info}",
            "xml_payload": "",
            "inferred_flag": 1,
            "inferred_from_season": safe_int(row["season"], 0),
            "inferred_from_week": safe_int(row["first_week"], 0),
            "inference_note": "Inferred from rosters_weekly contract_info containing 'restruct'.",
        }
        norm["submission_id"] = build_submission_id(norm)
        out.append(norm)
    return out


def infer_trade_comment_rows(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    sql = """
    SELECT
      t.season,
      t.transactionid,
      t.franchise_id,
      COALESCE(t.franchise_name, '') AS franchise_name,
      t.player_id,
      COALESCE(t.player_name, '') AS player_name,
      COALESCE(MAX(t.datetime_et), '') AS datetime_et,
      COALESCE(MAX(t.comments), '') AS comments,
      COALESCE(MAX(t.raw_json), '') AS raw_json
    FROM transactions_trades t
    WHERE lower(COALESCE(t.raw_json, '')) LIKE '%restruct%'
      AND COALESCE(t.player_id, '') <> ''
      AND COALESCE(t.comments, '') <> ''
    GROUP BY t.season, t.transactionid, t.franchise_id, t.player_id
    ORDER BY t.season, datetime_et, t.transactionid
    """
    out: List[Dict[str, Any]] = []
    for row in conn.execute(sql).fetchall():
        season = safe_str(row["season"])
        league_id = get_league_id_for_season(conn, season)
        comment = safe_str(row["comments"])
        tx_id = safe_str(row["transactionid"])
        dt_txt = safe_str(row["datetime_et"])

        norm: Dict[str, Any] = {
            "submission_id": "",
            "source": "inferred-trade-comment",
            "league_id": league_id,
            "season": season,
            "franchise_id": safe_str(row["franchise_id"]).zfill(4)[-4:],
            "franchise_name": safe_str(row["franchise_name"]),
            "franchise_logo": "",
            "player_id": safe_str(row["player_id"]),
            "player_name": safe_str(row["player_name"]),
            "position": "",
            "salary": 0,
            "contract_year": 0,
            "contract_status": "",
            "contract_info": "",
            "tcv": 0,
            "aav": 0,
            "guaranteed": 0,
            "submitted_at_utc": dt_txt or now_utc_iso(),
            "commish_override_flag": 0,
            "override_as_of_date": "",
            "commentary": f"[{tx_id}] {comment}",
            "xml_payload": "",
            "inferred_flag": 1,
            "inferred_from_season": safe_int(row["season"], 0),
            "inferred_from_week": None,
            "inference_note": "Inferred from transactions_trades comment containing 'restruct'.",
        }
        norm["submission_id"] = build_submission_id(norm)
        out.append(norm)
    return out


def dedupe_by_submission_id(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        sid = safe_str(row.get("submission_id"))
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(row)
    return out


def upsert_rows(conn: sqlite3.Connection, rows: Iterable[Dict[str, Any]]) -> tuple[int, int]:
    inserted = 0
    updated = 0
    sql = """
    INSERT INTO restructure_submissions (
      submission_id, source, league_id, season, franchise_id, franchise_name, franchise_logo,
      player_id, player_name, position, salary, contract_year, contract_status, contract_info,
      tcv, aav, guaranteed, submitted_at_utc, commish_override_flag, override_as_of_date, commentary,
      xml_payload, inferred_flag, inferred_from_season, inferred_from_week, inference_note
    ) VALUES (
      :submission_id, :source, :league_id, :season, :franchise_id, :franchise_name, :franchise_logo,
      :player_id, :player_name, :position, :salary, :contract_year, :contract_status, :contract_info,
      :tcv, :aav, :guaranteed, :submitted_at_utc, :commish_override_flag, :override_as_of_date, :commentary,
      :xml_payload, :inferred_flag, :inferred_from_season, :inferred_from_week, :inference_note
    )
    ON CONFLICT(submission_id) DO UPDATE SET
      source=excluded.source,
      league_id=excluded.league_id,
      season=excluded.season,
      franchise_id=excluded.franchise_id,
      franchise_name=excluded.franchise_name,
      franchise_logo=excluded.franchise_logo,
      player_id=excluded.player_id,
      player_name=excluded.player_name,
      position=excluded.position,
      salary=excluded.salary,
      contract_year=excluded.contract_year,
      contract_status=excluded.contract_status,
      contract_info=excluded.contract_info,
      tcv=excluded.tcv,
      aav=excluded.aav,
      guaranteed=excluded.guaranteed,
      submitted_at_utc=excluded.submitted_at_utc,
      commish_override_flag=excluded.commish_override_flag,
      override_as_of_date=excluded.override_as_of_date,
      commentary=excluded.commentary,
      xml_payload=excluded.xml_payload,
      inferred_flag=excluded.inferred_flag,
      inferred_from_season=excluded.inferred_from_season,
      inferred_from_week=excluded.inferred_from_week,
      inference_note=excluded.inference_note
    """
    for row in rows:
        exists = conn.execute(
            "SELECT 1 FROM restructure_submissions WHERE submission_id = ? LIMIT 1",
            (safe_str(row["submission_id"]),),
        ).fetchone()
        conn.execute(sql, row)
        if exists:
            updated += 1
        else:
            inserted += 1
    return inserted, updated


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--db-path", default=DEFAULT_DB_PATH)
    p.add_argument("--json-path", default=str(DEFAULT_JSON_PATH))
    p.add_argument(
        "--include-inferred",
        default="1",
        help="1 to include historical inference from rosters_weekly (default), 0 to skip",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    include_inferred = safe_str(args.include_inferred).lower() not in {"0", "false", "no", "off"}

    json_path = Path(args.json_path)
    conn = get_conn(args.db_path)
    conn.row_factory = sqlite3.Row

    try:
        ensure_table(conn)

        json_raw_rows = load_json_rows(json_path)
        json_rows = [normalize_json_row(conn, row) for row in json_raw_rows]
        inferred_rows = infer_historical_rows(conn) if include_inferred else []
        trade_comment_rows = infer_trade_comment_rows(conn) if include_inferred else []

        all_rows = dedupe_by_submission_id([*json_rows, *inferred_rows, *trade_comment_rows])
        inserted, updated = upsert_rows(conn, all_rows)
        conn.commit()

        total_db = conn.execute("SELECT COUNT(*) FROM restructure_submissions").fetchone()[0]
        inferred_db = conn.execute(
            "SELECT COUNT(*) FROM restructure_submissions WHERE inferred_flag = 1"
        ).fetchone()[0]
        worker_db = conn.execute(
            "SELECT COUNT(*) FROM restructure_submissions WHERE inferred_flag = 0"
        ).fetchone()[0]

        print(f"DB path: {args.db_path}")
        print(f"JSON path: {json_path}")
        print(f"Loaded JSON rows: {len(json_rows)}")
        print(f"Loaded inferred rows: {len(inferred_rows)}")
        print(f"Loaded trade-comment rows: {len(trade_comment_rows)}")
        print(f"Upserted rows: {len(all_rows)} (inserted={inserted}, updated={updated})")
        print(f"Table count: {total_db} (worker={worker_db}, inferred={inferred_db})")

        print("\nRestructure seasons summary:")
        for season, cnt in conn.execute(
            "SELECT season, COUNT(*) FROM restructure_submissions GROUP BY season ORDER BY season"
        ):
            print(f"  {season}: {cnt}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
