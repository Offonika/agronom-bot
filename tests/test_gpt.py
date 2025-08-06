from types import SimpleNamespace

import pytest

from app.services import gpt


def _fake_openai_response() -> SimpleNamespace:
    payload = (
        '{"crop":"apple","disease":"powdery_mildew","confidence":0.92}'
    )
    return SimpleNamespace(
        output=[SimpleNamespace(content=[SimpleNamespace(text=payload)])]
    )


def test_call_gpt_vision_parses_response(monkeypatch):
    class _FakeResponses:
        def create(self, **kwargs):  # type: ignore[override]
            return _fake_openai_response()

    monkeypatch.setattr(
        gpt, "_get_client", lambda: SimpleNamespace(responses=_FakeResponses())
    )
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    resp = gpt.call_gpt_vision("photo.jpg")
    assert resp == {
        "crop": "apple",
        "disease": "powdery_mildew",
        "confidence": 0.92,
    }


def test_call_gpt_vision_sends_image_url_object(monkeypatch):
    captured: dict = {}

    class _FakeResponses:
        def create(self, **kwargs):  # type: ignore[override]
            captured["input"] = kwargs["input"]
            captured["timeout"] = kwargs["timeout"]
            return _fake_openai_response()

    monkeypatch.setattr(
        gpt, "_get_client", lambda: SimpleNamespace(responses=_FakeResponses())
    )
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    gpt.call_gpt_vision("some-key")

    image_part = captured["input"][0]["content"][1]
    assert image_part["image_url"] == {"url": "https://example.com/x.jpg"}
    assert captured["timeout"] == 30


def test_get_client_requires_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(gpt, "_client", None)
    monkeypatch.setattr(gpt, "_http_client", None)
    with pytest.raises(RuntimeError):
        gpt._get_client()


def test_client_lazy_init(monkeypatch):
    calls = 0

    class _FakeResponses:
        def create(self, **kwargs):  # type: ignore[override]
            return _fake_openai_response()

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            nonlocal calls
            calls += 1
            self.responses = _FakeResponses()

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(gpt, "OpenAI", _FakeOpenAI)
    monkeypatch.setattr(gpt, "_client", None)
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    gpt.call_gpt_vision("key")
    gpt.call_gpt_vision("key")
    assert calls == 1


def test_call_gpt_vision_empty_output(monkeypatch):
    class _FakeResponses:
        def create(self, **kwargs):  # type: ignore[override]
            return SimpleNamespace(output=[])

    monkeypatch.setattr(
        gpt, "_get_client", lambda: SimpleNamespace(responses=_FakeResponses())
    )
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    with pytest.raises(ValueError):
        gpt.call_gpt_vision("photo.jpg")


def test_call_gpt_vision_timeout(monkeypatch):
    from openai import APITimeoutError
    import httpx

    class _FakeResponses:
        def create(self, **kwargs):  # type: ignore[override]
            raise APITimeoutError(httpx.Request("POST", "https://example.com"))

    monkeypatch.setattr(
        gpt, "_get_client", lambda: SimpleNamespace(responses=_FakeResponses())
    )
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    with pytest.raises(TimeoutError):
        gpt.call_gpt_vision("photo.jpg")


def test_get_client_recreates_after_close(monkeypatch):
    calls = 0

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            nonlocal calls
            calls += 1

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(gpt, "OpenAI", _FakeOpenAI)
    monkeypatch.setattr(gpt, "_client", None)
    monkeypatch.setattr(gpt, "_http_client", None)

    first = gpt._get_client()
    gpt._close_client()
    second = gpt._get_client()

    assert calls == 2
    assert first is not second

