#!/usr/bin/env bash
# Forge-free protocol tests. CI runs this without the Forge fat jar.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/rlbridge-protocol-test"
rm -rf "$OUT"
mkdir -p "$OUT"
javac -d "$OUT" \
  "$ROOT/src/main/java/forge/rlbridge/ProtocolV2.java" \
  "$ROOT/src/main/java/forge/rlbridge/DecisionHandoff.java" \
  "$ROOT/src/test/java/forge/rlbridge/ForgeRLBridgeProtocolTest.java"
java -cp "$OUT" forge.rlbridge.ForgeRLBridgeProtocolTest
