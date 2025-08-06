"""GPT-Vision integration using the OpenAI client."""

from __future__ import annotations

import json
import os
import atexit

import httpx
from openai import OpenAI, OpenAIError

from .storage import get_public_url


_client: OpenAI | None = None
_http_client: httpx.Client | None = None


def _get_client() -> OpenAI:
    """Lazily build and cache the OpenAI client."""

    global _client, _http_client
    if _client is None:
        mounts: dict[str, httpx.HTTPTransport] = {}
        http_proxy = os.environ.get("HTTP_PROXY")
        https_proxy = os.environ.get("HTTPS_PROXY")
        if http_proxy:
            mounts["http://"] = httpx.HTTPTransport(proxy=http_proxy)
        if https_proxy:
            mounts["https://"] = httpx.HTTPTransport(proxy=https_proxy)

        _http_client = httpx.Client(mounts=mounts) if mounts else None
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY environment variable is not set")
        _client = OpenAI(api_key=api_key, http_client=_http_client)
    return _client


def _close_client() -> None:
    global _client, _http_client
    if _http_client is not None:
        _http_client.close()
    _http_client = None
    _client = None


atexit.register(_close_client)

_PROMPT = (
    "You are an agronomist assistant. "
    "Identify the crop and disease shown in the image. "
    "Respond in JSON with fields crop, disease and confidence (0..1)."
)


def call_gpt_vision(key: str) -> dict:
    """Send photo to GPT‑Vision and parse the diagnosis.

    Parameters
    ----------
    key: str
        S3 object key returned by :func:`app.services.storage.upload_photo`.
    """

    image_url = get_public_url(key)

    client = _get_client()
    try:
        response = client.responses.create(
            model="gpt-4.1-mini",
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_url},
                        },
                    ],
                }
            ],
            response_format={"type": "json_object"},
        )
    except OpenAIError as exc:  # pragma: no cover - network/SDK errors
        raise RuntimeError("OpenAI request failed") from exc

    try:
        payload = response.output[0].content[0].text
        data = json.loads(payload)
        crop = data["crop"]
        disease = data["disease"]
        confidence = float(data["confidence"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, IndexError) as exc:
        raise ValueError("Malformed GPT response") from exc

    return {"crop": crop, "disease": disease, "confidence": confidence}


__all__ = ["call_gpt_vision"]

