"""Tiny JSON-file persistence for run history. No DB needed for the demo."""
import json
import os
import threading

_LOCK = threading.Lock()
_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS_FILE = os.path.join(_BASE, "data", "runs.json")


def _load_raw(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_json(name, default):
    return _load_raw(os.path.join(_BASE, "data", name), default)


def all_runs():
    return _load_raw(RUNS_FILE, [])


def save_run(run):
    with _LOCK:
        runs = _load_raw(RUNS_FILE, [])
        runs.insert(0, run)
        os.makedirs(os.path.dirname(RUNS_FILE), exist_ok=True)
        with open(RUNS_FILE, "w", encoding="utf-8") as f:
            json.dump(runs, f, indent=2)


def next_run_id():
    runs = _load_raw(RUNS_FILE, [])
    return f"RUN-{len(runs) + 1:04d}"
