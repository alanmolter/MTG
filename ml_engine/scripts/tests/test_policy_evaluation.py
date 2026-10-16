"""Tests for the policy-evaluation CLI input/output contract."""

from __future__ import annotations

import json

import pytest

from ml_engine.scripts.policy_evaluation import load_matchup_manifest
from ml_engine.ray_cluster.policy_evaluation import blocked_report, write_report


def test_manifest_parses_declared_holdout_and_training_hashes(tmp_path):
    manifest = tmp_path / "holdout.json"
    manifest.write_text(
        json.dumps(
            {
                "training_deck_hashes": ["abc", "def"],
                "matchups": [
                    {
                        "id": "unseen-control-vs-aggro",
                        "seed": 77,
                        "agent_deck": "4 Island",
                        "opponent_deck": "4 Mountain",
                        "split": "heldout",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    matchups, training_hashes = load_matchup_manifest(manifest)

    assert training_hashes == ["abc", "def"]
    assert len(matchups) == 1
    assert matchups[0].identifier == "unseen-control-vs-aggro"
    assert matchups[0].declared_heldout is True
    assert matchups[0].agent_deck_sha256 is not None


def test_manifest_rejects_duplicate_ids_and_missing_seed(tmp_path):
    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text(
        json.dumps(
            {"matchups": [{"id": "x", "seed": 1}, {"id": "x", "seed": 2}]}
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="duplicate matchup id"):
        load_matchup_manifest(duplicate)

    no_seed = tmp_path / "no-seed.json"
    no_seed.write_text(json.dumps({"matchups": [{"id": "x"}]}), encoding="utf-8")
    with pytest.raises(ValueError, match="needs integer seed"):
        load_matchup_manifest(no_seed)


def test_write_report_is_json_and_atomic_at_requested_path(tmp_path):
    target = tmp_path / "nested" / "report.json"
    result = write_report(
        blocked_report(checkpoint="missing", reason="test"), target
    )

    assert result == target.resolve()
    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["schema_version"] == "1.0"
    assert saved["status"] == "blocked"
    assert not target.with_suffix(".json.tmp").exists()
