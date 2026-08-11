from __future__ import annotations

import json
import os
import subprocess
import webbrowser
from pathlib import Path

from .config import dashboard_candidate, dashboard_setup_required, write_device_config


def _config_path() -> Path:
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser()
    configured = os.environ.get(
        "DRAFTSIDE_CONFIG", str(config_home / "draftside-companion/companion.toml")
    )
    return Path(configured).expanduser()


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

    class DraftsideApp(Gtk.Application):
        def __init__(self):
            super().__init__(application_id="com.draftside.Companion")
            self.refresh_source = None

        @staticmethod
        def service(action: str):
            subprocess.run(
                ["systemctl", "--user", action, "draftside-companion.service"],
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
                self.service("enable")
                self.show_status(window)

            connect.connect("clicked", save)
            entry.connect("activate", save)
            window.set_child(outer)

        def show_status(self, window):
            self.clear_refresh()
            self.service("enable")
            self.service("restart")

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
                label="Use the ESPN draft room in the separate Chrome window opened by Draftside."
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
            change = Gtk.Button(label="Change Dashboard")
            actions.append(dashboard)
            actions.append(reconnect)
            actions.append(stop)
            actions.append(change)
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

            def change_dashboard(_button):
                self.show_setup(window)

            dashboard.connect("clicked", open_dashboard)
            reconnect.connect("clicked", restart)
            stop.connect("clicked", stop_service)
            change.connect("clicked", change_dashboard)

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
            self.refresh_source = GLib.timeout_add_seconds(1, refresh)
            window.set_child(outer)

        def do_activate(self):
            self.reload_units()
            window = Gtk.ApplicationWindow(application=self)
            window.set_title("Draftside Companion")
            window.set_default_size(620, 400)
            if dashboard_setup_required(_config_path()):
                self.show_setup(window)
            else:
                self.show_status(window)
            window.present()

    return DraftsideApp().run(None)


if __name__ == "__main__":
    raise SystemExit(main())
