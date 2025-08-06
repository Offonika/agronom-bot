from types import SimpleNamespace

from app.services import gpt


def _fake_openai_response() -> SimpleNamespace:
    payload = (
        '{"crop":"apple","disease":"powdery_mildew","confidence":0.92}'
    )
    return SimpleNamespace(
        output=[SimpleNamespace(content=[SimpleNamespace(text=payload)])]
    )


def test_call_gpt_vision_parses_response(tmp_path, monkeypatch):
    img = tmp_path / "photo.jpg"
    img.write_bytes(b"data")

    class _FakeResponses:
        def create(self, **kwargs):  # type: ignore[override]
            return _fake_openai_response()

    monkeypatch.setattr(gpt, "client", SimpleNamespace(responses=_FakeResponses()))

    resp = gpt.call_gpt_vision(str(img))
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
            return _fake_openai_response()

    monkeypatch.setattr(
        gpt,
        "client",
        SimpleNamespace(responses=_FakeResponses()),
    )
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    gpt.call_gpt_vision("some-key")

    image_part = captured["input"][0]["content"][1]
    assert image_part["image_url"] == {"url": "https://example.com/x.jpg"}

