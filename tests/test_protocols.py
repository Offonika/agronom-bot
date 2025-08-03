import logging
import pytest
from pathlib import Path

from app.services.protocols import find_protocol, import_csv_to_db
from app.models import Protocol
from app.db import SessionLocal


def test_import_csv_no_table():
    """Drop protocols table to verify CSV import recreates it."""

    with SessionLocal() as session:
        engine = session.bind

    Protocol.__table__.drop(engine)
    try:
        import_csv_to_db()
    finally:
        Protocol.__table__.create(engine)
        import_csv_to_db()


def test_import_csv_invalid_phi(tmp_path):
    """Import CSV rows with empty or invalid phi values."""

    csv_file = tmp_path / "protocols.csv"
    csv_file.write_text(
        "crop,disease,product,dosage_value,dosage_unit,phi\n"
        "cucumber,mildew,Prod1,1,l_per_ha,\n"
        "wheat,rust,Prod2,2,l_per_ha,abc\n",
        encoding="utf-8",
    )

    with SessionLocal() as session:
        session.query(Protocol).delete()
        session.commit()

    import_csv_to_db(path=csv_file)

    try:
        with SessionLocal() as session:
            r1 = (
                session.query(Protocol)
                .filter(Protocol.crop == "cucumber", Protocol.disease == "mildew")
                .one()
            )
            r2 = (
                session.query(Protocol)
                .filter(Protocol.crop == "wheat", Protocol.disease == "rust")
                .one()
            )
            assert r1.phi == 0
            assert r2.phi == 0
    finally:
        with SessionLocal() as session:
            session.query(Protocol).delete()
            session.commit()
        import_csv_to_db()


def test_find_protocol_found():

    import_csv_to_db()
    proto = find_protocol("apple", "scab")
    assert proto is not None
    assert proto.product == "Хорус 75 ВДГ"
    assert float(proto.dosage_value) == 3.0
    assert proto.dosage_unit == "g_per_l"
    assert proto.phi == 28


def test_find_protocol_missing():
    import_csv_to_db()
    proto = find_protocol("apple", "unknown")
    assert proto is None


def test_import_csv_update_success(tmp_path, monkeypatch):
    """Update protocols CSV and import new row."""

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
        session.query(Protocol).delete()
        session.commit()

    import_csv_to_db(path=csv_file, update=True)

    try:
        with SessionLocal() as session:
            proto = (
                session.query(Protocol)
                .filter(Protocol.crop == "corn", Protocol.disease == "blight")
                .one()
            )
            assert proto.product == "Prod3"
    finally:
        with SessionLocal() as session:
            session.query(Protocol).delete()
            session.commit()
        import_csv_to_db()


def test_import_csv_update_expected_failure(tmp_path, monkeypatch, caplog):
    """Use cached CSV when update script raises expected errors."""

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
        session.query(Protocol).delete()
        session.commit()

    with caplog.at_level(logging.WARNING):
        import_csv_to_db(path=csv_file, update=True)
        assert "CSV download failed" in caplog.text

    try:
        with SessionLocal() as session:
            proto = (
                session.query(Protocol)
                .filter(Protocol.crop == "barley", Protocol.disease == "smut")
                .one()
            )
            assert proto.product == "Prod4"
    finally:
        with SessionLocal() as session:
            session.query(Protocol).delete()
            session.commit()
        import_csv_to_db()


def test_import_csv_update_unexpected_failure(tmp_path, monkeypatch):
    """Unexpected errors from update script should surface."""

    csv_file = tmp_path / "protocols.csv"

    def bad_update_protocols_csv(output: Path) -> Path:
        raise ValueError("boom")

    monkeypatch.setattr(
        "scripts.update_protocols.update_protocols_csv", bad_update_protocols_csv
    )

    with pytest.raises(ValueError):
        import_csv_to_db(path=csv_file, update=True)
