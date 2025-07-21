from app.services.gpt import call_gpt_vision_stub


def test_gpt_stub_returns_mock():
    resp = call_gpt_vision_stub("photo.jpg")
    assert isinstance(resp, dict)
    assert resp == {
        "crop": "apple",
        "disease": "powdery_mildew",
        "confidence": 0.92,
    }
