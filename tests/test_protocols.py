from app.services.protocols import find_protocol, import_csv_to_db


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
