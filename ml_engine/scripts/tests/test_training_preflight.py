import numpy as np

from ml_engine.scripts.training_preflight import first_legal_action


def test_prefers_lowest_legal_spell_over_pass():
    assert first_legal_action(np.array([1, 0, 1, 1], dtype=np.int8)) == 2


def test_falls_back_to_pass_when_no_spell_is_legal():
    assert first_legal_action(np.array([1, 0, 0], dtype=np.int8)) == 0
