from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from . import __version__
from .credentials import Credentials, DeviceCredentials


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def signed_headers(
    secret: str, pathname: str, body: bytes, timestamp: int, nonce: str
) -> dict[str, str]:
    body_hash = hashlib.sha256(body).hexdigest()
    material = f"{timestamp}\n{nonce}\nPOST\n{pathname}\n{body_hash}".encode()
    signature = hmac.new(secret.encode(), material, hashlib.sha256).hexdigest()
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": f"Draftside-Companion/{__version__}",
        "X-Draft-Timestamp": str(timestamp),
        "X-Draft-Nonce": nonce,
        "X-Draft-Signature": f"v1={signature}",
    }


class WorkerError(RuntimeError):
    pass


class WorkerClient:
    def __init__(
        self,
        worker_base: str,
        draft_key: str,
        credentials: Credentials,
        timeout: float,
        *,
        opener=urllib.request.urlopen,
        clock=time.time,
        uuid4=uuid.uuid4,
    ):
        self.base, self.draft_key, self.credentials, self.timeout = (
            worker_base.rstrip("/"),
            draft_key,
            credentials,
            timeout,
        )
        self.opener, self.clock, self.uuid4 = opener, clock, uuid4
        self.instance_id = str(uuid4())

    def health(self) -> Mapping[str, Any]:
        headers = {
            "Accept": "application/json",
            "User-Agent": "Draftside-Companion/0.1",
            "CF-Access-Client-Id": self.credentials.access_client_id,
            "CF-Access-Client-Secret": self.credentials.access_client_secret,
        }
        request = urllib.request.Request(self.base + "/healthz", headers=headers, method="GET")
        try:
            with self.opener(request, timeout=self.timeout) as response:
                result = json.load(response)
                server_date = response.headers.get("Date") if hasattr(response, "headers") else None
        except urllib.error.HTTPError as error:
            raise WorkerError(f"worker_health_http_{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            raise WorkerError("worker_health_network_error") from None
        if not isinstance(result, Mapping) or result.get("ok") is not True:
            raise WorkerError("worker_health_invalid_ack")
        if server_date:
            try:
                drift = abs(self.clock() - parsedate_to_datetime(server_date).timestamp())
            except (TypeError, ValueError, OverflowError):
                raise WorkerError("worker_health_invalid_date") from None
            if drift > 30:
                raise WorkerError("worker_clock_skew")
        return result

    def _post(self, action: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        encoded_key = urllib.parse.quote(self.draft_key, safe="")
        pathname = f"/api/v1/drafts/{encoded_key}/{action}"
        body = canonical_json(payload)
        headers = signed_headers(
            self.credentials.ingest_hmac, pathname, body, int(self.clock()), str(self.uuid4())
        )
        headers["CF-Access-Client-Id"] = self.credentials.access_client_id
        headers["CF-Access-Client-Secret"] = self.credentials.access_client_secret
        request = urllib.request.Request(
            self.base + pathname, data=body, headers=headers, method="POST"
        )
        try:
            with self.opener(request, timeout=self.timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise WorkerError(f"worker_{action}_http_{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            raise WorkerError(f"worker_{action}_network_error") from None
        if not isinstance(result, Mapping):
            raise WorkerError(f"worker_{action}_invalid_ack")
        return result

    def initialize(self, payload: Mapping[str, Any]) -> None:
        if payload.get("schemaVersion") != 1 or payload.get("draftKey") != self.draft_key:
            raise ValueError("draft initializer does not match configured draft")
        ack = self._post("initialize", payload)
        if not isinstance(ack.get("revision"), int) or not isinstance(ack.get("created"), bool):
            raise WorkerError("worker_initialize_invalid_ack")

    def _events(
        self, picks: Mapping[int, Mapping[str, int]], observed_at: str
    ) -> list[dict[str, Any]]:
        events = []
        for overall in sorted(picks):
            pick = picks[overall]
            identity = {
                "draftKey": self.draft_key,
                "overallPick": overall,
                "teamId": str(pick["teamId"]),
                "playerId": str(pick["playerId"]),
            }
            events.append(
                {
                    "schemaVersion": 1,
                    "eventId": hashlib.sha256(canonical_json(identity)).hexdigest(),
                    "overallPick": overall,
                    "round": int(pick["round"]),
                    "roundPick": int(pick["roundPick"]),
                    "teamId": str(pick["teamId"]),
                    "playerId": str(pick["playerId"]),
                    "source": "espn",
                    "providerObservedAt": None,
                    "ingestorObservedAt": observed_at,
                }
            )
        return events

    def ingest(
        self, picks: Mapping[int, Mapping[str, int]], total: int, complete: bool, observed_at: str
    ) -> Mapping[str, Any]:
        events = self._events(picks, observed_at)
        final: Mapping[str, Any] = {}
        parts = [events[i : i + 100] for i in range(0, len(events), 100)] or [[]]
        for index, part in enumerate(parts):
            final_part = index == len(parts) - 1
            part_cursor = int(part[-1]["overallPick"]) if part else max(picks, default=0)
            payload = {
                "schemaVersion": 1,
                "draftKey": self.draft_key,
                "ingestorInstanceId": self.instance_id,
                "capturedAt": observed_at,
                "cursor": {"lastOverallPick": total if complete and final_part else part_cursor},
                "draftState": {
                    "inProgress": not (complete and final_part),
                    "drafted": complete and final_part,
                    "totalPickSlots": total,
                },
                "events": part,
            }
            final = self._post("ingest", payload)
            accepted, deduped = final.get("accepted"), final.get("deduped")
            if (
                not isinstance(final.get("revision"), int)
                or not isinstance(accepted, int)
                or not isinstance(deduped, int)
            ):
                raise WorkerError("worker_ingest_invalid_ack")
            if accepted + deduped != len(part):
                raise WorkerError("worker_ingest_partial_ack")
        missing = final.get("missingOverallPicks", [])
        if not isinstance(missing, list) or any(value in picks for value in missing):
            raise WorkerError("worker_ingest_gap_recovery_failed")
        return final

    def heartbeat(
        self, last_overall_pick: int, total: int, complete: bool = False
    ) -> Mapping[str, Any]:
        observed_at = utc_now()
        payload = {
            "schemaVersion": 1,
            "draftKey": self.draft_key,
            "ingestorInstanceId": self.instance_id,
            "capturedAt": observed_at,
            "cursor": {"lastOverallPick": last_overall_pick},
            "draftState": {
                "inProgress": not complete,
                "drafted": complete,
                "totalPickSlots": total,
            },
            "events": [],
        }
        ack = self._post("ingest", payload)
        if (
            not isinstance(ack.get("revision"), int)
            or ack.get("accepted") != 0
            or ack.get("deduped") != 0
            or not isinstance(ack.get("missingOverallPicks"), list)
        ):
            raise WorkerError("worker_heartbeat_invalid_ack")
        return ack


class DeviceWorkerClient(WorkerClient):
    """Per-install client that enrolls itself without shared service credentials."""

    def __init__(
        self,
        worker_base: str,
        credentials: DeviceCredentials,
        timeout: float,
        *,
        opener=urllib.request.urlopen,
        clock=time.time,
        uuid4=uuid.uuid4,
    ):
        self.device = credentials
        super().__init__(
            worker_base,
            "",
            Credentials(credentials.device_token, "", ""),
            timeout,
            opener=opener,
            clock=clock,
            uuid4=uuid4,
        )

    def _device_headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.device.device_token}",
            "Content-Type": "application/json",
            "User-Agent": f"Draftside-Companion/{__version__}",
            "X-Draftside-Device": self.device.device_id,
        }

    def enroll(self, name: str, version: str) -> Mapping[str, Any]:
        body = canonical_json({"name": name[:80], "version": version[:32]})
        request = urllib.request.Request(
            self.base + "/api/v1/companion/register",
            data=body,
            headers=self._device_headers(),
            method="POST",
        )
        try:
            with self.opener(request, timeout=self.timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 403:
                raise WorkerError("device_revoked") from None
            raise WorkerError(f"device_enrollment_http_{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            raise WorkerError("device_enrollment_network_error") from None
        bootstrap = result.get("bootstrap") if isinstance(result, Mapping) else None
        required = ("draftKey", "expectedTeams", "totalPickSlots", "draftSlotTeamIds", "draftUrl")
        if not isinstance(bootstrap, Mapping) or any(key not in bootstrap for key in required):
            raise WorkerError("device_enrollment_invalid_ack")
        if (
            not isinstance(bootstrap["draftKey"], str)
            or not isinstance(bootstrap["expectedTeams"], int)
            or not isinstance(bootstrap["totalPickSlots"], int)
            or not isinstance(bootstrap["draftSlotTeamIds"], list)
            or len(bootstrap["draftSlotTeamIds"]) != bootstrap["totalPickSlots"]
            or not isinstance(bootstrap["draftUrl"], str)
        ):
            raise WorkerError("device_enrollment_invalid_ack")
        self.draft_key = bootstrap["draftKey"]
        return bootstrap

    def health(self) -> Mapping[str, Any]:
        raise WorkerError("device_health_requires_enrollment")

    def _post(self, action: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        if action != "ingest":
            raise WorkerError("device_action_not_supported")
        encoded_key = urllib.parse.quote(self.draft_key, safe="")
        pathname = f"/api/v1/drafts/{encoded_key}/companion-ingest"
        body = canonical_json(payload)
        headers = self._device_headers()
        headers.update(
            signed_headers(
                self.device.device_token,
                pathname,
                body,
                int(self.clock()),
                str(self.uuid4()),
            )
        )
        request = urllib.request.Request(
            self.base + pathname, data=body, headers=headers, method="POST"
        )
        try:
            with self.opener(request, timeout=self.timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 403:
                raise WorkerError("device_revoked") from None
            raise WorkerError(f"worker_{action}_http_{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            raise WorkerError(f"worker_{action}_network_error") from None
        if not isinstance(result, Mapping):
            raise WorkerError(f"worker_{action}_invalid_ack")
        return result

    def initialize(self, payload: Mapping[str, Any]) -> None:
        if payload.get("draftKey") != self.draft_key:
            raise ValueError("bootstrap does not match enrolled draft")
