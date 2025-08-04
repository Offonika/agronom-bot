"""Protocol lookup service."""

from __future__ import annotations

import csv
import logging
from pathlib import Path
import threading
from dataclasses import dataclass

from cachetools import TTLCache
from sqlalchemy import inspect, text
from sqlalchemy.exc import OperationalError, SQLAlchemyError

from app import db
from app.models import Catalog, CatalogItem

# CSV is stored in the repository root
CSV_PATH = Path(__file__).resolve().parent.parent.parent / "protocols.csv"

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


# --------------------------------------------------------------------------- #
# Utils
# --------------------------------------------------------------------------- #
def load_csv(path: Path = CSV_PATH) -> list[dict]:
    """Load protocols from CSV file."""
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return list(reader)


# --------------------------------------------------------------------------- #
# CSV → DB import
# --------------------------------------------------------------------------- #
def import_csv_to_db(path: Path = CSV_PATH, update: bool = False) -> None:
    """Import CSV rows into the database if table is empty.

    If ``update`` is True or CSV is missing, scripts.update_protocols downloads
    the latest version before import.
    """
    # -------- 1. optionally download fresh CSV --------------------------------
    if update or not path.exists():
        try:
            from scripts.update_protocols import update_protocols_csv

            update_protocols_csv(output=path)
        except (ImportError, OSError) as exc:
            logger.warning("CSV download failed: %s — using cached file", exc)
        except Exception:
            logger.exception("Unexpected error while downloading protocols CSV")
            raise

    # -------- 2. connect to DB -------------------------------------------------
    with db.SessionLocal() as session:
        # DEBUG ─────────────────────────────────────────────────────────────────
        engine = session.bind
        if logger.isEnabledFor(logging.DEBUG):
            insp = inspect(engine)
            try:
                search_path = session.execute(text("SHOW search_path")).scalar()
            except SQLAlchemyError:
                search_path = "n/a"
            except Exception:
                logger.exception("Unexpected error retrieving search path")
                search_path = "n/a"
            logger.debug("DB url       → %s", engine.url)
            logger.debug("search_path  → %s", search_path)
            logger.debug("table list   → %s", insp.get_table_names())
        # ───────────────────────────────────────────────────────────────────────

        # -------- 3. if table missing → warn & exit ----------------------------
        try:
            count = session.query(CatalogItem).count()
        except OperationalError:
            logger.warning(
                "Table 'catalog_items' not found. "
                "Run 'alembic upgrade head' or set DB_CREATE_ALL=1",
            )
            return

        # -------- 4. initial import --------------------------------------------
        if count == 0 and path.exists():
            rows = load_csv(path)
            for r in rows:
                try:
                    phi = int(r.get("phi") or 0)
                except ValueError:
                    phi = 0
                catalog = (
                    session.query(Catalog)
                    .filter(Catalog.crop == r["crop"], Catalog.disease == r["disease"])
                    .first()
                )
                if catalog is None:
                    catalog = Catalog(crop=r["crop"], disease=r["disease"])
                    session.add(catalog)
                    session.flush()
                item = CatalogItem(
                    catalog_id=catalog.id,
                    product=r["product"],
                    dosage_value=r["dosage_value"],
                    dosage_unit=r["dosage_unit"],
                    phi=phi,
                    is_current=True,
                )
                session.add(item)
            session.commit()
            logger.info("Imported %s protocols from CSV", len(rows))


# --------------------------------------------------------------------------- #
# Runtime lookup with LRU-cache
_cache = TTLCache(maxsize=1024, ttl=600)
_cache_lock = threading.RLock()


def _cache_protocol(crop: str, disease: str) -> ProtocolRow | None:
    key = (crop, disease)
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    session = db.SessionLocal()
    try:
        row = session.execute(
            text(
                "SELECT id, crop, disease, product, dosage_value, dosage_unit, phi "
                "FROM protocols_current WHERE crop = :crop AND disease = :disease LIMIT 1"
            ),
            {"crop": crop, "disease": disease},
        ).first()
        proto = ProtocolRow(**row._mapping) if row else None
    except OperationalError as exc:
        logger.warning("protocols_current view query failed: %s", exc)
        return None
    finally:
        session.close()
    with _cache_lock:
        _cache[key] = proto
    return proto


def _clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


_cache_protocol.cache_clear = _clear_cache


def find_protocol(crop: str, disease: str) -> ProtocolRow | None:
    """Return protocol by crop and disease."""
    return _cache_protocol(crop, disease)
