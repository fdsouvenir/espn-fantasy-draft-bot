#!/usr/bin/env python3
"""Publish a Verl-authored research batch without interpreting Sheet data."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


MAX_PUBLICATION_BYTES = 2 * 1024 * 1024
USER_AGENT = "draftside-research-publisher/1"


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def load_publication(path: Path) -> dict[str, Any]:
    if path.stat().st_size > MAX_PUBLICATION_BYTES:
        raise ValueError("research publication exceeds 2 MiB")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("publication must be a ResearchPublicationV1 object")
    draft_key = value.get("draftKey")
    if not isinstance(draft_key, str) or not draft_key or len(draft_key) > 240:
        raise ValueError("publication has an invalid draftKey")
    if not isinstance(value.get("profiles"), list):
        raise ValueError("publication profiles must be a list")
    return value


def signed_headers(secret: str, pathname: str, body: bytes) -> dict[str, str]:
    timestamp = int(time.time())
    nonce = str(uuid.uuid4())
    body_hash = hashlib.sha256(body).hexdigest()
    material = f"{timestamp}\n{nonce}\nPOST\n{pathname}\n{body_hash}".encode()
    signature = hmac.new(secret.encode(), material, hashlib.sha256).hexdigest()
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Draft-Timestamp": str(timestamp),
        "X-Draft-Nonce": nonce,
        "X-Draft-Signature": f"v1={signature}",
    }
    client_id = os.environ.get("CF_ACCESS_CLIENT_ID")
    client_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    if client_id and client_secret:
        headers["CF-Access-Client-Id"] = client_id
        headers["CF-Access-Client-Secret"] = client_secret
    return headers


def publish(publication: dict[str, Any], worker_base: str, secret: str, timeout: float) -> dict[str, Any]:
    if len(secret) < 32:
        raise ValueError("RESEARCH_HMAC_CURRENT must contain at least 32 characters")
    parsed = urllib.parse.urlsplit(worker_base)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise ValueError("worker base must be an absolute HTTP(S) URL")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError("non-local research publication requires HTTPS")
    draft_key = str(publication["draftKey"])
    pathname = f"/api/v1/drafts/{urllib.parse.quote(draft_key, safe='')}/research"
    url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, pathname, "", ""))
    body = canonical_json(publication)
    request = urllib.request.Request(
        url,
        data=body,
        headers=signed_headers(secret, pathname, body),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
            code = payload.get("error", "publication_failed")
        except (UnicodeDecodeError, json.JSONDecodeError):
            code = "publication_failed"
        raise RuntimeError(f"research publication failed ({error.code}): {code}") from error
    if not isinstance(result, dict) or result.get("publicationId") != publication.get("publicationId"):
        raise RuntimeError("research publication returned an invalid acknowledgement")
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publication", type=Path, required=True)
    parser.add_argument("--worker-base", required=True)
    parser.add_argument("--timeout", type=float, default=15.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    secret = os.environ.get("RESEARCH_HMAC_CURRENT")
    if not secret:
        raise SystemExit("RESEARCH_HMAC_CURRENT is required")
    result = publish(load_publication(args.publication), args.worker_base, secret, args.timeout)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
