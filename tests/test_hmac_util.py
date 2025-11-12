from __future__ import annotations
from app.services.hmac import verify_hmac
import hmac
import hashlib
import pytest


@pytest.mark.parametrize("secret", ["test-hmac-secret", "test-hmac-partner"])
def test_verify_hmac_success(secret):
    body = b'{"ok":true}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_hmac(sig, body, secret)


@pytest.mark.parametrize("secret", ["test-hmac-secret", "test-hmac-partner"])
def test_verify_hmac_fail(secret):
    body = b'{"ok":true}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert not verify_hmac('bad' + sig[3:], body, secret)
