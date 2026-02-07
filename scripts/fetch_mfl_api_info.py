#!/usr/bin/env python3
"""Fetch MFL api_info for messageBoard export for each season.

Stores raw responses under rules/mfl_message_boards/api_info/<season>.txt
"""

import argparse
import csv
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path


def load_apikeys(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("apikeys JSON must be an object mapping season to key")
    return {str(k): str(v) for k, v in data.items()}


def build_url(server: str, season: str, league_id: str, api_key: str | None) -> str:
    params = {
        "STATE": "test",
        "CCAT": "export",
        "TYPE": "messageBoard",
        "L": league_id,
    }
    if api_key:
        params["APIKEY"] = api_key
    query = urllib.parse.urlencode(params)
    return f"https://{server}.myfantasyleague.com/{season}/api_info?{query}"


def fetch(url: str, mfl_user_id: str | None, timeout: int) -> bytes:
    req = urllib.request.Request(url)
    if mfl_user_id:
        req.add_header("Cookie", f"MFL_USER_ID={mfl_user_id}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", default="rules/mfl_message_boards/seasons.csv")
    parser.add_argument("--out-dir", default="rules/mfl_message_boards/api_info")
    parser.add_argument("--apikey", default=os.getenv("MFL_APIKEY"))
    parser.add_argument("--apikeys", default="rules/mfl_message_boards/apikeys.json")
    parser.add_argument("--mfl-user-id", default=os.getenv("MFL_USER_ID"))
    parser.add_argument("--sleep", type=float, default=0.2)
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()

    apikeys = load_apikeys(args.apikeys) if args.apikeys else {}
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(args.seasons, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    for row in rows:
        season = str(row.get("season", "")).strip()
        server = str(row.get("server", "")).strip()
        league_id = str(row.get("league_id", "")).strip()
        if not (season and server and league_id):
            continue

        api_key = apikeys.get(season) or args.apikey
        url = build_url(server, season, league_id, api_key)
        out_path = out_dir / f"{season}.txt"

        try:
            data = fetch(url, args.mfl_user_id, args.timeout)
        except Exception as exc:
            out_path.write_text(f"ERROR: {type(exc).__name__}: {exc}\nURL: {url}\n", encoding="utf-8")
            continue

        out_path.write_bytes(data)
        if args.sleep:
            time.sleep(args.sleep)

    print(f"Wrote api_info to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
