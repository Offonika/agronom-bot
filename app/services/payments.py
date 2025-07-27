"""Payment related helpers."""
from __future__ import annotations


def create_sbp_link(external_id: str, amount: int, currency: str) -> str:
    """Return mocked SBP payment URL."""
    return f"https://sbp.example/pay/{external_id}"
