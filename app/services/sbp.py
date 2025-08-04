import logging
import os

import httpx

logger = logging.getLogger(__name__)


async def create_sbp_link(
    external_id: str, amount: int, currency: str, autopay: bool = False
) -> tuple[str, str | None]:
    """Return SBP payment URL and optional Autopay binding ID.

    In development returns a sandbox link. In production sends a request
    to external SBP API if SBP_API_URL is configured.
    """
    env = os.getenv("APP_ENV", "development").lower()
    api_url = os.getenv("SBP_API_URL")
    if env != "production" or not api_url:
        binding = f"BND-{external_id}" if autopay else None
        return f"https://sandbox/pay?tx={external_id}", binding

    token = os.getenv("SBP_API_TOKEN")
    payload = {
        "external_id": external_id,
        "amount": amount,
        "currency": currency,
    }
    if autopay:
        payload["autopay"] = True
    headers = {"Authorization": f"Bearer {token}"} if token else None
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                api_url, json=payload, headers=headers, timeout=10
            )
            resp.raise_for_status()
            data = resp.json()
        url = data.get("url", f"https://sbp.example/pay/{external_id}")
        binding = data.get("binding_id") if autopay else None
        return url, binding
    except httpx.HTTPError as exc:
        logger.error("SBP API request failed: %s", exc)
        return f"https://sbp.example/pay/{external_id}", None
    except ValueError as exc:
        logger.error("SBP API response parsing failed: %s", exc)
        return f"https://sbp.example/pay/{external_id}", None
