"""A1-A12 against the in-process v2 bridge. Live Forge is --live."""

from ml_engine.scripts.policy_control import ScriptedV2, evaluate, format_lines, main


def test_live_flag_does_not_run_the_mock():
    assert main(["--live"]) == 1


def test_acceptance_criteria_pass_at_full_sample_size():
    results = evaluate(ScriptedV2(), episodes=200, illegal=1000, pairs=20)
    failed = [line for line in format_lines(results) if ": FAIL" in line]
    assert failed == []
    assert results["A5"]["held"] == 1000
    assert results["A2"]["policy_control_lost"] == 0
    assert results["A11"]["identical"] == 20
