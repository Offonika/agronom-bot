"""Tools for importing plant protection protocols.

The module downloads the latest protocol archive, converts the data into CSV
and loads it into ``catalogs``/``catalog_items`` tables.  The main entry point is
``run_import`` which is safe to call repeatedly – if the catalog has been
imported before and ``force`` flag is not provided the function logs a message
and exits without performing any action.
"""

from __future__ import annotations

import argparse
import csv
import logging
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin

import re

import requests
from bs4 import BeautifulSoup
from sqlalchemy import text

from app import db

logger = logging.getLogger(__name__)


FIELDNAMES = ["crop", "disease", "product", "dosage_value", "dosage_unit", "phi"]

# Mapping of catalog categories to pages that list available archives.  The
# values here are placeholders; in production they should point to real pages
# on the Ministry of Agriculture website.
CATALOG_PAGES = {
    "main": "https://example.com/",
    "pesticide": "https://example.com/pesticide/",
    "agrochem": "https://example.com/agrochem/",
}


def find_latest_zip(html: str, base_url: str) -> str:
    """Return the absolute URL of the newest ``.zip`` link found in ``html``.

    The function scans all anchor tags, looking for links ending in ``.zip`` and
    tries to parse a ``DD.MM.YYYY`` date from the link text.  The URL with the
    most recent date is returned.  ``base_url`` is used to resolve relative links
    and a :class:`ValueError` is raised when no suitable links are present.
    """

    soup = BeautifulSoup(html, "html.parser")
    latest_href: str | None = None
    latest_date: datetime | None = None
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not href.lower().endswith(".zip"):
            continue
        text = a.get_text(" ", strip=True)
        match = re.search(r"(\d{2}\.\d{2}\.\d{4})", text)
        date: datetime | None = None
        if match:
            date = datetime.strptime(match.group(1), "%d.%m.%Y")
        if latest_date is None or (date and date > latest_date):
            latest_href = href
            latest_date = date
    if not latest_href:
        raise ValueError("No ZIP links found")
    return urljoin(base_url, latest_href)


def download_zip(url: str, dest: Path) -> Path:
    """Download ``url`` into ``dest`` and return the resulting path."""

    response = requests.get(url, timeout=30)
    response.raise_for_status()
    dest.write_bytes(response.content)
    return dest


def pdf_to_csv(pdf_path: Path, csv_path: Path) -> Path:
    """Convert a protocol PDF into CSV format.

    The function uses :mod:`camelot` to read all tables from ``pdf_path``.  The
    resulting dataframe is normalised to ``FIELDNAMES`` and written to
    ``csv_path``.  The path to the created CSV file is returned.
    """

    import camelot
    import pandas as pd

    tables = camelot.read_pdf(str(pdf_path), pages="all")
    if not tables:
        csv_path.write_text("")
        return csv_path
    df = pd.concat([t.df for t in tables])
    df.columns = FIELDNAMES
    df.to_csv(csv_path, index=False)
    return csv_path


def bulk_insert_items(rows: Iterable[dict], force: bool = False) -> None:
    """Insert ``rows`` into ``catalogs`` and ``catalog_items`` tables."""

    session = db.SessionLocal()
    try:
        if force:
            logger.info("Force flag set – truncating existing catalog tables")
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


def run_import(category: str, force: bool = False) -> None:
    """Run the full import procedure for ``category``."""

    logger.info("Starting catalog import for category '%s'", category)

    # Bail out early if the catalog already contains data and ``force`` is not
    # set.  This prevents accidental re-imports during scheduled runs.
    with db.SessionLocal() as session:
        already_imported = session.execute(
            text("SELECT 1 FROM catalog_items LIMIT 1")
        ).first()
        if already_imported and not force:
            logger.info("Catalog already imported – exiting")
            return

    page_url = CATALOG_PAGES.get(category)
    if not page_url:
        raise ValueError(f"Unknown catalog category: {category}")

    response = requests.get(page_url, timeout=30)
    response.raise_for_status()
    zip_url = find_latest_zip(response.text, page_url)
    logger.info("Latest archive URL: %s", zip_url)

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        zip_path = download_zip(zip_url, tmpdir / "archive.zip")

        # Extract the first PDF file from the archive
        with zipfile.ZipFile(zip_path) as zf:
            pdf_name = next((n for n in zf.namelist() if n.lower().endswith(".pdf")), None)
            if pdf_name is None:
                logger.error("No PDF found inside %s", zip_url)
                return
            zf.extract(pdf_name, tmpdir)
            pdf_path = tmpdir / pdf_name

        csv_path = pdf_to_csv(pdf_path, tmpdir / "protocols.csv")
        with csv_path.open("r", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))

        bulk_insert_items(rows, force=force)
        logger.info("Imported %s rows", len(rows))


def main() -> None:
    parser = argparse.ArgumentParser(description="Import protocols catalog")
    parser.add_argument("--category", default="main", help="Catalog category")
    parser.add_argument("--force", action="store_true", help="Replace existing data")
    args = parser.parse_args()
    run_import(args.category, force=args.force)


if __name__ == "__main__":
    main()

