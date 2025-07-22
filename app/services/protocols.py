"""Protocol lookup service."""

from __future__ import annotations

import csv
from pathlib import Path
from functools import lru_cache

from app.db import SessionLocal
from app.models import Protocol

# CSV is stored in the repository root
CSV_PATH = Path(__file__).resolve().parent.parent.parent / "protocols.csv"


def load_csv(path: Path = CSV_PATH) -> list[dict]:
    """Load protocols from CSV file."""
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return list(reader)


def import_csv_to_db(path: Path = CSV_PATH) -> None:
    """Import CSV rows into the database if table empty."""
    session = SessionLocal()
    count = session.query(Protocol).count()
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
