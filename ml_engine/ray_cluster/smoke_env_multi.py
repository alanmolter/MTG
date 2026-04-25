"""
Multi-episode smoke test — the real training-loop stress test:
reuses one subprocess across many env.reset() calls.

Arena pool:
  Honors TRAINING_POOL_ARENA_ONLY=1 the same way as `smoke_env.py`. See
  `ml_engine/ray_cluster/arena_pool.py` for the resolver contract.
"""
import sys
import time

from ml_engine.ray_cluster.arena_pool import (
    describe_training_pool,
    is_arena_only_training,
    resolve_decks_for_training,
)
from ml_engine.ray_cluster.env import MtgForgeEnv


def main():
    arena_only = is_arena_only_training()
    print(f"[multi] training pool: {describe_training_pool()}", flush=True)

    if arena_only:
        agent_deck, opponent_deck = resolve_decks_for_training(
            arena_only=True, seed=42
        )
    else:
        agent_deck, opponent_deck = "AggroRed", "Control"

    cfg = {
        "agent_deck": agent_deck,
        "opponent_deck": opponent_deck,
        "turn_limit": 40,
        "step_timeout": 30.0,
    }
    env = MtgForgeEnv(cfg)
    try:
        outcomes = []
        total_steps = 0
        t0 = time.time()
        for ep in range(5):
            t_ep = time.time()
            obs, info = env.reset(seed=1000 + ep)
            steps = 0
            reward_sum = 0.0
            while steps < 600:
                obs, reward, terminated, truncated, info = env.step(steps % 512)
                reward_sum += reward
                steps += 1
                if terminated or truncated:
                    break
            s = info.get("state", {})
            outcome = s.get("outcome")
            outcomes.append(outcome)
            total_steps += steps
            print(
                f"[multi] ep{ep}: steps={steps:3d} turn={s.get('turn'):2d} "
                f"outcome={outcome} life_end={s.get('life_you')}-{s.get('life_opp')} "
                f"reward={reward_sum:+.2f}  ({time.time()-t_ep:.1f}s)",
                flush=True,
            )
        print(
            f"[multi] total={5} episodes in {time.time()-t0:.1f}s "
            f"avg_steps={total_steps/5:.0f} outcomes={outcomes}",
            flush=True,
        )
        return 0
    finally:
        env.close()


if __name__ == "__main__":
    sys.exit(main())
