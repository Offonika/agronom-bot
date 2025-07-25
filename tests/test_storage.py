import os
import re
import boto3
import pytest

from moto import mock_aws

from fastapi import HTTPException
from app.services import storage
from app.config import Settings
from app.services.storage import upload_photo, get_public_url


@mock_aws
def test_upload_and_url():
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
        storage.init_storage(Settings())

        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="testbucket")

        key = upload_photo(42, b"hello")
        assert re.fullmatch(r"42/\d{14}-[0-9a-f]{32}\.jpg", key)
        obj = s3.get_object(Bucket="testbucket", Key=key)
        assert obj["Body"].read() == b"hello"

        url = get_public_url(key)
        assert url == f"http://localhost:9000/{key}"
    finally:
        for name, value in original_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@mock_aws
def test_upload_failure():
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
        storage.init_storage(Settings())

        # Intentionally do not create bucket to trigger error
        with pytest.raises(HTTPException) as exc:
            upload_photo(42, b"hello")
        assert exc.value.status_code == 500
    finally:
        for name, value in original_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
