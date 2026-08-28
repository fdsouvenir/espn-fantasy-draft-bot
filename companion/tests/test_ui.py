from draft_companion.ui import _automatic_board_url, _board_url


def test_board_url_requires_one_nonempty_draft_query():
    assert _board_url("https://draftside.example.com/?draft=league%3A1") == (
        "https://draftside.example.com/?draft=league%3A1"
    )
    assert _board_url("https://draftside.example.com/") is None
    assert _board_url("http://draftside.example.com/?draft=league%3A1") is None


def test_selected_board_opens_automatically_only_once():
    url = "https://draftside.example.com/?draft=league%3A1"
    health = {"dashboardUrl": url, "selectedDraft": {"draftKey": "league:1"}}

    assert _automatic_board_url(health, None) == url
    assert _automatic_board_url(health, url) is None
    assert _automatic_board_url({"dashboardUrl": url}, None) is None
