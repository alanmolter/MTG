from pathlib import Path

from ml_engine.scripts.plot_training_rewards import collect_rows, find_experiment


def test_collect_rows_uses_elapsed_time_and_return_metric(tmp_path: Path) -> None:
    experiment = tmp_path / "pbt_mtg_demo"
    trial = experiment / "IMPALA_demo_00000"
    trial.mkdir(parents=True)
    (trial / "progress.csv").write_text(
        "training_iteration,time_total_s,env_runners/episode_return_mean\n"
        "1,1800,-0.25\n"
        "2,3600,0.5\n",
        encoding="utf-8",
    )

    assert find_experiment(tmp_path, None) == experiment
    assert collect_rows(experiment) == [
        {
            "trial": "IMPALA_demo_00000",
            "training_iteration": 1,
            "elapsed_hours": 0.5,
            "reward": -0.25,
            "source": str(trial / "progress.csv"),
        },
        {
            "trial": "IMPALA_demo_00000",
            "training_iteration": 2,
            "elapsed_hours": 1.0,
            "reward": 0.5,
            "source": str(trial / "progress.csv"),
        },
    ]


def test_collect_rows_falls_back_to_legacy_reward_and_omits_missing_values(tmp_path: Path) -> None:
    experiment = tmp_path / "pbt_mtg_demo"
    trial = experiment / "IMPALA_demo_00000"
    trial.mkdir(parents=True)
    (trial / "progress.csv").write_text(
        "training_iteration,time_total_s,episode_reward_mean\n"
        "1,10,\n"
        "2,20,0.125\n",
        encoding="utf-8",
    )

    rows = collect_rows(experiment)
    assert len(rows) == 1
    assert rows[0]["reward"] == 0.125
    assert rows[0]["elapsed_hours"] == 20 / 3600
