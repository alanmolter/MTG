"""
Multi-episode smoke test — the real training-loop stress test:
reuses one subprocess across many env.reset() calls.
"""
import sys
import time

from ml_engine.ray_cluster.env import MtgForgeEnv


def main():
    cfg = {
        "agent_deck": "AggroRed",
        "opponent_deck": "Control",
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
