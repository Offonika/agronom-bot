"""Protocol lookup service."""

from __future__ import annotations

import csv
from pathlib import Path
from functools import lru_cache

from app.db import SessionLocal
from app.models import Protocol
from sqlalchemy.exc import OperationalError
import logging

# CSV is stored in the repository root
CSV_PATH = Path(__file__).resolve().parent.parent.parent / "protocols.csv"


def load_csv(path: Path = CSV_PATH) -> list[dict]:
    """Load protocols from CSV file."""
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return list(reader)


def import_csv_to_db(path: Path = CSV_PATH, update: bool = False) -> None:
    """Import CSV rows into the database if table empty.

    If ``update`` is True or ``path`` doesn't exist, ``scripts.update_protocols``
    will be used to download the latest CSV before import.
    """
    if update or not path.exists():
        try:
            from scripts.update_protocols import update_protocols_csv

            update_protocols_csv(output=path)
        except Exception:
            # Fallback to existing file if download fails
            pass

    session = SessionLocal()
    try:
        count = session.query(Protocol).count()
    except OperationalError:
        logging.warning(
            "Table 'protocols' not found. Run 'alembic upgrade head' or set DB_CREATE_ALL=1"
        )
        session.close()
        return
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
    session.close()


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
