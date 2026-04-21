#!/usr/bin/env node
/**
 * Cross-platform Python launcher for npm scripts.
 *
 * Resolution order:
 *   1. $PYTHON env var (explicit override).
 *   2. Project-local virtualenv: .venv/Scripts/python.exe (Windows) or .venv/bin/python (POSIX).
 *   3. PATH: python3 → python → py -3 (Windows launcher fallback).
 *
 * Why this exists: Windows devs typically have a system `python` (e.g. 3.14) on PATH
 * that lacks our ML deps (gymnasium/ray/torch). The repo keeps a `.venv` with pinned
 * versions — this shim makes `npm run train:ray` pick it up automatically without
 * requiring every script invocation to be preceded by an `activate`.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

function resolvePython() {
  if (process.env.PYTHON && existsSync(process.env.PYTHON)) return process.env.PYTHON;

  const venvCandidates = isWin
    ? [path.join(repoRoot, ".venv", "Scripts", "python.exe"),
       path.join(repoRoot, "venv", "Scripts", "python.exe")]
    : [path.join(repoRoot, ".venv", "bin", "python"),
       path.join(repoRoot, "venv", "bin", "python")];

  for (const p of venvCandidates) if (existsSync(p)) return p;

  // Fallbacks — last resort, may not have ML deps
  return isWin ? "py" : "python3";
}

const py = resolvePython();
const args = process.argv.slice(2);
// If we fell back to the Windows `py` launcher, prepend `-3` so it picks Python 3
const finalArgs = py === "py" ? ["-3", ...args] : args;

const child = spawn(py, finalArgs, {
  stdio: "inherit",
  cwd: repoRoot,
  env: { ...process.env, PYTHONPATH: [repoRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(`[run-python] failed to spawn ${py}: ${err.message}`);
  process.exit(127);
});
