from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict


FALLBACK_DB_PATH = "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db"
DEFAULT_CONFIG_FILE = Path(__file__).with_name("mfl_config.json")


@dataclass(frozen=True)
class MflConfig:
    db_path: str
    timezone: str
    start_week_default: int
    end_week_default: int
    last_regular_week_default: int
    daily_refresh_hour: int
    daily_refresh_minute: int
    monday_refresh_hour: int
    monday_refresh_minute: int
    nfl_kickoff_event: str
    season_complete_event: str
    sleep_between_weeks: float
    sleep_between_seasons: float


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _deep_get(data: Dict[str, Any], keys: tuple[str, ...], default: Any = None) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return default
        if key not in current:
            return default
        current = current[key]
    return current


def _load_json_if_present(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_config(config_path: str | None = None) -> MflConfig:
    """
    Load ETL config from:
      1) explicit --config path (if provided)
      2) MFL_ETL_CONFIG env var
      3) local mfl_config.json beside this file (if present)
    """
    explicit_path = config_path or os.environ.get("MFL_ETL_CONFIG")
    cfg_path = Path(explicit_path).expanduser() if explicit_path else DEFAULT_CONFIG_FILE
    raw = _load_json_if_present(cfg_path)

    db_path = os.environ.get(
        "MFL_DB_PATH",
        _deep_get(raw, ("db", "path"), FALLBACK_DB_PATH),
    )

    timezone = str(_deep_get(raw, ("schedule", "timezone"), "America/New_York"))
    start_week_default = _safe_int(_deep_get(raw, ("defaults", "start_week"), 1), 1)
    end_week_default = _safe_int(_deep_get(raw, ("defaults", "end_week"), 17), 17)
    last_regular_week_default = _safe_int(
        _deep_get(raw, ("defaults", "last_regular_season_week"), 14),
        14,
    )
    monday_refresh_hour = _safe_int(
        _deep_get(raw, ("schedule", "weekly_refresh", "hour"), 23),
        23,
    )
    monday_refresh_minute = _safe_int(
        _deep_get(raw, ("schedule", "weekly_refresh", "minute"), 30),
        30,
    )
    daily_refresh_hour = _safe_int(
        _deep_get(raw, ("schedule", "daily_refresh", "hour"), 0),
        0,
    )
    daily_refresh_minute = _safe_int(
        _deep_get(raw, ("schedule", "daily_refresh", "minute"), 0),
        0,
    )
    nfl_kickoff_event = str(
        _deep_get(raw, ("season_window", "start_event"), "nfl_kickoff")
    )
    season_complete_event = str(
        _deep_get(raw, ("season_window", "end_event"), "ups_season_complete")
    )
    sleep_between_weeks = _safe_float(
        _deep_get(raw, ("pacing", "sleep_between_weeks"), 3.0),
        3.0,
    )
    sleep_between_seasons = _safe_float(
        _deep_get(raw, ("pacing", "sleep_between_seasons"), 8.0),
        8.0,
    )

    return MflConfig(
        db_path=db_path,
        timezone=timezone,
        start_week_default=start_week_default,
        end_week_default=end_week_default,
        last_regular_week_default=last_regular_week_default,
        daily_refresh_hour=daily_refresh_hour,
        daily_refresh_minute=daily_refresh_minute,
        monday_refresh_hour=monday_refresh_hour,
        monday_refresh_minute=monday_refresh_minute,
        nfl_kickoff_event=nfl_kickoff_event,
        season_complete_event=season_complete_event,
        sleep_between_weeks=sleep_between_weeks,
        sleep_between_seasons=sleep_between_seasons,
    )
