from __future__ import annotations
import subprocess


def test_bot_paywall_card(monkeypatch):
    """Ensure bot shows paywall message when API returns 402."""
    monkeypatch.setenv("TINKOFF_TERMINAL_KEY", "test")
    monkeypatch.setenv("TINKOFF_SECRET_KEY", "test")
    result = subprocess.run(
        ["npm", "test", "--prefix", "bot"], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr