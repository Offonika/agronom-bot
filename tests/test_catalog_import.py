import sqlalchemy as sa
from sqlalchemy import text

from scripts import import_catalog


def create_engine(tmp_path):
    db_path = tmp_path / "catalog.db"
    engine = sa.create_engine(f"sqlite:///{db_path}")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            """
            CREATE TABLE products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product TEXT UNIQUE NOT NULL,
                ai TEXT,
                form TEXT,
                constraints TEXT
            );
            """
        )
        conn.exec_driver_sql(
            """
            CREATE TABLE product_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                crop TEXT NOT NULL,
                disease TEXT NOT NULL,
                region TEXT,
                product_id INTEGER NOT NULL,
                dose_value REAL,
                dose_unit TEXT,
                phi_days INTEGER,
                safety TEXT,
                meta TEXT
            );
            """
        )
    return engine


def base_entry():
    return {
        "product_name": "Топаз",
        "product_code": "TOPAZ-001",
        "ai": "пропиконазол",
        "form": "ЭК",
        "usage_class": "fungicide",
        "crop": "tomato",
        "disease": "blight",
        "region": None,
        "dose_value": 0.5,
        "dose_unit": "л/га",
        "phi_days": 30,
        "safe_phase": "до цветения",
        "notes": "основной препарат",
        "priority": 10,
        "is_allowed": True,
    }


def test_sync_catalog_inserts_and_updates(tmp_path):
    engine = create_engine(tmp_path)
    entry = base_entry()
    stats = import_catalog.sync_catalog([entry], engine)
    assert stats["products_inserted"] == 1
    assert stats["rules_inserted"] == 1
    with engine.connect() as conn:
        row = conn.execute(text("SELECT dose_value, phi_days FROM product_rules")).first()
        assert row.dose_value == 0.5
        assert row.phi_days == 30

    entry["dose_value"] = 0.7
    stats2 = import_catalog.sync_catalog([entry], engine)
    assert stats2["rules_updated"] == 1
    with engine.connect() as conn:
        row = conn.execute(text("SELECT dose_value FROM product_rules")).first()
        assert row.dose_value == 0.7


def test_normalize_entry_parses_fields():
    raw = {
        "Product_Name": " ХОМ ",
        "product_code": "HOM-002",
        "CROP": " grape ",
        "DISEASE": "mildew",
        "dose": "40 г/10л",
        "phi_days": "20",
        "priority": "5",
        "is_allowed": "yes",
        "notes": "Основной\nпрепарат",
    }
    entry = import_catalog.normalize_entry(raw)
    assert entry["product_name"] == "ХОМ"
    assert entry["dose_value"] == 40
    assert entry["dose_unit"] == "г/10л"
    assert entry["phi_days"] == 20
    assert entry["priority"] == 5
    assert entry["is_allowed"] is True
