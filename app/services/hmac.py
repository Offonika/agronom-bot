"""HMAC utilities for verifying webhook signatures."""
from __future__ import annotations

import hmac
import hashlib


def verify_hmac(sig_header: str, body: bytes, secret: str) -> bool:
    """Return ``True`` if HMAC-SHA256 signature matches the body."""
    if not sig_header:
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig_header)
