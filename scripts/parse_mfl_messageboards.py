#!/usr/bin/env python3
"""Parse MFL message board exports into structured topic/message output."""

import argparse
import csv
import json
import os
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def pick(mapping, keys):
    if not isinstance(mapping, dict):
        return ""
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return str(mapping[key])
    return ""


def get_attr_or_child(elem, keys):
    for key in keys:
        if key in elem.attrib and elem.attrib[key]:
            return elem.attrib[key]
    for key in keys:
        child = elem.find(key)
        if child is not None and child.text:
            return child.text
    return ""


def parse_json(content, season, server, league_id, rows):
    data = json.loads(content)
    board = data.get("messageBoard") or {}

    topics = as_list(board.get("topic"))
    messages = as_list(board.get("message")) if not topics else []

    for topic in topics:
        topic_id = pick(topic, ["id", "topic_id", "topicId", "topic"])
        subject = pick(topic, ["subject", "title", "topic_subject", "topicSubject"])
        topic_posted = pick(topic, ["posted", "date", "timestamp", "created", "created_at"])
        topic_poster = pick(topic, ["poster", "author", "owner", "franchise", "user"])

        for message in as_list(topic.get("message")):
            message_id = pick(message, ["id", "message_id", "messageId"])
            message_posted = pick(message, ["posted", "date", "timestamp", "created", "created_at"])
            message_author = pick(message, ["poster", "author", "owner", "franchise", "user"])
            message_text = pick(message, ["message", "body", "text", "content", "post"])
            rows.append({
                "season": season,
                "server": server,
                "league_id": league_id,
                "topic_id": topic_id,
                "topic_subject": subject,
                "topic_posted": topic_posted,
                "topic_poster": topic_poster,
                "message_id": message_id,
                "message_posted": message_posted,
                "message_author": message_author,
                "message_text": message_text,
            })

    for message in messages:
        topic_id = pick(message, ["topic_id", "topicId", "topic", "topic_id" ])
        subject = pick(message, ["topic_subject", "subject", "title"])
        message_id = pick(message, ["id", "message_id", "messageId"])
        message_posted = pick(message, ["posted", "date", "timestamp", "created", "created_at"])
        message_author = pick(message, ["poster", "author", "owner", "franchise", "user"])
        message_text = pick(message, ["message", "body", "text", "content", "post"])
        rows.append({
            "season": season,
            "server": server,
            "league_id": league_id,
            "topic_id": topic_id,
            "topic_subject": subject,
            "topic_posted": "",
            "topic_poster": "",
            "message_id": message_id,
            "message_posted": message_posted,
            "message_author": message_author,
            "message_text": message_text,
        })


def parse_xml(content, season, server, league_id, rows):
    root = ET.fromstring(content)

    topics = root.findall(".//topic")
    if topics:
        for topic in topics:
            topic_id = get_attr_or_child(topic, ["id", "topic_id", "topicId", "topic"])
            subject = get_attr_or_child(topic, ["subject", "title", "topic_subject", "topicSubject"])
            topic_posted = get_attr_or_child(topic, ["posted", "date", "timestamp", "created", "created_at"])
            topic_poster = get_attr_or_child(topic, ["poster", "author", "owner", "franchise", "user"])

            for message in topic.findall(".//message"):
                message_id = get_attr_or_child(message, ["id", "message_id", "messageId"])
                message_posted = get_attr_or_child(message, ["posted", "date", "timestamp", "created", "created_at"])
                message_author = get_attr_or_child(message, ["poster", "author", "owner", "franchise", "user"])
                message_text = get_attr_or_child(message, ["message", "body", "text", "content", "post"])
                rows.append({
                    "season": season,
                    "server": server,
                    "league_id": league_id,
                    "topic_id": topic_id,
                    "topic_subject": subject,
                    "topic_posted": topic_posted,
                    "topic_poster": topic_poster,
                    "message_id": message_id,
                    "message_posted": message_posted,
                    "message_author": message_author,
                    "message_text": message_text,
                })
        return

    messages = root.findall(".//message")
    for message in messages:
        topic_id = get_attr_or_child(message, ["topic_id", "topicId", "topic"])
        subject = get_attr_or_child(message, ["topic_subject", "subject", "title"])
        message_id = get_attr_or_child(message, ["id", "message_id", "messageId"])
        message_posted = get_attr_or_child(message, ["posted", "date", "timestamp", "created", "created_at"])
        message_author = get_attr_or_child(message, ["poster", "author", "owner", "franchise", "user"])
        message_text = get_attr_or_child(message, ["message", "body", "text", "content", "post"])
        rows.append({
            "season": season,
            "server": server,
            "league_id": league_id,
            "topic_id": topic_id,
            "topic_subject": subject,
            "topic_posted": "",
            "topic_poster": "",
            "message_id": message_id,
            "message_posted": message_posted,
            "message_author": message_author,
            "message_text": message_text,
        })


def summarize(rows):
    summary = defaultdict(lambda: {
        "topic_subject": "",
        "topic_posted": "",
        "topic_poster": "",
        "message_count": 0,
        "first_posted": "",
        "last_posted": "",
    })

    for row in rows:
        key = (row["season"], row["server"], row["league_id"], row["topic_id"], row["topic_subject"])
        entry = summary[key]
        if not entry["topic_subject"]:
            entry["topic_subject"] = row["topic_subject"]
        if not entry["topic_posted"] and row["topic_posted"]:
            entry["topic_posted"] = row["topic_posted"]
        if not entry["topic_poster"] and row["topic_poster"]:
            entry["topic_poster"] = row["topic_poster"]

        entry["message_count"] += 1
        if row["message_posted"]:
            if not entry["first_posted"]:
                entry["first_posted"] = row["message_posted"]
            entry["last_posted"] = row["message_posted"]

    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="rules/mfl_message_boards/raw")
    parser.add_argument("--seasons", default="rules/mfl_message_boards/seasons.csv")
    parser.add_argument("--out-csv", default="rules/mfl_message_boards/topics.csv")
    parser.add_argument("--out-md", default="rules/mfl_message_boards/topics.md")
    args = parser.parse_args()

    raw_dir = Path(args.raw_dir)
    rows = []

    with open(args.seasons, "r", encoding="utf-8") as f:
        season_rows = list(csv.DictReader(f))

    for row in season_rows:
        season = str(row.get("season", "")).strip()
        server = str(row.get("server", "")).strip()
        league_id = str(row.get("league_id", "")).strip()
        if not season:
            continue

        json_path = raw_dir / f"{season}.json"
        xml_path = raw_dir / f"{season}.xml"
        if json_path.exists():
            content = json_path.read_text(encoding="utf-8", errors="replace")
            if content.strip().startswith("{"):
                parse_json(content, season, server, league_id, rows)
            continue
        if xml_path.exists():
            content = xml_path.read_text(encoding="utf-8", errors="replace")
            if content.strip():
                parse_xml(content, season, server, league_id, rows)
            continue

    # Write topics CSV
    out_csv = Path(args.out_csv)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "season",
                "server",
                "league_id",
                "topic_id",
                "topic_subject",
                "topic_posted",
                "topic_poster",
                "message_id",
                "message_posted",
                "message_author",
                "message_text",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)

    # Write summary markdown
    summary = summarize(rows)
    out_md = Path(args.out_md)
    out_md.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        "# MFL Message Board Topics",
        "",
        f"Generated from `rules/mfl_message_boards/raw/`.",
        "",
    ]

    # Group by season
    grouped = defaultdict(list)
    for key, entry in summary.items():
        season, server, league_id, topic_id, subject = key
        grouped[season].append((server, league_id, topic_id, subject, entry))

    for season in sorted(grouped.keys()):
        items = grouped[season]
        lines.append(f"## {season}")
        if not items:
            lines.append("No topics found.")
            lines.append("")
            continue

        for server, league_id, topic_id, subject, entry in sorted(items, key=lambda x: (x[3] or "", x[2] or "")):
            subject_display = subject or "(untitled)"
            lines.append(
                f"- {subject_display} (topic_id: {topic_id or 'n/a'}, messages: {entry['message_count']}, "
                f"first: {entry['first_posted'] or 'n/a'}, last: {entry['last_posted'] or 'n/a'})"
            )
        lines.append("")

    out_md.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    print(f"Parsed {len(rows)} messages across {len(grouped)} seasons")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
