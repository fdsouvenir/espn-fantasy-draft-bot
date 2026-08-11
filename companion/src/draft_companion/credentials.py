from __future__ import annotations

import os
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Credentials:
    ingest_hmac: str
    access_client_id: str
    access_client_secret: str


@dataclass(frozen=True)
class DeviceCredentials:
    device_id: str
    device_token: str


class KeyringLike(Protocol):
    def get_password(self, service_name: str, username: str) -> str | None: ...

    def set_password(self, service_name: str, username: str, password: str) -> None: ...

    def delete_password(self, service_name: str, username: str) -> None: ...


def _validate(values: Mapping[str, str | None]) -> Credentials:
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError("missing credentials: " + ", ".join(sorted(missing)))
    if len(str(values["INGEST_HMAC_CURRENT"])) < 32:
        raise RuntimeError("INGEST_HMAC_CURRENT must contain at least 32 characters")
    return Credentials(
        ingest_hmac=str(values["INGEST_HMAC_CURRENT"]),
        access_client_id=str(values["CF_ACCESS_CLIENT_ID"]),
        access_client_secret=str(values["CF_ACCESS_CLIENT_SECRET"]),
    )


def load_credentials(
    source: str,
    service: str,
    *,
    environ: Mapping[str, str] | None = None,
    keyring: KeyringLike | None = None,
) -> Credentials:
    names = ("INGEST_HMAC_CURRENT", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET")
    if source == "environment":
        env = environ if environ is not None else os.environ
        return _validate({name: env.get(name) for name in names})
    if source != "keyring":
        raise ValueError("unsupported credential source")
    if keyring is None:
        try:
            import keyring as imported_keyring
        except ImportError as error:
            raise RuntimeError("install the keyring extra to use OS keyring credentials") from error
        keyring = imported_keyring
    return _validate({name: keyring.get_password(service, name) for name in names})


def store_credentials(
    service: str,
    values: Mapping[str, str | None],
    *,
    keyring: KeyringLike | None = None,
) -> Credentials:
    credentials = _validate(values)
    if keyring is None:
        try:
            import keyring as imported_keyring
        except ImportError as error:
            raise RuntimeError(
                "install the keyring extra to store OS keyring credentials"
            ) from error
        keyring = imported_keyring
    updates = (
        ("INGEST_HMAC_CURRENT", credentials.ingest_hmac),
        ("CF_ACCESS_CLIENT_ID", credentials.access_client_id),
        ("CF_ACCESS_CLIENT_SECRET", credentials.access_client_secret),
    )
    previous = {name: keyring.get_password(service, name) for name, _value in updates}
    changed: list[str] = []
    try:
        for name, value in updates:
            keyring.set_password(service, name, value)
            changed.append(name)
    except Exception as error:
        rollback_failed = False
        for name in reversed(changed):
            try:
                if previous[name] is None:
                    keyring.delete_password(service, name)
                else:
                    keyring.set_password(service, name, previous[name])
            except Exception:  # noqa: BLE001 - attempt every rollback after backend errors
                rollback_failed = True
        message = (
            "credential storage failed and rollback was incomplete"
            if rollback_failed
            else "credential storage failed; previous values were restored"
        )
        raise RuntimeError(message) from error
    return credentials


def load_or_create_device(
    service: str,
    *,
    keyring: KeyringLike | None = None,
) -> DeviceCredentials:
    """Return this installation's revocable identity, creating it on first launch."""
    if keyring is None:
        try:
            import keyring as imported_keyring
        except ImportError as error:
            raise RuntimeError("install the keyring extra to store the device identity") from error
        keyring = imported_keyring
    device_id = keyring.get_password(service, "DEVICE_ID")
    device_token = keyring.get_password(service, "DEVICE_TOKEN")
    if device_id and device_token:
        try:
            uuid.UUID(device_id)
        except ValueError as error:
            raise RuntimeError("stored device identity is invalid") from error
        if len(device_token) < 32:
            raise RuntimeError("stored device token is invalid")
        return DeviceCredentials(device_id, device_token)
    if device_id or device_token:
        raise RuntimeError("stored device identity is incomplete")
    created = DeviceCredentials(str(uuid.uuid4()), secrets.token_urlsafe(32))
    changed: list[str] = []
    try:
        keyring.set_password(service, "DEVICE_ID", created.device_id)
        changed.append("DEVICE_ID")
        keyring.set_password(service, "DEVICE_TOKEN", created.device_token)
    except Exception as error:
        rollback_failed = False
        for name in reversed(changed):
            try:
                keyring.delete_password(service, name)
            except Exception:  # noqa: BLE001 - best-effort rollback across keyring backends
                rollback_failed = True
        message = (
            "device identity storage failed and rollback was incomplete"
            if rollback_failed
            else "device identity could not be stored"
        )
        raise RuntimeError(message) from error
    return created
