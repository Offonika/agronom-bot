import os
import subprocess
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import text

from app.services.protocols import find_protocol, _cache_protocol
from app.db import SessionLocal, init_db
from app.config import Settings
from app.models import Catalog, CatalogItem


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
        _cache_protocol.cache_clear()


def seed_protocol():
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
        catalog = Catalog(crop="apple", disease="scab")
        session.add(catalog)
        session.flush()
        item = CatalogItem(
            catalog_id=catalog.id,
            product="Хорус 75 ВДГ",
            dosage_value=3,
            dosage_unit="g_per_l",
            phi=28,
            is_current=True,
        )
        session.add(item)
        session.commit()


def test_find_protocol_found(tmp_path):
    with tmp_db(tmp_path):
        seed_protocol()
        proto = find_protocol("main", "apple", "scab")
        assert proto is not None
        assert proto.product == "Хорус 75 ВДГ"
        assert float(proto.dosage_value) == 3.0
        assert proto.dosage_unit == "g_per_l"
        assert proto.phi == 28


def test_find_protocol_missing(tmp_path):
    with tmp_db(tmp_path):
        proto = find_protocol("main", "apple", "unknown")
        assert proto is None
