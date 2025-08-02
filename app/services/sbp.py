import os

import httpx


def create_sbp_link(external_id: str, amount: int, currency: str) -> str:
    """Return SBP payment URL.

    In development returns a sandbox link. In production sends a request
    to external SBP API if SBP_API_URL is configured.
    """
    env = os.getenv("APP_ENV", "development").lower()
    api_url = os.getenv("SBP_API_URL")
    if env != "production" or not api_url:
        return f"https://sandbox/pay?tx={external_id}"

    token = os.getenv("SBP_API_TOKEN")
    payload = {
        "external_id": external_id,
        "amount": amount,
        "currency": currency,
    }
    headers = {"Authorization": f"Bearer {token}"} if token else None
    try:
        resp = httpx.post(api_url, json=payload, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return data.get("url", f"https://sbp.example/pay/{external_id}")
    except Exception:
        return f"https://sbp.example/pay/{external_id}"
