"""Fail-closed readiness gate for a costly Forge/Ray training run.

This short integration evaluation proves the contracts on which an RL result
depends: external policy control, a non-empty legal mask, a visible own hand,
and Forge transitions that respond inside the configured timeout.
"""
from __future__ import annotations

import json
import argparse
import sys
import time
from typing import Any, Mapping

import numpy as np

from ml_engine.ray_cluster.env import MtgForgeEnv


def first_legal_action(mask: Any) -> int:
    """Prefer a real spell choice; pass remains the safe fallback."""
    values = np.asarray(mask, dtype=np.int8).reshape(-1)
    candidates = np.flatnonzero(values[1:])
    return int(candidates[0] + 1) if candidates.size else 0


def _result(ok: bool, **fields: Any) -> int:
    print(json.dumps({"ok": ok, **fields}, indent=2), flush=True)
    return 0 if ok else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-gpus", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        import torch
        gpu_count = torch.cuda.device_count() if torch.cuda.is_available() else 0
    except Exception:
        gpu_count = 0
    if gpu_count < args.min_gpus:
        return _result(False, reason="insufficient_cuda_gpus", gpus=gpu_count,
                       min_gpus=args.min_gpus)

    env = MtgForgeEnv({
        "turn_limit": 12,
        "step_timeout": 15.0,
        "use_autoregressive_actions": False,
        "require_policy_control": True,
    })
    started = time.monotonic()
    try:
        obs, info = env.reset(seed=20261014)
        state: Mapping[str, Any] = info["state"]
        mask = obs["action_mask"]
        initial_hand_features = int(np.count_nonzero(obs["card_feats"][:, 11]))
        if not state.get("policy_controlled"):
            return _result(False, reason="external_policy_control_missing", gpus=gpu_count)
        if int(np.count_nonzero(mask)) < 1:
            return _result(False, reason="empty_legal_action_mask", gpus=gpu_count)
        if initial_hand_features < 1:
            return _result(False, reason="agent_hand_not_visible_in_observation", gpus=gpu_count)

        applied = 0
        non_pass_legal_seen = False
        action_trace: list[int] = []
        for _ in range(48):
            action = first_legal_action(obs["action_mask"])
            non_pass_legal_seen = non_pass_legal_seen or action > 0
            action_trace.append(action)
            obs, _, terminated, truncated, info = env.step(action)
            state = info.get("state", {})
            if state.get("policy_contract_violation"):
                return _result(False, reason="policy_contract_violation", gpus=gpu_count,
                               violation=state["policy_contract_violation"])
            if not state.get("policy_controlled"):
                return _result(False, reason="policy_action_not_applied", gpus=gpu_count, state=state)
            if not state.get("policy_action_applied"):
                return _result(False, reason="policy_action_not_applied", gpus=gpu_count,
                               decision=state.get("decision_type"),
                               violation=state.get("policy_contract_violation"))
            applied += 1
            if terminated or truncated:
                break

        if not non_pass_legal_seen:
            return _result(False, reason="no_non_pass_legal_actions", gpus=gpu_count)

        return _result(
            True,
            gpus=gpu_count,
            seconds=round(time.monotonic() - started, 3),
            applied_actions=applied,
            non_pass_legal_seen=non_pass_legal_seen,
            hand_feature_cards=initial_hand_features,
            final_turn=state.get("turn"),
            terminal=bool(state.get("terminal")),
            confirmed_policy_actions=applied,
            sample_actions=action_trace[:12],
            bootstrap_misses=0,
        )
    except Exception as exc:
        return _result(False, reason=type(exc).__name__, detail=str(exc), gpus=gpu_count)
    finally:
        env.close()


if __name__ == "__main__":
    sys.exit(main())
