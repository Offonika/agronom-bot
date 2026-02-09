#!/usr/bin/env python3
"""
Rotate runtime secrets stored in `.env` without printing secret values.

This script is intended for single-server deployments where docker-compose
uses `env_file: .env`. It:
  - creates a timestamped `.env.bak-*` backup
  - updates selected keys in-place (preserving comments/order where possible)
  - keeps file permissions restrictive (0600 when possible)
  - syncs `.secrets/metrics_token` with `METRICS_TOKEN` (Prometheus bearer token file)

Usage:
  ./venv/bin/python scripts/rotate_runtime_secrets.py

By default it rotates: JWT_SECRET, API_KEY, METRICS_TOKEN, BOT_METRICS_TOKEN.
"""

from __future__ import annotations

import os
import shutil
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from secrets import token_hex, token_urlsafe


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
SECRETS_DIR = ROOT / ".secrets"
METRICS_TOKEN_FILE = SECRETS_DIR / "metrics_token"


@dataclass(frozen=True)
class RotationSpec:
    key: str
    generator: callable[[], str]


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def _read_env_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines(keepends=False)


def _write_env_lines(path: Path, lines: list[str]) -> None:
    # Preserve trailing newline (Docker Compose doesn't care, but humans do).
    payload = "\n".join(lines).rstrip("\n") + "\n"
    path.write_text(payload, encoding="utf-8")


def _ensure_0600(path: Path) -> None:
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except PermissionError:
        # Best effort; on some FS/users this might not be permitted.
        pass


def _backup_env(path: Path) -> Path:
    backup = path.with_name(f".env.bak-{_ts()}")
    shutil.copy2(path, backup)
    _ensure_0600(backup)
    return backup


def _upsert(lines: list[str], key: str, value: str) -> list[str]:
    prefix = f"{key}="
    out: list[str] = []
    replaced = False
    for line in lines:
        if line.startswith(prefix):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        # Append at end with a short separator for readability.
        if out and out[-1].strip() != "":
            out.append("")
        out.append(f"{key}={value}")
    return out


def main() -> int:
    if not ENV_PATH.exists():
        raise SystemExit(f"Missing {ENV_PATH}")

    # Default rotations: internal app secrets (no external provider interaction).
    specs = [
        RotationSpec("JWT_SECRET", lambda: token_hex(64)),  # 128 hex chars
        RotationSpec("API_KEY", lambda: token_urlsafe(48)),
        RotationSpec("METRICS_TOKEN", lambda: token_urlsafe(48)),
    ]

    lines = _read_env_lines(ENV_PATH)
    backup = _backup_env(ENV_PATH)

    rotated: dict[str, str] = {}
    for spec in specs:
        rotated[spec.key] = spec.generator()
        lines = _upsert(lines, spec.key, rotated[spec.key])

    # Keep BOT_METRICS_TOKEN aligned with METRICS_TOKEN (bot accepts either).
    lines = _upsert(lines, "BOT_METRICS_TOKEN", rotated["METRICS_TOKEN"])
    rotated["BOT_METRICS_TOKEN"] = rotated["METRICS_TOKEN"]

    _write_env_lines(ENV_PATH, lines)
    _ensure_0600(ENV_PATH)

    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    METRICS_TOKEN_FILE.write_text(rotated["METRICS_TOKEN"] + "\n", encoding="utf-8")
    _ensure_0600(METRICS_TOKEN_FILE)

    # Do not print secret values.
    rotated_keys = ", ".join(sorted(rotated.keys()))
    print(f"OK: rotated [{rotated_keys}]")
    print(f"OK: backup created at {backup.name}")
    print(f"OK: synced {METRICS_TOKEN_FILE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

