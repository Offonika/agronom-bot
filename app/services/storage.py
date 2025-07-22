import os
from datetime import datetime
from uuid import uuid4
import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException

BUCKET = os.getenv("S3_BUCKET", "agronom")


def _client():
    return boto3.client(
        "s3",
        endpoint_url=os.getenv("S3_ENDPOINT"),
        region_name=os.getenv("S3_REGION", "us-east-1"),
        aws_access_key_id=os.getenv("S3_ACCESS_KEY"),
        aws_secret_access_key=os.getenv("S3_SECRET_KEY"),
    )


def upload_photo(user_id: int, data: bytes) -> str:
    """Upload bytes to S3 and return the object key.

    Args:
        user_id: ID of the user who owns the photo.
        data: Raw image bytes.

    Returns:
        The generated object key.

    Raises:
        HTTPException: If the upload to S3 fails.
    """
    ts = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    key = f"{user_id}/{ts}-{uuid4().hex}.jpg"
    try:
        _client().put_object(
            Bucket=BUCKET, Key=key, Body=data, ContentType="image/jpeg"
        )
    except (BotoCoreError, ClientError) as exc:
        raise HTTPException(status_code=500, detail="S3 upload failed") from exc
    return key


def get_public_url(key: str) -> str:
    """Return a public URL for the object."""
    base = os.getenv("S3_PUBLIC_URL")
    if base:
        return f"{base.rstrip('/')}/{key}"

    endpoint = os.getenv("S3_ENDPOINT")
    if endpoint:
        return f"{endpoint.rstrip('/')}/{BUCKET}/{key}"

    region = os.getenv("S3_REGION", "us-east-1")
    return f"https://{BUCKET}.s3.{region}.amazonaws.com/{key}"
