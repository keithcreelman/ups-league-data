#!/usr/bin/env python3
"""Parse manual message board dumps into chronological and rule-highlight views."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Optional


DATE_RE = re.compile(
    r"((Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+"
    r"[A-Z][a-z]{2}\s+\d{1,2}\s+"
    r"\d{1,2}:\d{2}:\d{2}\s+[ap]\.m\.\s+ET\s+\d{4}|"
    r"DATE UNKNOWN)$"
)

RULE_KEYWORDS = re.compile(
    r"\b("
    r"rule|rules|waiver|waivers|free[- ]?agent|auction|roster|contract|cap|penalt"
    r"|injured reserve|IR\b|lineup|starter|playoff|seed|draft|tag|franchise|transition"
    r"|extension|scoring|points|formation|bye|taxi|holdout|suspend|retire|trade|add/drop"
    r")\b",
    re.IGNORECASE,
)


HEADER_EXACT = {
    "FROM\tMESSAGE\tDATE",
    "FROM MESSAGE DATE",
    "FROM\tMESSAGE",
    "FROM MESSAGE",
    "FROM",
    "MESSAGE",
    "DATE",
}


def is_header_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if stripped in HEADER_EXACT:
        return True
    if re.search(r"\bMESSAGE\s+DATE$", stripped):
        return True
    if "Logout | Link Franchise" in stripped:
        return True
    if stripped.startswith("<poll") or stripped.startswith("</poll") or stripped.startswith("<polls"):
        return True
    if stripped.startswith("<answer ") or stripped.startswith("<poll "):
        return True
    if stripped.lower().startswith("polls:"):
        return True
    if re.match(r"^\d{4}\s*-?$", stripped):
        return True
    if re.match(r"^\d{4}\s*-", stripped):
        return True
    # All-caps headings like "PLAYOFFS", "WAIVERS", "DOUBLE HEADER"
    if not re.search(r"[a-z]", stripped) and re.match(r"^[A-Z0-9 /&()'\".,!:-]+$", stripped):
        return True
    return False


def is_strict_header_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if stripped in HEADER_EXACT:
        return True
    if re.search(r"\bFROM\s+MESSAGE\s+DATE\b", stripped):
        return True
    if re.search(r"\bFROM\s+MESSAGE\b", stripped):
        return True
    return False


def parse_date(date_str: str) -> Optional[datetime]:
    if date_str.strip() == "DATE UNKNOWN":
        return None
    cleaned = (
        date_str.replace("a.m.", "AM")
        .replace("p.m.", "PM")
        .replace("ET", "")
        .strip()
    )
    cleaned = re.sub(r"\s+", " ", cleaned)
    try:
        return datetime.strptime(cleaned, "%a %b %d %I:%M:%S %p %Y")
    except ValueError:
        return None


@dataclass
class Entry:
    date_str: str
    date_dt: Optional[datetime]
    author: str
    message: str

    @property
    def known(self) -> bool:
        return bool(self.author and self.author.lower() != "unknown")


def flush_block(lines: List[str]) -> Optional[Entry]:
    if not lines:
        return None

    last_line = lines[-1]
    match = DATE_RE.search(last_line)
    if not match:
        return None

    date_str = match.group(0)
    lines[-1] = last_line[: match.start()].rstrip("\t ")
    if lines[-1] == "":
        lines = lines[:-1]

    if not lines:
        return None

    # Remove table headers that sometimes appear inside the dump.
    lines = [line for line in lines if not is_strict_header_line(line)]
    if not lines:
        return None

    author = "Unknown"
    message_lines = list(lines)
    if "\t" in lines[0]:
        raw_author, first_text = lines[0].split("\t", 1)
        raw_author = raw_author.strip()
        if raw_author and not is_header_line(raw_author):
            author = raw_author
        message_lines = [first_text] + lines[1:]

    message = "\n".join([line.rstrip() for line in message_lines]).strip()
    if not message:
        return None

    date_dt = parse_date(date_str)
    return Entry(date_str=date_str, date_dt=date_dt, author=author, message=message)


def parse_manual_file(path: Path) -> List[Entry]:
    entries: List[Entry] = []
    current: List[str] = []

    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.rstrip()

        if is_header_line(line) and not current:
            continue

        current.append(line)
        if DATE_RE.search(line):
            entry = flush_block(current)
            if entry:
                entries.append(entry)
            current = []

    return entries


def write_chronological(entries: Iterable[Entry], out_path: Path, title: str) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sorted_entries = sorted(
        entries,
        key=lambda e: e.date_dt or datetime.max,
    )

    lines: List[str] = [f"# {title}", ""]
    for entry in sorted_entries:
        display_date = (
            entry.date_dt.strftime("%Y-%m-%d %H:%M:%S ET")
            if entry.date_dt
            else entry.date_str
        )
        source = f"{entry.author} ({'known' if entry.known else 'unknown'})"
        lines.append(f"{display_date} — {source}")
        lines.append(f"Message: {entry.message}")
        lines.append("")

    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def write_highlights(entries_by_year: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    years = sorted(entries_by_year.keys())
    title_range = f"{years[0]}–{years[-1]}" if years else ""
    lines: List[str] = [f"# Rule-Related Highlights ({title_range})", ""]

    for year in sorted(entries_by_year.keys()):
        entries = [e for e in entries_by_year[year] if RULE_KEYWORDS.search(e.message)]
        lines.append(f"## {year}")
        lines.append("")
        if not entries:
            lines.append("No rule-related messages detected.")
            lines.append("")
            continue
        for entry in sorted(entries, key=lambda e: e.date_dt or datetime.max):
            display_date = (
                entry.date_dt.strftime("%Y-%m-%d %H:%M:%S ET")
                if entry.date_dt
                else entry.date_str
            )
            source = f"{entry.author} ({'known' if entry.known else 'unknown'})"
            lines.append(f"{display_date} — {source}")
            lines.append(f"Message: {entry.message}")
            lines.append("")

    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manual-dir", default="rules/mfl_message_boards/manual")
    parser.add_argument("--chrono-dir", default="rules/mfl_message_boards/chronological")
    parser.add_argument("--highlights", default="rules/mfl_message_boards/highlights/rules_2010_2011.md")
    args = parser.parse_args()

    manual_dir = Path(args.manual_dir)
    chrono_dir = Path(args.chrono_dir)
    highlights_path = Path(args.highlights)

    entries_by_year: dict[str, List[Entry]] = {}
    for path in sorted(manual_dir.glob("*_messageboard.txt")):
        year = path.stem.split("_")[0]
        entries = parse_manual_file(path)
        entries_by_year[year] = entries
        write_chronological(
            entries,
            chrono_dir / f"{year}.md",
            title=f"{year} Message Board (Chronological)",
        )

    if entries_by_year:
        write_highlights(entries_by_year, highlights_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
