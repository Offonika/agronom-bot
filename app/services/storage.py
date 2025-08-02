import os
from datetime import datetime, timezone
from uuid import uuid4
import traceback
import logging
logger = logging.getLogger("s3")

import aioboto3
from aiobotocore.client import AioBaseClient
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException

from app.config import Settings


BUCKET = os.getenv("S3_BUCKET", "agronom")
_settings: Settings | None = None

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
    client_ctx = aioboto3.Session().client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
    )
    return await client_ctx.__aenter__()




async def get_client() -> AioBaseClient:
    """Return a cached aioboto3 client, creating it if needed."""
    global _client
    if _client is None:
        _client = await _make_client()
    return _client


def init_storage(cfg: Settings) -> None:
    """Store settings and reinitialize the client."""
    global _settings, _client
    _settings = cfg
    _client = None


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
        logger.error("🔥 Ошибка при загрузке в S3: %s", exc)
        traceback.print_exc()
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
