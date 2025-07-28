"""Protocol lookup service."""

from __future__ import annotations

import csv
import logging
from functools import lru_cache
from pathlib import Path

from sqlalchemy import inspect
from sqlalchemy.exc import OperationalError

from app.db import SessionLocal
from app.models import Protocol

# CSV is stored in the repository root
CSV_PATH = Path(__file__).resolve().parent.parent.parent / "protocols.csv"

logger = logging.getLogger(__name__)


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
        except Exception as exc:  # noqa: BLE001
            logging.warning("CSV download failed: %s — using cached file", exc)

    # -------- 2. connect to DB -------------------------------------------------
    session = SessionLocal()

    # DEBUG ─────────────────────────────────────────────────────────────────────
    engine = session.bind
    if logger.isEnabledFor(logging.DEBUG):
        insp = inspect(engine)
        try:
            search_path = engine.execute("SHOW search_path").scalar()
        except Exception:  # noqa: BLE001
            search_path = "n/a"
        logger.debug("DB url       → %s", engine.url)
        logger.debug("search_path  → %s", search_path)
        logger.debug("table list   → %s", insp.get_table_names())
    # ───────────────────────────────────────────────────────────────────────────

    # -------- 3. if table missing → warn & exit --------------------------------
    try:
        count = session.query(Protocol).count()
    except OperationalError:
        logging.warning(
            "Table 'protocols' not found. "
            "Run 'alembic upgrade head' or set DB_CREATE_ALL=1"
        )
        session.close()
        return

    # -------- 4. initial import ------------------------------------------------
    if count == 0 and path.exists():
        rows = load_csv(path)
        for r in rows:
            proto = Protocol(
                crop=r["crop"],
                disease=r["disease"],
                product=r["product"],
                dosage_value=r["dosage_value"],
                dosage_unit=r["dosage_unit"],
                phi=int(r["phi"]),
            )
            session.add(proto)
        session.commit()
        logging.info("Imported %s protocols from CSV", len(rows))

    session.close()


# --------------------------------------------------------------------------- #
# Runtime lookup with LRU-cache
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=None)
def _cache_protocol(crop: str, disease: str) -> Protocol | None:
    session = SessionLocal()
    proto = (
        session.query(Protocol)
        .filter(Protocol.crop == crop, Protocol.disease == disease)
        .first()
    )
    session.close()
    return proto


def find_protocol(crop: str, disease: str) -> Protocol | None:
    """Return protocol by crop and disease."""
    return _cache_protocol(crop, disease)
