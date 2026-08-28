from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import dashboard_candidate, dashboard_setup_required, write_device_config

SERVICE_UNIT = "draftside-companion-runtime.service"
LEGACY_SERVICE_UNIT = "draftside-companion.service"


def _config_path() -> Path:
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser()
    configured = os.environ.get(
        "DRAFTSIDE_CONFIG", str(config_home / "draftside-companion/companion.toml")
    )
    return Path(configured).expanduser()


def _health_path() -> Path:
    state_home = Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser()
    return state_home / "draftside-companion/health.json"


def _selection_path() -> Path:
    return _health_path().with_name("draft-selection.json")


def _write_draft_selection(draft_key: str) -> None:
    if not draft_key or len(draft_key) > 240:
        raise ValueError("invalid draft selection")
    path = _selection_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            if hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), 0o600)
            json.dump({"draftKey": draft_key}, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _board_url(value: object) -> str | None:
    if not isinstance(value, str) or not value.startswith("https://"):
        return None
    parsed = urlparse(value)
    draft = parse_qs(parsed.query).get("draft", [])
    return value if len(draft) == 1 and bool(draft[0]) else None


def _automatic_board_url(health: dict[str, object], opened_url: str | None) -> str | None:
    url = _board_url(health.get("dashboardUrl"))
    selected = health.get("selectedDraft")
    if url is None or url == opened_url or not isinstance(selected, dict):
        return None
    return url


def _read_health() -> dict[str, object]:
    try:
        value = json.loads(_health_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, ValueError, OSError):
        return {}


def main() -> int:
    try:
        import gi

        gi.require_version("Gtk", "4.0")
        from gi.repository import Gio, GLib, Gtk
    except (ImportError, ValueError) as error:
        raise SystemExit(f"Draftside's desktop interface is unavailable: {error}") from error

    class DraftsideApp(Gtk.Application):
        def __init__(self):
            super().__init__(application_id="com.draftside.Companion")
            self.refresh_source = None

        @staticmethod
        def service(action: str):
            subprocess.run(
                ["systemctl", "--user", action, SERVICE_UNIT],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

        @staticmethod
        def retire_legacy_service():
            subprocess.run(
                ["systemctl", "--user", "disable", "--now", LEGACY_SERVICE_UNIT],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

        @staticmethod
        def reload_units():
            subprocess.run(
                ["systemctl", "--user", "daemon-reload"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

        def clear_refresh(self):
            if self.refresh_source is not None:
                GLib.source_remove(self.refresh_source)
                self.refresh_source = None

        def show_setup(self, window):
            self.clear_refresh()
            self.service("stop")
            outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
            outer.set_margin_top(32)
            outer.set_margin_bottom(32)
            outer.set_margin_start(32)
            outer.set_margin_end(32)

            title = Gtk.Label(label="Connect your private Draftside dashboard")
            title.add_css_class("title-1")
            title.set_wrap(True)
            title.set_xalign(0)
            outer.append(title)

            copy = Gtk.Label(
                label="Enter its HTTPS address. Draftside saves it only on this laptop."
            )
            copy.set_wrap(True)
            copy.set_xalign(0)
            outer.append(copy)

            entry = Gtk.Entry()
            entry.set_placeholder_text("https://your-dashboard-host")
            entry.set_text(dashboard_candidate(_config_path()))
            entry.set_hexpand(True)
            outer.append(entry)

            error = Gtk.Label()
            error.add_css_class("error")
            error.set_wrap(True)
            error.set_xalign(0)
            outer.append(error)

            connect = Gtk.Button(label="Connect Dashboard")
            connect.add_css_class("suggested-action")
            outer.append(connect)

            note = Gtk.Label(
                label="Draftside will open a separate Chrome window. Sign into ESPN and use the draft room in that window."
            )
            note.set_wrap(True)
            note.set_xalign(0)
            outer.append(note)

            def save(_widget):
                try:
                    write_device_config(_config_path(), entry.get_text())
                except (OSError, TypeError, ValueError) as problem:
                    error.set_label(str(problem))
                    return
                try:
                    _health_path().unlink()
                except FileNotFoundError:
                    pass
                self.show_status(window)

            connect.connect("clicked", save)
            entry.connect("activate", save)
            window.set_child(outer)

        def show_status(self, window):
            self.clear_refresh()
            self.service("start")

            outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
            outer.set_margin_top(32)
            outer.set_margin_bottom(32)
            outer.set_margin_start(32)
            outer.set_margin_end(32)

            title = Gtk.Label(label="Draftside connection status")
            title.add_css_class("title-1")
            title.set_wrap(True)
            title.set_xalign(0)
            outer.append(title)

            subtitle = Gtk.Label(
                label="Use the ESPN draft room in the separate Chrome window opened by Draftside."
            )
            subtitle.set_wrap(True)
            subtitle.set_xalign(0)
            outer.append(subtitle)

            selected_board = Gtk.Label(label="No draft board selected yet")
            selected_board.add_css_class("dim-label")
            selected_board.set_wrap(True)
            selected_board.set_xalign(0)
            outer.append(selected_board)

            card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
            card.add_css_class("card")
            card.set_margin_top(8)
            card.set_margin_bottom(8)
            status = Gtk.Label(label="Starting…")
            status.add_css_class("title-2")
            status.set_xalign(0)
            detail = Gtk.Label(label="Opening the private dashboard and ESPN draft room.")
            detail.set_wrap(True)
            detail.set_xalign(0)
            checklist = Gtk.Label(label="")
            checklist.set_wrap(True)
            checklist.set_xalign(0)
            checklist.set_margin_top(6)
            activity = Gtk.Label(label="Status updates automatically.")
            activity.add_css_class("dim-label")
            activity.set_xalign(0)
            card.append(status)
            card.append(detail)
            card.append(checklist)
            card.append(activity)
            outer.append(card)

            actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            dashboard = Gtk.Button(label="Open Draft Board")
            dashboard.add_css_class("suggested-action")
            dashboard.set_sensitive(False)
            change_draft = Gtk.Button(label="Change Draft")
            change_draft.set_visible(False)
            reconnect = Gtk.Button(label="Reconnect")
            stop = Gtk.Button(label="Stop Draftside")
            change = Gtk.Button(label="Change Dashboard")
            actions.append(dashboard)
            actions.append(change_draft)
            actions.append(reconnect)
            outer.append(actions)

            secondary_actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            secondary_actions.append(stop)
            secondary_actions.append(change)
            outer.append(secondary_actions)

            close_note = Gtk.Label(
                label="Closing this window stops Draftside and its Chrome window."
            )
            close_note.add_css_class("dim-label")
            close_note.set_wrap(True)
            close_note.set_xalign(0)
            outer.append(close_note)

            picker = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
            picker_title = Gtk.Label(label="Which draft room are you using?")
            picker_title.add_css_class("title-2")
            picker_title.set_xalign(0)
            picker.append(picker_title)
            picker_help = Gtk.Label(
                label="Draftside found more than one possible board. Choose one to continue."
            )
            picker_help.set_wrap(True)
            picker_help.set_xalign(0)
            picker.append(picker_help)
            picker_buttons = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
            picker.append(picker_buttons)
            picker.set_visible(False)
            outer.append(picker)

            def open_dashboard(_button):
                configured = _board_url(_read_health().get("dashboardUrl"))
                if configured is not None:
                    Gio.AppInfo.launch_default_for_uri(configured, None)

            def restart(_button):
                self.service("restart")
                status.set_label("Restarting connections…")
                detail.set_label("Draftside is reconnecting to your dashboard and ESPN.")

            def stop_service(_button):
                self.service("stop")
                status.set_label("Stopped")
                detail.set_label(
                    "Draftside and its Chrome window are stopped. No draft information is being sent."
                )

            def redetect_draft(_button):
                try:
                    _selection_path().unlink()
                except FileNotFoundError:
                    pass
                self.service("restart")
                dashboard.set_sensitive(False)
                change_draft.set_visible(False)
                picker.set_visible(False)
                selected_board.set_label("Looking for the draft room you have open…")
                status.set_label("Finding your draft…")
                detail.set_label("Keep the ESPN draft room you want open in Draftside Chrome.")

            def change_dashboard(_button):
                self.show_setup(window)

            dashboard.connect("clicked", open_dashboard)
            change_draft.connect("clicked", redetect_draft)
            reconnect.connect("clicked", restart)
            stop.connect("clicked", stop_service)
            change.connect("clicked", change_dashboard)

            labels = {
                "starting": ("Starting…", "Preparing the Draftside connections."),
                "connecting_dashboard": (
                    "Connecting to your private dashboard…",
                    "Confirming this laptop with your Draftside deployment.",
                ),
                "waiting_for_draft_room": (
                    "Open your ESPN draft room",
                    "The draft board button will become available after Draftside identifies that room.",
                ),
                "draft_selection_required": (
                    "Choose your draft",
                    "More than one initialized board could match the open ESPN draft room.",
                ),
                "draft_not_initialized": (
                    "This draft has no board yet",
                    "Initialize this ESPN draft on the private dashboard, then click Reconnect.",
                ),
                "draft_room_unidentified": (
                    "Still identifying this draft room",
                    "Leave the ESPN draft room open. Draftside will keep checking it safely.",
                ),
                "no_initialized_draft": (
                    "No draft boards are initialized",
                    "Initialize a draft on the private dashboard, then click Reconnect.",
                ),
                "chrome_unavailable": (
                    "Draftside Chrome is unavailable",
                    "Click Reconnect to reopen Chrome, then open your ESPN draft room.",
                ),
                "dashboard_unreachable": (
                    "Private dashboard is unavailable",
                    "Check your network and dashboard address. Draftside will keep retrying.",
                ),
                "delivery_rejected": (
                    "Dashboard rejected a draft update",
                    "Draftside will not reload ESPN while it reports the validation problem.",
                ),
                "live": ("Ready", "Draft picks are flowing to your private dashboard."),
                "reconnecting": (
                    "Draft connection interrupted",
                    "Draftside is retrying and will recover the complete board automatically.",
                ),
                "complete": ("Draft complete", "The complete board has been delivered."),
                "stopped": ("Stopped", "No draft information is being sent."),
                "revoked": ("Access revoked", "Re-enable this laptop from the private dashboard."),
            }
            rendered_options = None
            selection_pending = False
            automatically_opened_url = None

            def render_options(options):
                nonlocal rendered_options
                safe_options = []
                if isinstance(options, list):
                    for option in options:
                        if not isinstance(option, dict):
                            continue
                        key, name = option.get("draftKey"), option.get("displayName")
                        season, league = option.get("season"), option.get("leagueId")
                        if (
                            isinstance(key, str)
                            and isinstance(name, str)
                            and isinstance(season, int)
                            and isinstance(league, str)
                        ):
                            safe_options.append((key, name, season, league))
                signature = tuple(safe_options)
                if signature == rendered_options:
                    return
                rendered_options = signature
                child = picker_buttons.get_first_child()
                while child is not None:
                    following = child.get_next_sibling()
                    picker_buttons.remove(child)
                    child = following
                for key, name, season, league in safe_options:
                    choice = Gtk.Button(label=f"{name} · {season} · League {league}")

                    def select(_button, draft_key=key):
                        nonlocal selection_pending
                        try:
                            _write_draft_selection(draft_key)
                        except (OSError, ValueError) as problem:
                            detail.set_label(str(problem))
                            return
                        selection_pending = True
                        picker.set_visible(False)
                        status.set_label("Switching draft…")
                        detail.set_label("Draftside is connecting to the selected ESPN room.")

                    choice.connect("clicked", select)
                    picker_buttons.append(choice)

            def refresh():
                nonlocal automatically_opened_url, selection_pending
                health = _read_health()
                state = str(health.get("state", "starting"))
                if state != "draft_selection_required":
                    selection_pending = False
                dashboard_url = _board_url(health.get("dashboardUrl"))
                dashboard.set_sensitive(dashboard_url is not None)
                automatic_url = _automatic_board_url(health, automatically_opened_url)
                if automatic_url is not None:
                    automatically_opened_url = automatic_url
                    try:
                        Gio.AppInfo.launch_default_for_uri(automatic_url, None)
                    except GLib.Error:
                        pass
                selected = health.get("selectedDraft")
                if isinstance(selected, dict) and isinstance(selected.get("displayName"), str):
                    season = selected.get("season")
                    selected_board.set_label(
                        f"Current board: {selected['displayName']}"
                        + (f" · {season}" if isinstance(season, int) else "")
                    )
                    change_draft.set_visible(True)
                else:
                    selected_board.set_label("No draft board selected yet")
                    change_draft.set_visible(False)
                render_options(health.get("draftOptions"))
                picker.set_visible(state == "draft_selection_required" and not selection_pending)
                headline, copy = labels.get(
                    state,
                    (
                        "Needs attention",
                        str(health.get("message", "Open Draftside again to retry.")),
                    ),
                )
                if selection_pending and state == "draft_selection_required":
                    headline = "Switching draft…"
                    copy = "Draftside is connecting to the selected ESPN room."
                status.set_label(headline)
                filled, total = health.get("filledPicks"), health.get("totalPicks")
                if (
                    isinstance(filled, int)
                    and isinstance(total, int)
                    and state in {"live", "complete"}
                ):
                    copy = f"{filled} of {total} picks received. {copy}"
                detail.set_label(copy)
                dashboard_state = (
                    "Access revoked"
                    if state == "revoked"
                    else "Unavailable"
                    if state == "dashboard_unreachable"
                    else "Connecting"
                    if state in {"starting", "connecting_dashboard"}
                    else "Connected"
                )
                chrome_state = (
                    "Unavailable"
                    if state == "chrome_unavailable"
                    else "Stopped"
                    if state == "stopped"
                    else "Open"
                )
                draft_state = (
                    "Connected"
                    if state in {"live", "complete", "delivery_rejected"}
                    else "Waiting for you"
                    if state == "waiting_for_draft_room"
                    else "Stopped"
                    if state == "stopped"
                    else "Not connected"
                )
                checklist.set_label(
                    "\n".join(
                        (
                            f"Private dashboard: {dashboard_state}",
                            f"Draftside Chrome: {chrome_state}",
                            f"ESPN draft room: {draft_state}",
                        )
                    )
                )
                checks = health.get("reconnects")
                activity.set_label(
                    f"Connection checks: {checks}. Status updates automatically."
                    if isinstance(checks, int) and checks > 0
                    else "Status updates automatically."
                )
                return GLib.SOURCE_CONTINUE

            refresh()
            self.refresh_source = GLib.timeout_add_seconds(1, refresh)
            scroll = Gtk.ScrolledWindow()
            scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            scroll.set_child(outer)
            window.set_child(scroll)

        def do_activate(self):
            self.reload_units()
            self.retire_legacy_service()
            window = Gtk.ApplicationWindow(application=self)
            window.set_title("Draftside Companion")
            window.set_default_size(680, 560)

            def close_window(_window):
                self.clear_refresh()
                self.service("stop")
                return False

            window.connect("close-request", close_window)
            if dashboard_setup_required(_config_path()):
                self.show_setup(window)
            else:
                self.show_status(window)
            window.present()

    return DraftsideApp().run(None)


if __name__ == "__main__":
    raise SystemExit(main())
