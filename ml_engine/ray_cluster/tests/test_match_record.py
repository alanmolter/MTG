"""forge_matches provenance parameters. No database required."""

from ml_engine.ray_cluster.match_record import INSERT_FORGE_MATCH, forge_match_params


def test_forge_match_params_keep_provenance_and_drop_bad_numbers():
    params = forge_match_params(
        agent_deck_id="burn",
        opponent_deck_id="control",
        seed="11",
        policy_version="checkpoints/bc.pt",
        pool_version="2",
        bridge_version="rlbridge-fase0",
        winner="1",
        turns=40,
    )
    assert params == (
        1, 40, "burn", "control", 11, "checkpoints/bc.pt", "2", "rlbridge-fase0",
    )
    blank = forge_match_params(
        agent_deck_id="  ",
        opponent_deck_id=None,
        seed="nope",
        policy_version=None,
        pool_version=None,
        bridge_version=None,
        winner="draw",
        turns=None,
    )
    assert blank == (None, None, None, None, None, None, None, None)
    for column in (
        "agent_deck_id", "opponent_deck_id", "seed",
        "policy_version", "pool_version", "bridge_version",
    ):
        assert column in INSERT_FORGE_MATCH
