"""Live Forge matches for the phase-1 review. This does not use ScriptedV2."""

from __future__ import annotations

import argparse
import collections
import os
import sys

from ml_engine.bc.record import SubprocessBridge, record_match
from ml_engine.ray_cluster.env import MtgForgeEnv
from ml_engine.scripts.policy_control import _bundled_deck, evaluate_live, format_lines


def reset_probe(env: MtgForgeEnv, n: int) -> tuple[int, int]:
    """Reset n times while a game is in progress. Returns (ok, fail)."""

    ok = fail = 0
    for i in range(n):
        try:
            _obs, info = env.reset(seed=5000 + i)
        except Exception as exc:
            print(f"RESET_FAIL {i} {type(exc).__name__} {exc}", flush=True)
            fail += 1
            continue
        state = info.get("state") or {}
        leaked = bool(state.get("terminal")) and not bool(state.get("policy_controlled"))
        if leaked or not state.get("policy_controlled"):
            print(f"RESET_LEAK {i} terminal={state.get('terminal')} "
                  f"policy_controlled={state.get('policy_controlled')} "
                  f"kind={state.get('decision_kind')}", flush=True)
            fail += 1
            continue
        ok += 1
        mask = state.get("action_mask") or [1]
        legal = [j for j, bit in enumerate(mask) if bit == 1]
        try:
            env.step(legal[0] if legal else 0)
        except Exception as exc:
            print(f"RESET_STEP_FAIL {i} {exc}", flush=True)
            fail += 1
            ok -= 1
    return ok, fail


def bc_distribution(forge_jar: str, bridge_jar: str, games: int, turn_steps: int) -> dict:
    agent = _bundled_deck("q05_mono_red_aggro.txt")
    opponent = _bundled_deck("q05_mono_green_stompy.txt")
    bridge = SubprocessBridge(forge_jar, bridge_jar, java=os.environ.get("JAVA_BIN", "java"))
    by_kind: dict[str, collections.Counter] = {}
    try:
        for i in range(games):
            rows, _seen = record_match(
                bridge,
                agent_deck=agent,
                opponent_deck=opponent,
                seed=7000 + i,
                deck_id="q05_mono_red_aggro",
                opponent_id="q05_mono_green_stompy",
                split="train",
                max_steps=turn_steps,
            )
            for row in rows:
                kind = str(row.get("decision_kind") or "unknown")
                by_kind.setdefault(kind, collections.Counter())
                by_kind[kind][int(row["action"])] += 1
    finally:
        bridge.close()
    return {kind: dict(counts) for kind, counts in by_kind.items()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--episodes", type=int, default=20)
    parser.add_argument("--resets", type=int, default=10)
    parser.add_argument("--bc-games", type=int, default=4)
    parser.add_argument("--turn-limit", type=int, default=30)
    parser.add_argument("--forge-jar", default=os.environ.get("FORGE_JAR", ""))
    parser.add_argument("--bridge-jar", default=os.environ.get("FORGE_BRIDGE_JAR", ""))
    parser.add_argument("--assets-dir", default=os.environ.get("FORGE_ASSETS_DIR"))
    args = parser.parse_args(argv)
    if not args.forge_jar or not args.bridge_jar:
        print("FORGE_JAR and FORGE_BRIDGE_JAR are required", file=sys.stderr)
        return 1
    os.environ["FORGE_MATCH_RECORD"] = "0"
    agent = _bundled_deck("q05_mono_red_aggro.txt")
    opponent = _bundled_deck("q05_mono_green_stompy.txt")
    env = MtgForgeEnv({
        "forge_jar": args.forge_jar,
        "bridge_jar": args.bridge_jar,
        "forge_assets_dir": args.assets_dir,
        "java_bin": os.environ.get("JAVA_BIN", "java"),
        "agent_deck": agent,
        "opponent_deck": opponent,
        "turn_limit": args.turn_limit,
        "agent_policy": "external",
        "strict_protocol": True,
        "seed_python_rngs": False,
    })
    try:
        ok, fail = reset_probe(env, args.resets)
    finally:
        env.close()
    print(f"RESETS ok={ok} fail={fail} of {args.resets}", flush=True)
    results = evaluate_live(
        forge_jar=args.forge_jar,
        bridge_jar=args.bridge_jar,
        assets_dir=args.assets_dir,
        episodes=args.episodes,
        illegal=min(20, args.episodes),
        turn_limit=args.turn_limit,
    )
    print("LIVE", flush=True)
    for line in format_lines(results):
        print(line, flush=True)
    labels = bc_distribution(args.forge_jar, args.bridge_jar, args.bc_games, turn_steps=80)
    print("BC_LABELS", labels, flush=True)
    required = ("A1", "A2", "A4", "A5", "A8", "A9")
    live_ok = all(results[key].get("ok") for key in required)
    return 0 if ok == args.resets and live_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
