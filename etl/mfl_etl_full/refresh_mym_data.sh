#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PYTHON_BIN="${PYTHON_BIN:-python3}"
DB_PATH="${MFL_DB_PATH:-/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db}"
SOURCE_ETL_DIR="${MFL_SOURCE_ETL_DIR:-/Users/keithcreelman/Desktop/MFL_Scripts/Code/mflworkspace/mfl_etl_full}"
MIN_SEASON="${MIN_SEASON:-2019}"
PUBLISH="0"

default_season() {
  local y m
  y="$(date +%Y)"
  m="$(date +%m)"
  if [[ "$m" -lt 3 ]]; then
    echo $((y - 1))
  else
    echo "$y"
  fi
}

SEASON="$(default_season)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --season)
      SEASON="$2"
      shift 2
      ;;
    --publish)
      PUBLISH="1"
      shift
      ;;
    *)
      echo "Unknown arg: $1"
      echo "Usage: $0 [--season YEAR] [--publish]"
      exit 2
      ;;
  esac
done

echo "==> Refresh rosters_current for season $SEASON"
"$PYTHON_BIN" "$SCRIPT_DIR/loadrosterscurrent" --season "$SEASON"

VIEW_SCRIPT="$SOURCE_ETL_DIR/view_MYM.py"
EXPORT_SCRIPT="$SOURCE_ETL_DIR/export_mym_to_pages.py"

if [[ ! -f "$VIEW_SCRIPT" ]]; then
  echo "ERROR: Missing $VIEW_SCRIPT"
  exit 3
fi
if [[ ! -f "$EXPORT_SCRIPT" ]]; then
  echo "ERROR: Missing $EXPORT_SCRIPT"
  exit 4
fi

echo "==> Rebuild MYM views"
"$PYTHON_BIN" "$VIEW_SCRIPT" --db-path "$DB_PATH"

echo "==> Export mym_dashboard.json"
"$PYTHON_BIN" "$EXPORT_SCRIPT" \
  --db-path "$DB_PATH" \
  --out "$REPO_ROOT/mym_dashboard.json" \
  --min-season "$MIN_SEASON"

if [[ "$PUBLISH" == "1" ]]; then
  echo "==> Publish updated mym_dashboard.json to GitHub"
  git -C "$REPO_ROOT" add mym_dashboard.json
  git -C "$REPO_ROOT" commit -m "Refresh MYM dashboard JSON for season $SEASON" || true
  git -C "$REPO_ROOT" push origin main
fi

echo "Done."
