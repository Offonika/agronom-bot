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

