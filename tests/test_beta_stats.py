from __future__ import annotations

from app.config import Settings
from app.dependencies import compute_signature


def test_beta_stats_requires_signature(client):
    resp = client.get("/v1/beta_stats")
    assert resp.status_code == 422


def test_beta_stats_success(client):
    settings = Settings()
    signature = compute_signature(settings.hmac_secret, {"scope": "beta_stats"})
    resp = client.get("/v1/beta_stats", headers={"X-Sign": signature})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["scope"] == "beta_stats"
    assert "stats" in payload
    assert payload["stats"]["beta_testers"] == 0
