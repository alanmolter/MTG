"""Optional JSON Schema checks for bridge v2 messages.

The structural required-field check lives in the env. This module runs the
draft 2020-12 schemas when ``jsonschema`` is installed (CI and the preflight
A3 gate). Without the package the call is a no-op so unit fixtures that opt
into strict mode still run.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_VALIDATOR = None
_UNAVAILABLE = False


def validate_message(payload: dict[str, Any]) -> None:
    global _VALIDATOR, _UNAVAILABLE
    if _UNAVAILABLE:
        return
    kind = payload.get("type")
    if kind not in ("state", "hello", "error"):
        return
    try:
        validator = _validator()
    except ImportError:
        _UNAVAILABLE = True
        return
    if validator is None:
        return
    errors = list(validator(kind).iter_errors(payload))
    if errors:
        from ml_engine.ray_cluster.env import ProtocolError
        raise ProtocolError(errors[0].message)


def _validator():
    global _VALIDATOR
    if _VALIDATOR is not None:
        return _VALIDATOR
    import json as _json
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource

    root = Path(__file__).resolve().parents[2] / "schemas" / "bridge_v2"
    schemas = {}
    for path in root.glob("*.schema.json"):
        document = json.loads(path.read_text(encoding="utf-8"))
        schemas[document["$id"]] = document
    registry = Registry().with_resources(
        [(key, Resource.from_contents(value)) for key, value in schemas.items()]
    )

    def build(kind: str):
        name = {"hello": "hello.response", "error": "error", "state": "state"}[kind]
        schema = json.loads((root / f"{name}.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        return Draft202012Validator(schema, registry=registry)

    _VALIDATOR = build
    return _VALIDATOR
