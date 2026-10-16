"""Stages of the Windows end-to-end smoke, each printing PASS or FAIL.

Docker and the rlbridge rebuild are started by ``scripts/e2e-preflight.ps1``.
This module is the part that can run under pytest: deck pools, a short
behavior-cloning record/train, one anchored RL step, and holdout eval.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from ml_engine.bc.actions import unmappable_rate
from ml_engine.models.game_state_gnn import GNNConfig


SMOKE_GNN = GNNConfig(hidden_dim=8, num_layers=1, num_heads=2, action_context_dim=4)


def _line(stage: str, ok: bool, **detail) -> dict:
    status = "PASS" if ok else "FAIL"
    payload = {"stage": stage, "status": status, **detail}
    print(f"{stage}: {status}" + (f" {json.dumps(detail)}" if detail else ""), flush=True)
    return payload


def stage_decks(version: str = "2") -> dict:
    from ml_engine.ray_cluster.deck_pool import decks_for_split, load_pool

    try:
        v1 = load_pool("1")
        v2 = load_pool(version)
        train = decks_for_split("train", version)
        holdout = decks_for_split("holdout", version)
        benchmark = decks_for_split("benchmark", version)
        ok = len(v1) >= 2 and len(train) >= 2 and len(holdout) >= 1 and len(benchmark) >= 1
        return _line(
            "decks",
            ok,
            v1=len(v1),
            v2=len(v2),
            train=len(train),
            holdout=len(holdout),
            benchmark=len(benchmark),
        )
    except Exception as exc:
        return _line("decks", False, error=str(exc))


def _forge_jars() -> tuple[Path, Path]:
    forge = Path(os.environ.get(
        "FORGE_JAR",
        "forge/forge-gui-desktop/target/forge-gui-desktop-2.0.12-SNAPSHOT-jar-with-dependencies.jar",
    ))
    bridge = Path(os.environ.get("FORGE_BRIDGE_JAR", "forge/rlbridge/target/rlbridge.jar"))
    return forge, bridge


def stage_bc(work: Path, *, epochs: int = 1, max_steps: int = 12) -> dict:
    """Record one AI-vs-AI game, train, take one KL-regularized step, eval."""

    from ml_engine.bc.dataset import load_rows
    from ml_engine.bc.eval import evaluate_checkpoint
    from ml_engine.bc.record import SubprocessBridge, record_games
    from ml_engine.bc.regularize import anchored_rl_step, kl_coeff_for_iter, load_anchor
    from ml_engine.bc.train import train_behavior_clone
    from ml_engine.ray_cluster.deck_pool import active_pool_version, decks_for_split

    forge, bridge_jar = _forge_jars()
    if not forge.is_file() or not bridge_jar.is_file():
        return _line(
            "bc",
            False,
            error="forge or rlbridge jar missing; rebuild rlbridge against Forge first",
            forge=str(forge),
            bridge=str(bridge_jar),
        )
    try:
        version = active_pool_version()
        train_decks = decks_for_split("train", version)
        hold_decks = decks_for_split("holdout", version) or decks_for_split("benchmark", version)
        matchups = [
            {
                "agent_deck": train_decks[0].forge_list,
                "opponent_deck": train_decks[1].forge_list,
                "seed": 7,
                "deck_id": train_decks[0].deck_id,
                "opponent_id": train_decks[1].deck_id,
                "split": "train",
            },
            {
                "agent_deck": hold_decks[0].forge_list,
                "opponent_deck": hold_decks[min(1, len(hold_decks) - 1)].forge_list,
                "seed": 8,
                "deck_id": hold_decks[0].deck_id,
                "opponent_id": hold_decks[min(1, len(hold_decks) - 1)].deck_id,
                "split": "holdout",
            },
        ]
        bridge = SubprocessBridge(forge, bridge_jar)
        try:
            report = record_games(bridge, matchups, work / "shards" / "smoke.jsonl", max_steps=max_steps)
        finally:
            bridge.close()
        if report.mapped < 1:
            return _line("bc", False, error="no mapped AI decisions", **report.as_dict())
        trained = train_behavior_clone(
            work / "shards", work / "bc.pt", epochs=epochs, max_rows=8, config=SMOKE_GNN,
            pool_version=version,
        )
        train_rows = load_rows(work / "shards", split="train")
        hold_rows = load_rows(work / "shards", split="holdout")
        train_games = {str(row.get("game_id") or "") for row in train_rows}
        hold_games = {str(row.get("game_id") or "") for row in hold_rows}
        if not train_games or not hold_games or not train_games.isdisjoint(hold_games):
            return _line(
                "bc",
                False,
                error="train and holdout game_ids overlap or a split is empty",
                train_games=sorted(train_games),
                hold_games=sorted(hold_games),
            )
        rows = train_rows
        from ml_engine.models.game_state_gnn import GameStateGNN
        from ml_engine.bc.train import load_bc_weights

        model = GameStateGNN(SMOKE_GNN)
        load_bc_weights(model, work / "bc.pt")
        anchor = load_anchor(work / "bc.pt", SMOKE_GNN)
        coeff = kl_coeff_for_iter(0, bc_kl_coeff=0.5, bc_kl_iters=10)
        step = anchored_rl_step(model, anchor, rows[: min(4, len(rows))], kl_coeff=coeff)
        evaluated = evaluate_checkpoint(work / "bc.pt", work / "shards", config=SMOKE_GNN)
        return _line(
            "bc",
            True,
            mapped=report.mapped,
            unmappable_rate=unmappable_rate({
                "decisions": report.decisions, "unmappable": report.unmappable,
            }),
            loss=trained["loss"],
            rl_loss=step["loss"],
            kl=step["kl"],
            accuracy=evaluated["accuracy"],
            win_rate=evaluated["win_rate"],
            checkpoint=str(work / "bc.pt"),
        )
    except Exception as exc:
        return _line("bc", False, error=str(exc))


def stage_rllib(checkpoint: str | None) -> dict:
    """Build the IMPALA config with the BC init flag. Ray itself is optional."""

    try:
        import ray  # noqa: F401
        from ml_engine.ray_cluster.orchestrator import build_impala_config

        cfg = build_impala_config(
            num_workers=0,
            train_batch_size=50,
            opponent_pool_path="",
            rollout_fragment_length=10,
            bc_checkpoint=checkpoint,
            bc_kl_coeff=0.5,
            bc_kl_iters=10,
        )
        custom = cfg["model"]["custom_model_config"]
        ok = custom.get("bc_checkpoint") == checkpoint and custom.get("bc_kl_coeff") == 0.5
        return _line("rllib", ok, bc_checkpoint=checkpoint, entropy_coeff=cfg.get("entropy_coeff"))
    except Exception as exc:
        return _line("rllib", False, error=str(exc))


def stage_eval(work: Path) -> dict:
    from ml_engine.bc.eval import evaluate_checkpoint

    checkpoint = work / "bc.pt"
    if not checkpoint.is_file():
        return _line("eval", False, error="BC checkpoint missing; record+train did not finish")
    try:
        report = evaluate_checkpoint(checkpoint, work / "shards", config=SMOKE_GNN)
        return _line("eval", True, **{key: value for key, value in report.items() if key != "win_rate_reason"}, note=report["win_rate_reason"])
    except Exception as exc:
        return _line("eval", False, error=str(exc))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("decks", "bc", "rllib", "eval", "all"), default="all")
    parser.add_argument("--work", type=Path, default=Path(os.environ.get("BC_WORK", "bc_smoke")))
    parser.add_argument("--bc-checkpoint", default=None)
    args = parser.parse_args(argv)
    results = []
    if args.stage in ("decks", "all"):
        results.append(stage_decks())
    if args.stage in ("bc", "all"):
        results.append(stage_bc(args.work))
    if args.stage in ("rllib", "all"):
        checkpoint = args.bc_checkpoint or str(args.work / "bc.pt")
        results.append(stage_rllib(checkpoint if Path(checkpoint).is_file() else None))
    if args.stage in ("eval", "all"):
        results.append(stage_eval(args.work))
    return 0 if all(item["status"] == "PASS" for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
