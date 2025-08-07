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

    def fake_pdf_to_csv(pdf_path: Path, csv_path: Path) -> Path:
        csv_path.write_text(
            "crop,disease,product,dosage_value,dosage_unit,phi\n"
            "apple,scab,Хорус 75 ВДГ,3,g_per_l,28\n"
        )
        return csv_path

    monkeypatch.setattr(protocol_importer, "pdf_to_csv", fake_pdf_to_csv)

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
            protocol_importer.run_import("main")

    assert "CATALOG_CA_BUNDLE" in caplog.text
    assert "CATALOG_SSL_VERIFY" in caplog.text
