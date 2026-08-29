from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import parse_qs, urlparse


def board_url(value: object) -> str | None:
    if not isinstance(value, str) or not value.startswith("https://"):
        return None
    parsed = urlparse(value)
    draft = parse_qs(parsed.query).get("draft", [])
    return value if len(draft) == 1 and bool(draft[0]) else None


def current_board_url(health: Mapping[str, object], runtime_pid: int | None) -> str | None:
    url = board_url(health.get("dashboardUrl"))
    selected = health.get("selectedDraft")
    health_pid = health.get("pid")
    if (
        url is None
        or runtime_pid is None
        or isinstance(runtime_pid, bool)
        or runtime_pid <= 0
        or isinstance(health_pid, bool)
        or health_pid != runtime_pid
        or not isinstance(selected, Mapping)
    ):
        return None
    selected_key = selected.get("draftKey")
    draft = parse_qs(urlparse(url).query).get("draft", [])
    if not isinstance(selected_key, str) or draft != [selected_key]:
        return None
    return url
