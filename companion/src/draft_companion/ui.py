from __future__ import annotations

import json
import os
import subprocess
import webbrowser
from pathlib import Path


def _health_path() -> Path:
    state_home = Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser()
    return state_home / "draftside-companion/health.json"


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
        from gi.repository import GLib, Gtk
    except (ImportError, ValueError) as error:
        raise SystemExit(f"Draftside's desktop interface is unavailable: {error}") from error

    subprocess.run(
        ["systemctl", "--user", "enable", "--now", "draftside-companion.service"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    class DraftsideApp(Gtk.Application):
        def __init__(self):
            super().__init__(application_id="com.draftside.Companion")

        def do_activate(self):
            window = Gtk.ApplicationWindow(application=self)
            window.set_title("Draftside Companion")
            window.set_default_size(520, 360)

            outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
            outer.set_margin_top(32)
            outer.set_margin_bottom(32)
            outer.set_margin_start(32)
            outer.set_margin_end(32)

            title = Gtk.Label(label="Draftside is getting your war room ready")
            title.add_css_class("title-1")
            title.set_wrap(True)
            title.set_xalign(0)
            outer.append(title)

            subtitle = Gtk.Label(
                label="Keep this laptop awake with the ESPN draft room open. Draftside connects automatically."
            )
            subtitle.set_wrap(True)
            subtitle.set_xalign(0)
            outer.append(subtitle)

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
            card.append(status)
            card.append(detail)
            outer.append(card)

            actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            dashboard = Gtk.Button(label="Open Draft Dashboard")
            dashboard.add_css_class("suggested-action")
            reconnect = Gtk.Button(label="Reconnect")
            stop = Gtk.Button(label="Stop")
            actions.append(dashboard)
            actions.append(reconnect)
            actions.append(stop)
            outer.append(actions)

            def open_dashboard(_button):
                configured = _read_health().get("dashboardUrl")
                if isinstance(configured, str) and configured.startswith("https://"):
                    webbrowser.open(configured)

            def restart(_button):
                subprocess.run(
                    ["systemctl", "--user", "restart", "draftside-companion.service"],
                    check=False,
                )
                status.set_label("Reconnecting…")
                detail.set_label("Draftside will recover the complete board automatically.")

            def stop_service(_button):
                subprocess.run(
                    ["systemctl", "--user", "stop", "draftside-companion.service"],
                    check=False,
                )
                status.set_label("Stopped")
                detail.set_label("No draft information is being sent.")

            dashboard.connect("clicked", open_dashboard)
            reconnect.connect("clicked", restart)
            stop.connect("clicked", stop_service)

            labels = {
                "starting": ("Connecting automatically…", "Waiting for the ESPN draft room."),
                "live": ("Ready", "Draft picks are flowing to your private dashboard."),
                "reconnecting": ("Reconnecting…", "Recovering the complete board from ESPN."),
                "complete": ("Draft complete", "The complete board has been delivered."),
                "stopped": ("Stopped", "No draft information is being sent."),
                "revoked": ("Access revoked", "Re-enable this laptop from the private dashboard."),
            }
            dashboard_opened = False

            def refresh():
                nonlocal dashboard_opened
                health = _read_health()
                state = str(health.get("state", "starting"))
                dashboard_url = health.get("dashboardUrl")
                if (
                    not dashboard_opened
                    and isinstance(dashboard_url, str)
                    and dashboard_url.startswith("https://")
                ):
                    webbrowser.open(dashboard_url)
                    dashboard_opened = True
                headline, copy = labels.get(
                    state,
                    (
                        "Needs attention",
                        str(health.get("message", "Open Draftside again to retry.")),
                    ),
                )
                status.set_label(headline)
                filled, total = health.get("filledPicks"), health.get("totalPicks")
                if (
                    isinstance(filled, int)
                    and isinstance(total, int)
                    and state in {"live", "complete"}
                ):
                    copy = f"{filled} of {total} picks received. {copy}"
                detail.set_label(copy)
                return GLib.SOURCE_CONTINUE

            refresh()
            GLib.timeout_add_seconds(1, refresh)
            window.set_child(outer)
            window.present()

    return DraftsideApp().run(None)


if __name__ == "__main__":
    raise SystemExit(main())
