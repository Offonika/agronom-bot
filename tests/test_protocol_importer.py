from __future__ import annotations
import os
import subprocess
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import text

from app.config import Settings
from app.db import SessionLocal, init_db
from app.services.protocol_importer import find_latest_zip, bulk_insert_items


@contextmanager
def tmp_db(tmp_path: Path):
    old_url = os.environ.get("DATABASE_URL", "sqlite:///./app.db")
    os.environ["DATABASE_URL"] = f"sqlite:///{tmp_path}/protocols.db"
    subprocess.run(["alembic", "upgrade", "head"], check=True)
    init_db(Settings())
    try:
        yield
    finally:
        os.environ["DATABASE_URL"] = old_url
        subprocess.run(["alembic", "upgrade", "head"], check=True)
        init_db(Settings())


def create_protocols_view() -> None:
    with SessionLocal() as session:
        session.execute(
            text(
                """
                CREATE VIEW IF NOT EXISTS protocols_current AS
                SELECT ci.id AS id,
                       c.crop AS crop,
                       c.disease AS disease,
                       ci.product AS product,
                       ci.dosage_value AS dosage_value,
                       ci.dosage_unit AS dosage_unit,
                       ci.phi AS phi
                FROM catalog_items ci
                JOIN catalogs c ON c.id = ci.catalog_id
                WHERE ci.is_current = 1
                """
            )
        )
        session.commit()


def test_find_latest_zip_picks_most_recent():
    html = """
    <html><body>
    <a href="old.zip">update 01.01.2023</a>
    <a href="/files/new.zip">update 01.01.2024</a>
    </body></html>
    """
    url = find_latest_zip(html, "https://example.com/base/")
    assert url == "https://example.com/files/new.zip"


def test_find_latest_zip_no_links():
    html = "<html><body><p>no links here</p></body></html>"
    with pytest.raises(ValueError):
        find_latest_zip(html, "https://example.com/")


def test_bulk_insert_populates_tables(tmp_path):
    rows = [
        {
            "crop": "apple",
            "disease": "scab",
            "product": "Хорус 75 ВДГ",
            "dosage_value": 3,
            "dosage_unit": "g_per_l",
            "phi": 28,
        }
    ]
    with tmp_db(tmp_path):
        create_protocols_view()
        bulk_insert_items(rows, force=True)
        with SessionLocal() as session:
            product = session.execute(text("SELECT product FROM catalog_items"))
            assert product.scalar_one() == "Хорус 75 ВДГ"
            product = session.execute(text("SELECT product FROM protocols_current"))
            assert product.scalar_one() == "Хорус 75 ВДГ"


def test_pdf_to_csv_raises_on_column_mismatch(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace

    import pandas as pd
    from app.services import protocol_importer

    def fake_read_pdf(*args, **kwargs):
        df = pd.DataFrame([[1, 2, 3, 4, 5]])
        return [SimpleNamespace(df=df)]

    monkeypatch.setitem(sys.modules, "camelot", SimpleNamespace(read_pdf=fake_read_pdf))
    pdf_path = tmp_path / "input.pdf"
    pdf_path.write_text("dummy")
    csv_path = tmp_path / "out.csv"
    with pytest.raises(ValueError):
        protocol_importer.pdf_to_csv(pdf_path, csv_path)