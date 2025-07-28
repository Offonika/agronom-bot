from app.services.protocols import find_protocol, import_csv_to_db
from app.models import Protocol


def test_import_csv_no_table():
    """Drop protocols table to verify CSV import recreates it."""
    from app.db import SessionLocal

    with SessionLocal() as session:
        engine = session.bind

    Protocol.__table__.drop(engine)
    try:
        import_csv_to_db()
    finally:
        Protocol.__table__.create(engine)
        import_csv_to_db()


def test_find_protocol_found():
    from app.db import SessionLocal

    import_csv_to_db()
    proto = find_protocol("apple", "scab")
    assert proto is not None
    assert proto.product == "Хорус 75 ВДГ"
    assert float(proto.dosage_value) == 3.0
    assert proto.dosage_unit == "g_per_l"
    assert proto.phi == 28


def test_find_protocol_missing():
    from app.db import SessionLocal
    import_csv_to_db()
    proto = find_protocol("apple", "unknown")
    assert proto is None
