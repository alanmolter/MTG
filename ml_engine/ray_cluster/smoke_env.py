"""
Pure-Python smoke test for MtgForgeEnv:
  1) env = MtgForgeEnv(...)
  2) obs, _ = env.reset()     ← spawns forge.rlbridge.ForgeRLBridge subprocess
  3) for N steps: env.step(random action)
  4) assert we reached terminal OR a truncation within turn_limit

Run:
  python -m ml_engine.ray_cluster.smoke_env
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
    print("[smoke_env] constructing env...", flush=True)
    env = MtgForgeEnv(cfg)
    try:
        t0 = time.time()
        obs, info = env.reset(seed=42)
        print(f"[smoke_env] reset ok in {time.time()-t0:.1f}s; initial turn={info['state'].get('turn')}", flush=True)
        steps = 0
        total_reward = 0.0
        while steps < 400:
            action = steps % 512  # arbitrary — Forge AI drives both sides regardless
            obs, reward, terminated, truncated, info = env.step(action)
            total_reward += reward
            steps += 1
            if steps % 20 == 0:
                s = info.get("state", {})
                print(
                    f"[smoke_env] step={steps} turn={s.get('turn')} life={s.get('life_you')}-{s.get('life_opp')} "
                    f"term={terminated} trunc={truncated} reward={reward:+.3f}",
                    flush=True,
                )
            if terminated or truncated:
                s = info.get("state", {})
                print(
                    f"[smoke_env] DONE at step={steps} outcome={s.get('outcome')} turn={s.get('turn')} "
                    f"total_reward={total_reward:+.3f}",
                    flush=True,
                )
                return 0
        print(f"[smoke_env] hit step cap without terminal (steps={steps})", flush=True)
        return 2
    finally:
        env.close()


if __name__ == "__main__":
    sys.exit(main())
