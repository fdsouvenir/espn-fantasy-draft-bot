from draft_companion.dashboard import board_url
from draft_companion.ui import _automatic_board_url, _connection_states


def test_board_url_requires_one_nonempty_draft_query():
    assert board_url("https://draftside.example.com/?draft=league%3A1") == (
        "https://draftside.example.com/?draft=league%3A1"
    )
    assert board_url("https://draftside.example.com/") is None
    assert board_url("http://draftside.example.com/?draft=league%3A1") is None


def test_selected_board_opens_automatically_only_once():
    url = "https://draftside.example.com/?draft=league%3A1"
    health = {
        "pid": 123,
        "dashboardUrl": url,
        "selectedDraft": {"draftKey": "league:1"},
    }

    assert _automatic_board_url(health, None, 123) == url
    assert _automatic_board_url(health, url, 123) is None
    assert _automatic_board_url(health, None, 456) is None


def test_selected_board_rejects_a_stale_or_mismatched_draft_url():
    old_url = "https://draftside.example.com/?draft=league%3Aold"
    health = {
        "pid": 123,
        "dashboardUrl": old_url,
        "selectedDraft": {"draftKey": "league:new"},
    }

    assert _automatic_board_url(health, None, 123) is None
    assert _automatic_board_url({"dashboardUrl": old_url}, None, 123) is None


def test_uninitialized_board_does_not_claim_espn_is_disconnected():
    assert _connection_states("draft_not_initialized", False) == (
        "Connected",
        "Open",
        "Detected",
        "Not initialized",
    )


def test_live_state_distinguishes_room_from_selected_board():
    assert _connection_states("live", True) == (
        "Connected",
        "Open",
        "Connected",
        "Selected",
    )
