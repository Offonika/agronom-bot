import logging
import os
from datetime import datetime, timezone
from typing import AsyncContextManager as AbstractAsyncContextManager
from uuid import uuid4

import aioboto3
from aiobotocore.client import AioBaseClient
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException

from app.config import Settings


logger = logging.getLogger("s3")  # Logger for S3 interactions


BUCKET = os.getenv("S3_BUCKET", "agronom")
_settings: Settings | None = None

_client_ctx: AbstractAsyncContextManager[AioBaseClient] | None = None
_client: AioBaseClient | None = None


async def _make_client() -> AioBaseClient:
    endpoint = os.getenv(
        "S3_ENDPOINT",
        _settings.s3_endpoint if _settings is not None else None,
    )
    region = os.getenv(
        "S3_REGION",
        _settings.s3_region if _settings is not None else "us-east-1",
    )
    access_key = os.getenv(
        "S3_ACCESS_KEY",
        _settings.s3_access_key if _settings is not None else None,
    )
    secret_key = os.getenv(
        "S3_SECRET_KEY",
        _settings.s3_secret_key if _settings is not None else None,
    )
    session = aioboto3.Session()
    client_ctx = session.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
    )
    global _client_ctx
    _client_ctx = client_ctx
    return await client_ctx.__aenter__()




async def get_client() -> AioBaseClient:
    """Return a cached aioboto3 client, creating it if needed."""
    global _client
    if _client is None:
        _client = await _make_client()
    return _client


async def close_client() -> None:
    """Close the cached S3 client if it exists."""
    global _client, _client_ctx
    if _client_ctx is not None:
        await _client_ctx.__aexit__(None, None, None)
    _client = None
    _client_ctx = None


async def init_storage(cfg: Settings) -> None:
    """Store settings and reinitialize the client."""
    global _settings
    _settings = cfg
    await close_client()


async def upload_photo(user_id: int, data: bytes) -> str:
    """Upload bytes to S3 and return the object key."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    key = f"{user_id}/{ts}-{uuid4().hex}.jpg"
    bucket = os.getenv(
        "S3_BUCKET",
        _settings.s3_bucket if _settings is not None else BUCKET,
    )
    try:
        client = await get_client()
        await client.put_object(
            Bucket=bucket, Key=key, Body=data, ContentType="image/jpeg"
        )
    except (BotoCoreError, ClientError) as exc:
        logger.exception("🔥 Ошибка при загрузке в S3: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="S3 upload failed",
        ) from exc
    return key


def get_public_url(key: str) -> str:
    """Return a public URL for the object."""
    bucket = os.getenv(
        "S3_BUCKET",
        _settings.s3_bucket if _settings is not None else BUCKET,
    )
    base = os.getenv(
        "S3_PUBLIC_URL",
        _settings.s3_public_url if _settings is not None else None,
    )
    if base:
        return f"{base.rstrip('/')}/{key}"

    endpoint = os.getenv(
        "S3_ENDPOINT",
        _settings.s3_endpoint if _settings is not None else None,
    )
    if endpoint:
        return f"{endpoint.rstrip('/')}/{bucket}/{key}"

    region = os.getenv(
        "S3_REGION",
        _settings.s3_region if _settings is not None else "us-east-1",
    )
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"
