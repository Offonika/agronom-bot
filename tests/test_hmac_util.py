from app.services.hmac import verifyHmac
import hmac
import hashlib


def test_verify_hmac_success():
    body = b'{"ok":true}'
    secret = 'test-hmac-secret'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verifyHmac(sig, body, secret)


def test_verify_hmac_fail():
    body = b'{"ok":true}'
    secret = 'test-hmac-secret'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert not verifyHmac('bad' + sig[3:], body, secret)

