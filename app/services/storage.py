import os
from datetime import datetime
from uuid import uuid4
import boto3

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
    """Upload bytes to S3 and return the object key."""
    ts = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    key = f"{user_id}/{ts}-{uuid4().hex}.jpg"
    _client().put_object(Bucket=BUCKET, Key=key, Body=data, ContentType="image/jpeg")
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
