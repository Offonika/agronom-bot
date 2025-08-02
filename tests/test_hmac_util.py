from app.services.hmac import verify_hmac
import hmac
import hashlib


def test_verify_hmac_success():
    body = b'{"ok":true}'
    secret = 'test-hmac-secret'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_hmac(sig, body, secret)


def test_verify_hmac_fail():
    body = b'{"ok":true}'
    secret = 'test-hmac-secret'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert not verify_hmac('bad' + sig[3:], body, secret)

