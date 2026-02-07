#!/usr/bin/env python3
"""Fetch MFL message board exports for configured seasons.

Requires either:
- MFL_USER_ID (cookie value) OR
- API key(s) (single key or per-season mapping)
"""

import argparse
import csv
import json
import os
import sys
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
    # Normalize keys to strings.
    return {str(k): str(v) for k, v in data.items()}


def build_url(server: str, season: str, league_id: str, count: int, fmt: str, api_key: str | None, mfl_user_id: str | None) -> str:
    params = {
        "TYPE": "messageBoard",
        "L": league_id,
        "COUNT": str(count),
        "JSON": "1" if fmt == "json" else "0",
    }
    if api_key:
        params["APIKEY"] = api_key
    if mfl_user_id:
        params["MFL_USER_ID"] = mfl_user_id

    query = urllib.parse.urlencode(params)
    return f"https://{server}.myfantasyleague.com/{season}/export?{query}"


def fetch(url: str, mfl_user_id: str | None, timeout: int) -> bytes:
    req = urllib.request.Request(url)
    if mfl_user_id:
        req.add_header("Cookie", f"MFL_USER_ID={mfl_user_id}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def parse_error(content: bytes, fmt: str) -> str | None:
    text = content.decode("utf-8", errors="replace").strip()
    if not text:
        return "Empty response"
    if fmt == "json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
        if isinstance(data, dict) and "error" in data:
            return str(data.get("error"))
        return None
    # XML
    if "<error>" in text and "</error>" in text:
        start = text.find("<error>") + len("<error>")
        end = text.find("</error>")
        return text[start:end].strip()
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", default="rules/mfl_message_boards/seasons.csv", help="CSV with season,server,league_id")
    parser.add_argument("--out-dir", default="rules/mfl_message_boards/raw", help="Output directory")
    parser.add_argument("--count", type=int, default=5000, help="Max number of messages to request")
    parser.add_argument("--format", choices=["json", "xml"], default="json")
    parser.add_argument("--apikey", default=os.getenv("MFL_APIKEY"), help="Single API key to use for all seasons")
    parser.add_argument("--apikeys", help="JSON mapping of season->API key")
    parser.add_argument("--mfl-user-id", default=os.getenv("MFL_USER_ID"), help="MFL_USER_ID cookie value")
    parser.add_argument("--sleep", type=float, default=0.2, help="Sleep between requests (seconds)")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout (seconds)")
    args = parser.parse_args()

    apikeys = load_apikeys(args.apikeys)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    error_rows: list[dict[str, str]] = []
    success = 0

    with open(args.seasons, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    for row in rows:
        season = str(row.get("season", "")).strip()
        server = str(row.get("server", "")).strip()
        league_id = str(row.get("league_id", "")).strip()
        if not (season and server and league_id):
            error_rows.append({
                "season": season,
                "server": server,
                "league_id": league_id,
                "error": "Missing season/server/league_id",
            })
            continue

        api_key = apikeys.get(season) or args.apikey

        url = build_url(server, season, league_id, args.count, args.format, api_key, args.mfl_user_id)
        ext = "json" if args.format == "json" else "xml"
        out_path = out_dir / f"{season}.{ext}"

        try:
            data = fetch(url, args.mfl_user_id, args.timeout)
        except Exception as exc:
            error_rows.append({
                "season": season,
                "server": server,
                "league_id": league_id,
                "error": f"Fetch failed: {type(exc).__name__}: {exc}",
            })
            continue

        # Write raw data regardless; still capture any error message.
        out_path.write_bytes(data)
        err = parse_error(data, args.format)
        if err:
            error_rows.append({
                "season": season,
                "server": server,
                "league_id": league_id,
                "error": err,
            })
        else:
            success += 1

        if args.sleep:
            time.sleep(args.sleep)

    if error_rows:
        errors_path = out_dir.parent / "errors.csv"
        with open(errors_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["season", "server", "league_id", "error"])
            writer.writeheader()
            writer.writerows(error_rows)

    print(f"Fetched {success} seasons; {len(error_rows)} errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
