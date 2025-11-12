from __future__ import annotations
import base64
import os
import re
import logging
import boto3
import pytest
import pytest_asyncio
from botocore.exceptions import BotoCoreError

from moto import mock_aws

from fastapi import HTTPException
from app.services import storage
from app.config import Settings
from app.services.storage import upload_photo, get_public_url, get_client


ORIGINAL_MAKE_CLIENT = storage._make_client

PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgN4abH0AAAAASUVORK5CYII="
)
PNG_BYTES = base64.b64decode(PNG_BASE64)


class _AsyncWrapper:
    def __init__(self, client: boto3.client):
        self._client = client
        self.meta = client.meta

    async def put_object(self, *args, **kwargs):
        return self._client.put_object(*args, **kwargs)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self._client.close()


@pytest_asyncio.fixture(autouse=True)
async def use_sync_client(monkeypatch):
    async def _make():
        ctx = _AsyncWrapper(boto3.client("s3", region_name="us-east-1"))
        storage._client_ctx = ctx
        return await ctx.__aenter__()

    monkeypatch.setattr(storage, "_make_client", _make)
    storage._client = None
    storage._client_ctx = None
    yield
    await storage.close_client()


@pytest.mark.asyncio
async def test_lazy_client_initialization():
    with mock_aws():
        await storage.init_storage(Settings(_env_file=None))
        assert storage._client is None
        first = await get_client()
        assert first is storage._client
        again = await get_client()
        assert again is first


@pytest.mark.asyncio
async def test_upload_and_url():
    original_env = {
        "S3_BUCKET": os.environ.get("S3_BUCKET"),
        "S3_REGION": os.environ.get("S3_REGION"),
        "S3_ENDPOINT": os.environ.get("S3_ENDPOINT"),
        "S3_PUBLIC_URL": os.environ.get("S3_PUBLIC_URL"),
    }
    try:
        os.environ["S3_BUCKET"] = "testbucket"
        os.environ["S3_REGION"] = "us-east-1"
        os.environ.pop("S3_ENDPOINT", None)
        os.environ["S3_PUBLIC_URL"] = "http://localhost:9000"
        await storage.init_storage(Settings(_env_file=None))

        with mock_aws():
            s3 = boto3.client("s3", region_name="us-east-1")
            s3.create_bucket(Bucket="testbucket")

            key = await upload_photo(42, PNG_BYTES)
            assert re.fullmatch(r"42/\d{14}-[0-9a-f]{32}\.png", key)
            obj = s3.get_object(Bucket="testbucket", Key=key)
            assert obj["Body"].read() == PNG_BYTES
            assert obj["ContentType"] == "image/png"

            url = get_public_url(key)
            assert url == f"http://localhost:9000/{key}"
    finally:
        for name, value in original_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@pytest.mark.asyncio
async def test_make_client_logs_error(monkeypatch, caplog):
    class FailingCtx:
        async def __aenter__(self):
            raise BotoCoreError()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeSession:
        def client(self, *args, **kwargs):
            return FailingCtx()

    monkeypatch.setattr(storage, "_make_client", ORIGINAL_MAKE_CLIENT)
    monkeypatch.setattr(storage.aioboto3, "Session", lambda: FakeSession())
    storage._client = None
    storage._client_ctx = None
    with caplog.at_level(logging.ERROR, logger="s3"):
        with pytest.raises(BotoCoreError):
            await storage._make_client()
    assert "Failed to create S3 client" in caplog.text


@pytest.mark.asyncio
async def test_make_client_logs_unexpected_error(monkeypatch, caplog):
    class FailingCtx:
        async def __aenter__(self):
            raise RuntimeError("boom")

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeSession:
        def client(self, *args, **kwargs):
            return FailingCtx()

    monkeypatch.setattr(storage, "_make_client", ORIGINAL_MAKE_CLIENT)
    monkeypatch.setattr(storage.aioboto3, "Session", lambda: FakeSession())
    storage._client = None
    storage._client_ctx = None
    with caplog.at_level(logging.ERROR, logger="s3"):
        with pytest.raises(RuntimeError):
            await storage._make_client()
    assert "Failed to create S3 client" in caplog.text


class DummyClient:
    def __init__(self):
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.closed = True


@pytest.mark.asyncio
async def test_close_client_closes():
    dummy = DummyClient()
    storage._client = await dummy.__aenter__()
    storage._client_ctx = dummy
    await storage.close_client()
    assert dummy.closed
    assert storage._client is None


class FailingClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_close_client_ignores_errors(caplog):
    failing = FailingClient()
    storage._client = await failing.__aenter__()
    storage._client_ctx = failing
    with caplog.at_level(logging.ERROR):
        await storage.close_client()
    assert "Failed to close S3 client" in caplog.text
    assert storage._client is None


@pytest.mark.asyncio
async def test_init_storage_closes_existing_client():
    dummy = DummyClient()
    storage._client = await dummy.__aenter__()
    storage._client_ctx = dummy
    await storage.init_storage(Settings(_env_file=None))
    assert dummy.closed
    assert storage._client is None


@pytest.mark.asyncio
async def test_upload_failure():
    original_env = {
        "S3_BUCKET": os.environ.get("S3_BUCKET"),
        "S3_REGION": os.environ.get("S3_REGION"),
        "S3_ENDPOINT": os.environ.get("S3_ENDPOINT"),
        "S3_PUBLIC_URL": os.environ.get("S3_PUBLIC_URL"),
    }
    try:
        os.environ["S3_BUCKET"] = "testbucket"
        os.environ["S3_REGION"] = "us-east-1"
        os.environ.pop("S3_ENDPOINT", None)
        os.environ.pop("S3_PUBLIC_URL", None)
        await storage.init_storage(Settings(_env_file=None))

        with mock_aws():
            # Intentionally do not create bucket to trigger error
            with pytest.raises(HTTPException) as exc:
                await upload_photo(42, PNG_BYTES)
            assert exc.value.status_code == 500
    finally:
        for name, value in original_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value