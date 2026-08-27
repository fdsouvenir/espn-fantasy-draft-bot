import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "check_research_sheet_contract.py"
SPEC = importlib.util.spec_from_file_location("check_research_sheet_contract", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class ResearchSheetContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(
            (ROOT / "config" / "research-vocabulary.json").read_text(encoding="utf-8")
        )

    def valid_values(self):
        values = {}
        for range_name, headers in module.expected_ranges(self.manifest).items():
            values[range_name] = [list(headers)]
        values[module.PUBLICATION_REVIEW_FORMULA_KEY] = (
            module.expected_publication_review_formulas(self.manifest)
        )
        lists = values["Lists!A1:V100"]
        row_count = 1 + max(
            len(self.manifest["workflowStatuses"]),
            len(self.manifest["publicationStatuses"]),
            sum(len(roles) for roles in self.manifest["rolesByPosition"].values()),
        )
        lists.extend([[""] * len(lists[0]) for _ in range(row_count - 1)])
        header = lists[0]
        roles = []
        for position in ("QB", "RB", "WR", "TE", "K", "D/ST"):
            for role in self.manifest["rolesByPosition"][position]:
                if role not in roles:
                    roles.append(role)
        roles.append("taxonomy-gap")
        for name, column_values in (
            ("all_researched_roles", roles),
            ("workflow_status", self.manifest["workflowStatuses"]),
            ("publication_status", self.manifest["publicationStatuses"]),
        ):
            index = header.index(name)
            for row_index, value in enumerate(column_values, 1):
                lists[row_index][index] = value
        for position, name in self.manifest["sheet"]["positionRoleListHeaders"].items():
            index = header.index(name)
            roles_for_position = [*self.manifest["rolesByPosition"][position], "taxonomy-gap"]
            for row_index, value in enumerate(roles_for_position, 1):
                lists[row_index][index] = value
        return values

    def test_accepts_matching_headers_and_vocabularies(self):
        self.assertEqual(module.check_contract(self.manifest, self.valid_values()), [])

    def test_source_selection_weights_cover_the_four_sheet_scores(self):
        rubric = self.manifest["sourceSelectionRubric"]
        score_headers = {
            header
            for header in self.manifest["sheet"]["workflowTabHeaders"]["Source Registry"]
            if header.endswith("_score") and header != "weighted_score"
        }
        self.assertEqual(set(rubric["weights"]), score_headers)
        self.assertAlmostEqual(sum(rubric["weights"].values()), 1.0)

    def test_accepts_ragged_google_value_rows(self):
        values = self.valid_values()
        values["Lists!A1:V100"] = [
            list(row[: max(1, next((index for index in range(len(row) - 1, -1, -1) if row[index]), 0) + 1)])
            for row in values["Lists!A1:V100"]
        ]
        self.assertEqual(module.check_contract(self.manifest, values), [])

    def test_reports_header_and_status_drift(self):
        values = self.valid_values()
        values["RB Profiles!A1:ZZ1"][0][-1] = "renamed"
        values["Player Synthesis!A1:ZZ1"][0][13] = "unknown_reason"
        publication_index = self.manifest["sheet"]["listsHeaders"].index("publication_status")
        values["Lists!A1:V100"][1][publication_index] = "working"
        errors = module.check_contract(self.manifest, values)
        self.assertTrue(any("RB Profiles" in error for error in errors))
        self.assertTrue(any("Player Synthesis" in error for error in errors))
        self.assertTrue(any("publication_status" in error for error in errors))

    def test_reports_publication_review_formula_drift(self):
        values = self.valid_values()
        values[module.PUBLICATION_REVIEW_FORMULA_KEY][3][0] = (
            values[module.PUBLICATION_REVIEW_FORMULA_KEY][3][0].replace("$2", "$19")
        )
        errors = module.check_contract(self.manifest, values)
        self.assertIn("Publication Review formulas differ from the manifest", errors)


if __name__ == "__main__":
    unittest.main()
