from __future__ import annotations

import argparse
import csv
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

import requests
from sqlalchemy import text

from app import db

ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "protocols.csv"
FIELDNAMES = ["crop", "disease", "product", "dosage_value", "dosage_unit", "phi"]


def download_zip(url: str, dest: Path) -> Path:
    """Download ZIP archive from ``url`` to ``dest``."""
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    dest.write_bytes(response.content)
    return dest


def extract_pdf(zip_path: Path, dest_dir: Path) -> Path:
    """Extract first PDF file from archive to ``dest_dir``."""
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if name.lower().endswith(".pdf"):
                zf.extract(name, dest_dir)
                return dest_dir / name
    raise FileNotFoundError("No PDF found in archive")


def pdf_to_rows(pdf_path: Path) -> list[dict]:
    """Convert tables in PDF to list of dict rows."""
    import camelot
    import pandas as pd

    tables = camelot.read_pdf(str(pdf_path), pages="all")
    if not tables:
        return []
    df = pd.concat([t.df for t in tables])
    df.columns = FIELDNAMES
    return df.to_dict(orient="records")


def write_csv(rows: Iterable[dict], path: Path) -> Path:
    """Write rows to CSV at ``path``."""
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in FIELDNAMES})
    return path


def bulk_insert(rows: Iterable[dict], force: bool = False) -> None:
    """Insert rows into catalogs and catalog_items tables."""
    session = db.SessionLocal()
    try:
        if force:
            session.execute(text("DELETE FROM catalog_items"))
            session.execute(text("DELETE FROM catalogs"))
            session.commit()
        catalogs_cache: dict[tuple[str, str], int] = {}
        for row in rows:
            key = (row["crop"], row["disease"])
            if key not in catalogs_cache:
                catalog_id = session.execute(
                    text(
                        "INSERT INTO catalogs (crop, disease) VALUES (:crop, :disease) RETURNING id"
                    ),
                    {"crop": row["crop"], "disease": row["disease"]},
                ).scalar_one()
                catalogs_cache[key] = catalog_id
            session.execute(
                text(
                    "INSERT INTO catalog_items (catalog_id, product, dosage_value, dosage_unit, phi) "
                    "VALUES (:catalog_id, :product, :dosage_value, :dosage_unit, :phi)"
                ),
                {
                    "catalog_id": catalogs_cache[key],
                    "product": row["product"],
                    "dosage_value": row["dosage_value"],
                    "dosage_unit": row["dosage_unit"],
                    "phi": row.get("phi", 0),
                },
            )
        session.commit()
    finally:
        session.close()


def import_protocols(url: str, category: str, force: bool) -> None:
    """Full import flow: download, extract, convert and insert."""
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        zip_path = tmpdir / "archive.zip"
        download_zip(url, zip_path)
        pdf_path = extract_pdf(zip_path, tmpdir)
        rows = pdf_to_rows(pdf_path)
        write_csv(rows, CSV_PATH)
        bulk_insert(rows, force=force)
        print(f"Imported {len(rows)} rows into category '{category}'")


def main() -> None:
    parser = argparse.ArgumentParser(description="Import protocols from ZIP PDF")
    parser.add_argument("url", help="URL to ZIP archive with protocols PDF")
    parser.add_argument("--category", default="main", help="Protocol category")
    parser.add_argument("--force", action="store_true", help="Replace existing data")
    args = parser.parse_args()
    import_protocols(args.url, args.category, args.force)


if __name__ == "__main__":
    main()
