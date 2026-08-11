from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Credentials:
    ingest_hmac: str
    access_client_id: str
    access_client_secret: str


class KeyringLike(Protocol):
    def get_password(self, service_name: str, username: str) -> str | None: ...


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
