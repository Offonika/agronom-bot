from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)


def _sbp_qr_enabled() -> bool:
    raw = os.getenv("SBP_QR_ENABLED", "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class SBPLink:
    url: str
    binding_id: str | None = None
    provider_payment_id: str | None = None
    sbp_url: str | None = None


def _load_json_env(name: str) -> dict[str, Any] | None:
    raw = os.getenv(name)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Invalid JSON in %s", name)
        return None
    if not isinstance(data, dict):
        logger.warning("%s must contain a JSON object", name)
        return None
    return data


def _build_tinkoff_receipt(amount: int) -> dict[str, Any] | None:
    receipt = _load_json_env("SBP_TINKOFF_RECEIPT")
    if receipt:
        receipt.setdefault("Taxation", os.getenv("SBP_TINKOFF_TAXATION", "osn"))
        return receipt

    email = os.getenv("SBP_TINKOFF_RECEIPT_EMAIL")
    phone = os.getenv("SBP_TINKOFF_RECEIPT_PHONE")
    if not email and not phone:
        return None

    item_name = os.getenv("SBP_TINKOFF_RECEIPT_ITEM_NAME", "PRO subscription")
    tax = os.getenv("SBP_TINKOFF_RECEIPT_TAX", "none")
    payment_method = os.getenv(
        "SBP_TINKOFF_RECEIPT_PAYMENT_METHOD", "full_prepayment"
    )
    payment_object = os.getenv("SBP_TINKOFF_RECEIPT_PAYMENT_OBJECT", "service")
    taxation = os.getenv("SBP_TINKOFF_TAXATION", "osn")

    receipt = {
        "Taxation": taxation,
        "Items": [
            {
                "Name": item_name,
                "Price": amount,
                "Quantity": 1,
                "Amount": amount,
                "Tax": tax,
                "PaymentMethod": payment_method,
                "PaymentObject": payment_object,
            }
        ],
    }
    if email:
        receipt["Email"] = email
    if phone:
        receipt["Phone"] = phone
    return receipt


def _normalize_tinkoff_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _tinkoff_token(payload: dict[str, Any], secret: str) -> str:
    fields: dict[str, Any] = {}
    for key, value in payload.items():
        if key == "Token":
            continue
        if value is None or isinstance(value, (dict, list)):
            continue
        fields[key] = value
    fields["Password"] = secret
    data = "".join(_normalize_tinkoff_value(fields[key]) for key in sorted(fields))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def tinkoff_token(payload: dict[str, Any], secret: str) -> str:
    return _tinkoff_token(payload, secret)


def _log_tinkoff_qr_response(data: dict[str, Any]) -> None:
    if not isinstance(data, dict):
        logger.info("Tinkoff GetQr response: %s", data)
        return
    payload = {
        "Success": data.get("Success"),
        "ErrorCode": data.get("ErrorCode"),
        "Message": data.get("Message"),
        "Details": data.get("Details"),
        "PaymentId": data.get("PaymentId"),
        "Data": data.get("Data"),
        "TerminalKey": data.get("TerminalKey"),
        "QR": data.get("QR") or data.get("QrCode") or data.get("Qr"),
    }
    logger.info("Tinkoff GetQr response: %s", payload)


def map_tinkoff_status(raw_status: str | None) -> str | None:
    if not raw_status:
        return None
    status = raw_status.upper()
    if status in {"CONFIRMED", "COMPLETED"}:
        return "success"
    if status in {"REJECTED"}:
        return "fail"
    if status in {"DEADLINE_EXPIRED", "CANCELED", "CANCELLED", "REVERSED", "REFUNDED"}:
        return "cancel"
    return None


async def _tinkoff_post(
    client: httpx.AsyncClient, base_url: str, path: str, payload: dict[str, Any]
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    resp = await client.post(url, json=payload, timeout=10)
    if resp.status_code >= 400:
        logger.error(
            "Tinkoff API HTTP %s on %s: %s",
            resp.status_code,
            path,
            resp.text,
        )
        resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("Tinkoff API response is not JSON object")
    if data.get("Success") is False:
        message = data.get("Message") or data.get("Details") or "Unknown error"
        code = data.get("ErrorCode")
        suffix = f" (code={code})" if code is not None else ""
        raise ValueError(f"Tinkoff API error: {message}{suffix}")
    return data


def _extract_tinkoff_url(data: dict[str, Any]) -> str | None:
    candidates: list[Any] = [
        data.get("PaymentURL"),
        data.get("PaymentUrl"),
        data.get("QrCode"),
        data.get("QRCode"),
        data.get("QR"),
        data.get("Payload"),
    ]
    nested = data.get("Data")
    if isinstance(nested, str):
        candidates.append(nested)
    elif isinstance(nested, dict):
        candidates.extend(
            [
                nested.get("PaymentURL"),
                nested.get("PaymentUrl"),
                nested.get("Payload"),
                nested.get("QrCode"),
                nested.get("QRCode"),
                nested.get("QR"),
            ]
        )
    for value in candidates:
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            return value
    return None


async def _create_tinkoff_link(
    external_id: str,
    amount: int,
    _currency: str,
    autopay: bool,
    customer_key: str | None = None,
) -> SBPLink:
    api_url = os.getenv("SBP_API_URL")
    terminal_key = os.getenv("TINKOFF_TERMINAL_KEY")
    secret = os.getenv("TINKOFF_SECRET_KEY")
    if not api_url or not terminal_key or not secret:
        logger.warning("Tinkoff creds missing, falling back to sandbox link")
        binding = f"BND-{external_id}" if autopay else None
        return SBPLink(
            url=f"https://sbp.example/pay?tx={external_id}", binding_id=binding
        )

    description = os.getenv("SBP_TINKOFF_DESCRIPTION", "Agronom Pro")
    notification_url = os.getenv("SBP_TINKOFF_NOTIFICATION_URL")
    init_data = _load_json_env("SBP_TINKOFF_DATA")
    receipt = _build_tinkoff_receipt(amount)

    init_payload: dict[str, Any] = {
        "TerminalKey": terminal_key,
        "Amount": amount,
        "OrderId": external_id,
        "Description": description,
    }
    if customer_key:
        init_payload["CustomerKey"] = customer_key
    if autopay:
        init_payload["Recurrent"] = "Y"
    if notification_url:
        init_payload["NotificationURL"] = notification_url
    if init_data:
        init_payload["DATA"] = init_data
    if receipt:
        init_payload["Receipt"] = receipt
    init_payload["Token"] = _tinkoff_token(init_payload, secret)

    qr_enabled = _sbp_qr_enabled()
    qr_extra = _load_json_env("SBP_TINKOFF_QR_DATA") if qr_enabled else None

    try:
        async with httpx.AsyncClient() as client:
            init_resp = await _tinkoff_post(client, api_url, "Init", init_payload)
            payment_id = init_resp.get("PaymentId")
            if not payment_id:
                raise ValueError("Missing PaymentId in Init response")
            init_url = _extract_tinkoff_url(init_resp)

            qr_url = None
            if qr_enabled:
                qr_payload: dict[str, Any] = {
                    "TerminalKey": terminal_key,
                    "PaymentId": payment_id,
                }
                if qr_extra:
                    qr_payload.update(qr_extra)
                qr_payload["Token"] = _tinkoff_token(qr_payload, secret)

                try:
                    qr_resp = await _tinkoff_post(client, api_url, "GetQr", qr_payload)
                    _log_tinkoff_qr_response(qr_resp)
                    qr_url = _extract_tinkoff_url(qr_resp)
                except ValueError as exc:
                    logger.warning("Tinkoff GetQr failed: %s", exc)
                    qr_url = None

            url = init_url or qr_url
            if not url:
                raise ValueError("Missing payment URL in Tinkoff response")
            binding = f"BND-{external_id}" if autopay else None
            return SBPLink(
                url=url,
                binding_id=binding,
                provider_payment_id=str(payment_id),
                sbp_url=qr_url,
            )
    except (httpx.HTTPError, ValueError) as exc:
        logger.error("Tinkoff SBP request failed: %s", exc)
        binding = f"BND-{external_id}" if autopay else None
        return SBPLink(
            url=f"https://sbp.example/pay/{external_id}", binding_id=binding
        )


async def get_sbp_status(
    provider_payment_id: str,
) -> tuple[str | None, datetime | None, str | None]:
    mode = os.getenv("SBP_MODE", "").lower()
    if mode not in {"tinkoff", "tinkoff_test"}:
        return None, None, None
    api_url = os.getenv("SBP_API_URL")
    terminal_key = os.getenv("TINKOFF_TERMINAL_KEY")
    secret = os.getenv("TINKOFF_SECRET_KEY")
    if not api_url or not terminal_key or not secret:
        logger.warning("Tinkoff creds missing, skipping status sync")
        return None, None, None

    payload: dict[str, Any] = {
        "TerminalKey": terminal_key,
        "PaymentId": provider_payment_id,
    }
    payload["Token"] = _tinkoff_token(payload, secret)

    try:
        async with httpx.AsyncClient() as client:
            data = await _tinkoff_post(client, api_url, "GetState", payload)
    except (httpx.HTTPError, ValueError) as exc:
        logger.error("Tinkoff GetState failed: %s", exc)
        return None, None, None

    status = data.get("Status")
    if not isinstance(status, str):
        return None, None, None
    rebill_id = None
    for key in ("RebillId", "RebillID"):
        value = data.get(key)
        if isinstance(value, str) and value:
            rebill_id = value
            break
    if not rebill_id:
        nested = data.get("Data")
        if isinstance(nested, dict):
            for key in ("RebillId", "RebillID"):
                value = nested.get(key)
                if isinstance(value, str) and value:
                    rebill_id = value
                    break
    status = status.upper()
    if status in {"CONFIRMED", "COMPLETED"}:
        return "success", datetime.now(timezone.utc), rebill_id
    if status in {"REJECTED"}:
        return "fail", datetime.now(timezone.utc), rebill_id
    if status in {"DEADLINE_EXPIRED", "CANCELED", "CANCELLED", "REVERSED", "REFUNDED"}:
        return "cancel", datetime.now(timezone.utc), rebill_id
    return None, None, rebill_id


async def remove_sbp_customer(customer_key: str) -> bool | None:
    mode = os.getenv("SBP_MODE", "").lower()
    if mode not in {"tinkoff", "tinkoff_test"}:
        return None
    api_url = os.getenv("SBP_API_URL")
    terminal_key = os.getenv("TINKOFF_TERMINAL_KEY")
    secret = os.getenv("TINKOFF_SECRET_KEY")
    if not api_url or not terminal_key or not secret:
        logger.warning("Tinkoff creds missing, skipping RemoveCustomer")
        return None

    payload: dict[str, Any] = {
        "TerminalKey": terminal_key,
        "CustomerKey": customer_key,
    }
    payload["Token"] = _tinkoff_token(payload, secret)

    try:
        async with httpx.AsyncClient() as client:
            await _tinkoff_post(client, api_url, "RemoveCustomer", payload)
    except (httpx.HTTPError, ValueError) as exc:
        logger.error("Tinkoff RemoveCustomer failed: %s", exc)
        return False
    return True


async def charge_rebill(
    order_id: str,
    amount: int,
    rebill_id: str,
    *,
    customer_key: str | None = None,
    description: str | None = None,
) -> tuple[str | None, str | None]:
    mode = os.getenv("SBP_MODE", "").lower()
    if mode not in {"tinkoff", "tinkoff_test"}:
        return None, None
    api_url = os.getenv("SBP_API_URL")
    terminal_key = os.getenv("TINKOFF_TERMINAL_KEY")
    secret = os.getenv("TINKOFF_SECRET_KEY")
    if not api_url or not terminal_key or not secret:
        logger.warning("Tinkoff creds missing, skipping Charge")
        return None, None

    payload: dict[str, Any] = {
        "TerminalKey": terminal_key,
        "Amount": amount,
        "OrderId": order_id,
        "RebillId": rebill_id,
    }
    if customer_key:
        payload["CustomerKey"] = customer_key
    if description:
        payload["Description"] = description
    payload["Token"] = _tinkoff_token(payload, secret)

    try:
        async with httpx.AsyncClient() as client:
            data = await _tinkoff_post(client, api_url, "Charge", payload)
    except (httpx.HTTPError, ValueError) as exc:
        logger.error("Tinkoff Charge failed: %s", exc)
        return None, None

    payment_id = data.get("PaymentId") or data.get("PaymentID")
    status = data.get("Status")
    if not isinstance(status, str):
        status = None
    return (str(payment_id) if payment_id else None, status)


async def create_sbp_link(
    external_id: str,
    amount: int,
    currency: str,
    autopay: bool = False,
    customer_key: str | None = None,
) -> SBPLink:
    """Return SBP payment URL and optional Autopay binding ID.

    In development returns a sandbox link. In production sends a request
    to external SBP API if SBP_API_URL is configured.
    """
    env = os.getenv("APP_ENV", "development").lower()
    mode = os.getenv("SBP_MODE", "").lower()
    api_url = os.getenv("SBP_API_URL")
    if mode in {"mock", "stub"}:
        binding = f"BND-{external_id}" if autopay else None
        return SBPLink(
            url=f"https://sbp.example/pay?tx={external_id}", binding_id=binding
        )
    if mode in {"tinkoff", "tinkoff_test"}:
        return await _create_tinkoff_link(
            external_id, amount, currency, autopay, customer_key=customer_key
        )
    if mode in {"sandbox", "prod", "production"} and not api_url:
        logger.warning("SBP_API_URL not set, falling back to sandbox link")
        binding = f"BND-{external_id}" if autopay else None
        return SBPLink(
            url=f"https://sbp.example/pay?tx={external_id}", binding_id=binding
        )
    if env != "production" or not api_url:
        binding = f"BND-{external_id}" if autopay else None
        return SBPLink(
            url=f"https://sbp.example/pay?tx={external_id}", binding_id=binding
        )

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
        return SBPLink(url=url, binding_id=binding)
    except httpx.HTTPError as exc:
        logger.error("SBP API request failed: %s", exc)
        return SBPLink(url=f"https://sbp.example/pay/{external_id}")
    except ValueError as exc:
        logger.error("SBP API response parsing failed: %s", exc)
        return SBPLink(url=f"https://sbp.example/pay/{external_id}")
