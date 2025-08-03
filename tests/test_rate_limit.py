import os

HEADERS = {
    "X-API-Key": os.getenv("API_KEY", "test-api-key"),
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}


def test_rate_limit_ip(client):
    headers = HEADERS.copy()
    headers["X-Forwarded-For"] = "1.1.1.1"
    for _ in range(30):
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429


def test_rate_limit_user(client):
    headers = HEADERS.copy()
    for i in range(120):
        headers["X-Forwarded-For"] = f"10.0.0.{i//30}"
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    headers["X-Forwarded-For"] = "10.0.0.4"
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429
