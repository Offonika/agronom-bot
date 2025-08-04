import logging
import os
import subprocess
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import text

from app.services.protocols import find_protocol, import_csv_to_db
from app.models import Catalog, CatalogItem
from app.db import SessionLocal, init_db
from app.config import Settings


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
        import_csv_to_db()


def test_import_csv_invalid_phi(tmp_path):
    """Import CSV rows with empty or invalid phi values."""
    with tmp_db(tmp_path):
        csv_file = tmp_path / "protocols.csv"
        csv_file.write_text(
            "crop,disease,product,dosage_value,dosage_unit,phi\n"
            "cucumber,mildew,Prod1,1,l_per_ha,\n"
            "wheat,rust,Prod2,2,l_per_ha,abc\n",
            encoding="utf-8",
        )

        with SessionLocal() as session:
            session.query(CatalogItem).delete()
            session.query(Catalog).delete()
            session.commit()

        import_csv_to_db(path=csv_file)

        with SessionLocal() as session:
            r1 = session.execute(
                text(
                    "SELECT phi FROM protocols_current WHERE crop='cucumber' AND disease='mildew'"
                )
            ).one()
            r2 = session.execute(
                text(
                    "SELECT phi FROM protocols_current WHERE crop='wheat' AND disease='rust'"
                )
            ).one()
            assert r1.phi == 0
            assert r2.phi == 0


def test_find_protocol_found(tmp_path):
    with tmp_db(tmp_path):
        import_csv_to_db()
        proto = find_protocol("apple", "scab")
        assert proto is not None
        assert proto.product == "Хорус 75 ВДГ"
        assert float(proto.dosage_value) == 3.0
        assert proto.dosage_unit == "g_per_l"
        assert proto.phi == 28


def test_find_protocol_missing(tmp_path):
    with tmp_db(tmp_path):
        import_csv_to_db()
        proto = find_protocol("apple", "unknown")
        assert proto is None


def test_import_csv_update_success(tmp_path, monkeypatch):
    """Update protocols CSV and import new row."""
    with tmp_db(tmp_path):
        csv_file = tmp_path / "protocols.csv"

        def fake_update_protocols_csv(output: Path) -> Path:
            output.write_text(
                "crop,disease,product,dosage_value,dosage_unit,phi\n"
                "corn,blight,Prod3,1,l_per_ha,10\n",
                encoding="utf-8",
            )
            return output

        monkeypatch.setattr(
            "scripts.update_protocols.update_protocols_csv", fake_update_protocols_csv
        )

        with SessionLocal() as session:
            session.query(CatalogItem).delete()
            session.query(Catalog).delete()
            session.commit()

        import_csv_to_db(path=csv_file, update=True)

        with SessionLocal() as session:
            proto = session.execute(
                text(
                    "SELECT product FROM protocols_current WHERE crop='corn' AND disease='blight'"
                )
            ).one()
            assert proto.product == "Prod3"


def test_import_csv_update_expected_failure(tmp_path, monkeypatch, caplog):
    """Use cached CSV when update script raises expected errors."""
    with tmp_db(tmp_path):
        csv_file = tmp_path / "protocols.csv"
        csv_file.write_text(
            "crop,disease,product,dosage_value,dosage_unit,phi\n"
            "barley,smut,Prod4,2,l_per_ha,7\n",
            encoding="utf-8",
        )

        def failing_update_protocols_csv(output: Path) -> Path:
            raise OSError("network down")

        monkeypatch.setattr(
            "scripts.update_protocols.update_protocols_csv", failing_update_protocols_csv
        )

        with SessionLocal() as session:
            session.query(CatalogItem).delete()
            session.query(Catalog).delete()
            session.commit()

        with caplog.at_level(logging.WARNING):
            import_csv_to_db(path=csv_file, update=True)
            assert "CSV download failed" in caplog.text

        with SessionLocal() as session:
            proto = session.execute(
                text(
                    "SELECT product FROM protocols_current WHERE crop='barley' AND disease='smut'"
                )
            ).one()
            assert proto.product == "Prod4"


def test_import_csv_update_unexpected_failure(tmp_path, monkeypatch):
    """Unexpected errors from update script should surface."""
    with tmp_db(tmp_path):
        csv_file = tmp_path / "protocols.csv"

        def bad_update_protocols_csv(output: Path) -> Path:
            raise ValueError("boom")

        monkeypatch.setattr(
            "scripts.update_protocols.update_protocols_csv", bad_update_protocols_csv
        )

        with pytest.raises(ValueError):
            import_csv_to_db(path=csv_file, update=True)
