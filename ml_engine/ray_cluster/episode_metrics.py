"""RLlib callback that publishes per-episode Forge metrics.

Importing this module requires Ray. The pure copy helper lives in
``training_metrics`` so unit tests can run without it.
"""

from __future__ import annotations

from typing import Any

from ray.rllib.algorithms.callbacks import DefaultCallbacks

from ml_engine.ray_cluster.training_metrics import numeric_custom_metrics


class MtgEpisodeMetrics(DefaultCallbacks):
    """Copy ``info['episode_metrics']`` onto ``episode.custom_metrics``."""

    def on_episode_end(
        self,
        *,
        worker: Any = None,
        base_env: Any = None,
        policies: Any = None,
        episode: Any = None,
        **kwargs: Any,
    ) -> None:
        if episode is None:
            return
        info: Any = {}
        getter = getattr(episode, "last_info_for", None)
        if callable(getter):
            try:
                info = getter() or {}
            except Exception:
                info = {}
        custom = getattr(episode, "custom_metrics", None)
        if not isinstance(custom, dict):
            return
        custom.update(numeric_custom_metrics(info if isinstance(info, dict) else None))
