import os
import boto3
from moto import mock_s3

from app.services.storage import upload_photo, get_public_url


@mock_s3
def test_upload_and_url():
    os.environ['S3_BUCKET'] = 'testbucket'
    os.environ['S3_REGION'] = 'us-east-1'
    os.environ.pop('S3_ENDPOINT', None)
    os.environ['S3_PUBLIC_URL'] = 'http://localhost:9000'

    s3 = boto3.client('s3', region_name='us-east-1')
    s3.create_bucket(Bucket='testbucket')

    key = upload_photo(42, b'hello')
    assert key.startswith('42/')
    obj = s3.get_object(Bucket='testbucket', Key=key)
    assert obj['Body'].read() == b'hello'

    url = get_public_url(key)
    assert url == f"http://localhost:9000/{key}"
