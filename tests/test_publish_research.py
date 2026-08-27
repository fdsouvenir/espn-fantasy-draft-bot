import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "publish_research.py"
SPEC = importlib.util.spec_from_file_location("publish_research", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class ResearchPublisherTests(unittest.TestCase):
    publication = {
        "schemaVersion": 1,
        "draftKey": "local:espn:test",
        "publicationId": "pilot-1",
        "profiles": [],
    }

    def test_loads_only_a_bounded_publication_object(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "publication.json"
            path.write_text(json.dumps(self.publication), encoding="utf-8")
            self.assertEqual(module.load_publication(path), self.publication)
            path.write_text(json.dumps([]), encoding="utf-8")
            with self.assertRaises(ValueError):
                module.load_publication(path)

    @mock.patch.object(module.time, "time", return_value=1_700_000_000)
    @mock.patch.object(module.uuid, "uuid4", return_value="00000000-0000-4000-8000-000000000001")
    def test_signature_covers_the_exact_body_and_research_path(self, _uuid, _time):
        body = module.canonical_json(self.publication)
        headers = module.signed_headers("s" * 32, "/api/v1/drafts/d/research", body)
        body_hash = hashlib.sha256(body).hexdigest()
        self.assertEqual(headers["X-Draft-Timestamp"], "1700000000")
        self.assertTrue(headers["X-Draft-Signature"].startswith("v1="))
        self.assertIn(body_hash, f"1700000000\n00000000-0000-4000-8000-000000000001\nPOST\n/api/v1/drafts/d/research\n{body_hash}")

    def test_publishes_without_parsing_or_reclassifying_profiles(self):
        with mock.patch.object(module.urllib.request, "urlopen", return_value=Response({
            "publicationId": "pilot-1",
            "changed": True,
        })) as opened:
            result = module.publish(self.publication, "https://draftside.example", "s" * 32, 3)
        self.assertTrue(result["changed"])
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "https://draftside.example/api/v1/drafts/local%3Aespn%3Atest/research")
        self.assertEqual(json.loads(request.data), self.publication)

    def test_requires_https_away_from_localhost(self):
        with self.assertRaises(ValueError):
            module.publish(self.publication, "http://draftside.example", "s" * 32, 3)


if __name__ == "__main__":
    unittest.main()
