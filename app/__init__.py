from __future__ import annotations

# Ensure asyncio.to_thread exists on Python < 3.9
from . import compat  # noqa: F401

__all__ = ["compat"]
