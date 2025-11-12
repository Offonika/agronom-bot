from __future__ import annotations
from app.config import Settings
from app.dependencies import compute_signature
from app.db import SessionLocal
from app.models import PartnerOrder

settings = Settings()


def test_partner_order_duplicate(client):
    payload = {
        "order_id": "dup-1",
        "user_tg_id": 1,
        "protocol_id": 1,
        "price_kopeks": 1000,
    }
    sign = compute_signature(settings.hmac_secret_partner, payload.copy())
    payload["signature"] = sign
    headers = {"X-Sign": sign}

    resp1 = client.post("/v1/partner/orders", headers=headers, json=payload)
    assert resp1.status_code == 202

    resp2 = client.post("/v1/partner/orders", headers=headers, json=payload)
    assert resp2.status_code in {200, 202}
    assert resp2.json()["status"] == "new"

    with SessionLocal() as session:
        count = session.query(PartnerOrder).filter_by(order_id="dup-1").count()
        assert count == 1