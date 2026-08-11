#!/usr/bin/env python3
"""Fail CI when publish-unsafe artifacts or credential-shaped values appear."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IGNORED_PARTS = {".git", "node_modules", ".wrangler", ".venv", "__pycache__"}
FORBIDDEN_SUFFIXES = (
    ".checkpoint.json",
    ".evidence.jsonl",
    ".ndjson",
    ".sqlite",
    ".sqlite3",
)
FORBIDDEN_NAMES = {".env", ".dev.vars"}
TEXT_SUFFIXES = {
    "", ".css", ".html", ".js", ".json", ".jsonc", ".md", ".py",
    ".toml", ".ts", ".txt", ".yml", ".yaml",
}
PATTERNS = {
    "GitHub token": re.compile(r"\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "Cloudflare API token": re.compile(r"\b(?:cfat_[A-Za-z0-9_-]{20,}|v1\.0-[A-Za-z0-9_-]{40,})\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "vault coordinate": re.compile(r"vault://", re.IGNORECASE),
    "private deployment hostname": re.compile(r"(?:fredbot\.link|localhost:\d+/api/work)", re.IGNORECASE),
}


def files() -> list[Path]:
    return [
        path for path in ROOT.rglob("*")
        if path.is_file() and not any(part in IGNORED_PARTS for part in path.relative_to(ROOT).parts)
    ]


def main() -> int:
    failures: list[str] = []
    for path in files():
        relative = path.relative_to(ROOT)
        if path.name in FORBIDDEN_NAMES or path.name.endswith(FORBIDDEN_SUFFIXES):
            failures.append(f"forbidden artifact: {relative}")
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES or path.stat().st_size > 2_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if relative == Path("scripts/check_repository_safety.py"):
            continue
        for label, pattern in PATTERNS.items():
            if pattern.search(text):
                failures.append(f"{label}: {relative}")
    if failures:
        print("Repository safety check failed:")
        for failure in sorted(failures):
            print(f"- {failure}")
        return 1
    print("Repository safety check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
