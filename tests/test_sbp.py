import httpx

from app.services.sbp import create_sbp_link


def test_create_sbp_link_handles_http_error(monkeypatch, caplog):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SBP_API_URL", "https://example.test")

    def fake_post(*args, **kwargs):
        raise httpx.HTTPError("boom")

    monkeypatch.setattr(httpx, "post", fake_post)

    with caplog.at_level("ERROR"):
        url = create_sbp_link("123", 100, "RUB")

    assert url == "https://sbp.example/pay/123"
    assert "boom" in caplog.text
