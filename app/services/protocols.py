"""Protocol lookup service."""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass

from cachetools import TTLCache
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app import db

logger = logging.getLogger(__name__)


@dataclass
class ProtocolRow:
    id: int
    crop: str
    disease: str
    product: str
    dosage_value: float
    dosage_unit: str
    phi: int
    category: str | None = None
    status: str | None = None
    waiting_days: int | None = None


# --------------------------------------------------------------------------- #
# SQL query
# --------------------------------------------------------------------------- #
def _query_protocol(crop: str, disease: str) -> ProtocolRow | None:
    """Fetch a protocol row from the ``protocols_current`` view."""
    try:
        with db.SessionLocal() as session:
            row = session.execute(
                text(
                    "SELECT id, crop, disease, product, dosage_value, dosage_unit, phi "
                    "FROM protocols_current WHERE crop = :crop AND disease = :disease LIMIT 1"
                ),
                {"crop": crop, "disease": disease},
            ).first()
            return ProtocolRow(**row._mapping) if row else None
    except OperationalError as exc:
        logger.warning("protocols_current view query failed: %s", exc)
        return None


# --------------------------------------------------------------------------- #
# Runtime lookup with LRU-cache
_cache = TTLCache(maxsize=1024, ttl=600)
_cache_lock = threading.RLock()


def _cache_protocol(crop: str, disease: str) -> ProtocolRow | None:
    key = (crop, disease)
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    proto = _query_protocol(crop, disease)
    with _cache_lock:
        _cache[key] = proto
    return proto


def _clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


_cache_protocol.cache_clear = _clear_cache
def find_protocol(category: str, crop: str, disease: str) -> ProtocolRow | None:
    """Return protocol by category, crop and disease."""
    # ``category`` is currently unused as the view lacks this column, but the
    # signature is kept for forward compatibility.
    return _cache_protocol(crop, disease)


async def async_find_protocol(
    category: str, crop: str, disease: str
) -> ProtocolRow | None:
    """Async wrapper for :func:`find_protocol` using ``asyncio.to_thread``."""
    return await asyncio.to_thread(find_protocol, category, crop, disease)
