from __future__ import annotations
import zipfile
from pathlib import Path

from sqlalchemy import text

from app.services import protocol_importer
from tests.test_protocol_importer import tmp_db


def test_run_import_inserts_data(monkeypatch, tmp_path: Path) -> None:
    html = '<a href="archive.zip">update 01.01.2024</a>'

    class DummyResponse:
        def __init__(self, text: str):
            self.text = text

        def raise_for_status(self) -> None:  # pragma: no cover - simple stub
            pass

    monkeypatch.setattr(
        protocol_importer.requests,
        "get",
        lambda url, timeout=30, **kwargs: DummyResponse(html),
    )

    def fake_download_zip(url: str, dest: Path) -> Path:
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("protocol.pdf", "dummy")
        return dest

    monkeypatch.setattr(protocol_importer, "download_zip", fake_download_zip)

    pdf_file = tmp_path / "protocol.pdf"
    pdf_file.write_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF")

    monkeypatch.setattr(
        protocol_importer,
        "pick_best_pdf_from_zip",
        lambda *_args, **_kwargs: pdf_file,
    )

    monkeypatch.setattr(
        protocol_importer,
        "extract_protocol_rows",
        lambda *args, **kwargs: [
            {
                "crop": "apple",
                "disease": "scab",
                "product": "Хорус 75 ВДГ",
                "dosage_value": 3,
                "dosage_unit": "g_per_l",
                "phi": 28,
            }
        ],
    )

    with tmp_db(tmp_path):
        protocol_importer.run_import("main")
        with protocol_importer.db.SessionLocal() as session:
            product = session.execute(text("SELECT product FROM catalog_items"))
            assert product.scalar_one() == "Хорус 75 ВДГ"


def test_run_import_logs_ssl_error(monkeypatch, caplog, tmp_path: Path) -> None:
    def fake_get(*args, **kwargs):
        raise protocol_importer.requests.exceptions.SSLError("bad ssl")

    monkeypatch.setattr(protocol_importer.requests, "get", fake_get)

    with tmp_db(tmp_path):
        with caplog.at_level("ERROR"):
            result = protocol_importer.run_import("main")

    assert result is None
    assert "CATALOG_CA_BUNDLE" in caplog.text
    assert "CATALOG_SSL_VERIFY" in caplog.text
