from __future__ import annotations

from types import SimpleNamespace

import pytest
from openai import OpenAIError

from app.services import gpt


def _fake_openai_response(payload: str | None = None) -> SimpleNamespace:
    payload = payload or (
        '{"crop":"apple","crop_ru":"яблоня","disease":"powdery_mildew","disease_name_ru":"мучнистая роса","confidence":0.92,'
        '"reasoning":["Белый налёт по краям листа.","Пятна на верхних листьях"],'
        '"treatment_plan":{"product":"Топаз","substance":"Пенконазол","dosage_value":2,"dosage_unit":"мл/10л",'
        '"dosage":"2 мл/10 л","phi":"30","phi_days":30,"method":"Опрыскивание","safety_note":"Перчатки"},'
        '"next_steps":{"reminder":"Повторить обработку через 7 дней","green_window":"Окно без дождя вечером","cta":"Добавить обработку"},'
        '"need_reshoot":false,"reshoot_tips":[],"need_clarify_crop":false,"clarify_crop_variants":[],'
        '"assistant_ru":"Диагноз готов.","assistant_followups_ru":["Курс лечения: повтор через 10 дней."]}'
    )
    message = SimpleNamespace(content=payload)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


def _fake_client(create_fn):
    chat = SimpleNamespace(completions=SimpleNamespace(create=create_fn))
    return SimpleNamespace(chat=chat)


def test_call_gpt_vision_parses_response(monkeypatch):
    class _FakeCompletions:
        def create(self, **kwargs):  # type: ignore[override]
            return _fake_openai_response()

    monkeypatch.setattr(gpt, "_get_client", lambda: _fake_client(_FakeCompletions().create))
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    resp = gpt.call_gpt_vision("photo.jpg")
    assert resp["crop"] == "apple"
    assert resp["disease"] == "powdery_mildew"
    assert resp["disease_name_ru"] == "мучнистая роса"
    assert resp["confidence"] == 0.92
    assert resp["reasoning"][0].startswith("Белый")
    assert resp["treatment_plan"]["product"] == "Топаз"
    assert resp["next_steps"]["cta"] == "Добавить обработку"
    assert resp["assistant_ru"] == "Диагноз готов."


def test_call_gpt_vision_sends_image_url_object(monkeypatch):
    captured: dict = {}

    def _create(**kwargs):
        captured["messages"] = kwargs["messages"]
        captured["timeout"] = kwargs["timeout"]
        return _fake_openai_response()

    monkeypatch.setattr(gpt, "_get_client", lambda: _fake_client(_create))
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    gpt.call_gpt_vision("some-key", crop_hint="томат")

    image_part = captured["messages"][1]["content"][1]
    assert image_part["image_url"] == {"url": "https://example.com/x.jpg"}
    assert captured["timeout"] == gpt._TIMEOUT_SECONDS
    user_text = captured["messages"][1]["content"][0]["text"]
    assert "Пользователь предполагает культуру: томат" in user_text


def test_call_gpt_vision_retries_without_temperature(monkeypatch):
    class _TemperatureError(OpenAIError):
        def __init__(self) -> None:
            super().__init__("Unsupported value: temperature")
            self.body = {
                "error": {
                    "message": (
                        "Unsupported value: 'temperature' does not support 0.0 with this model."
                        " Only the default (1) value is supported."
                    ),
                    "param": "temperature",
                    "code": "unsupported_value",
                }
            }

    class _FakeCompletions:
        def __init__(self) -> None:
            self.calls = 0

        def create(self, **kwargs):  # type: ignore[override]
            self.calls += 1
            if self.calls == 1:
                assert "temperature" in kwargs
                raise _TemperatureError()
            assert "temperature" not in kwargs
            return _fake_openai_response()

    completions = _FakeCompletions()
    monkeypatch.setattr(gpt, "_get_client", lambda: _fake_client(completions.create))
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")
    monkeypatch.setattr(gpt, "_TEMPERATURE_DISABLED", False)
    monkeypatch.setenv("OPENAI_TEMPERATURE", "0")

    resp = gpt.call_gpt_vision("photo.jpg")
    assert resp["crop"] == "apple"
    assert completions.calls == 2
    assert gpt._TEMPERATURE_DISABLED is True


def test_call_gpt_vision_fallback_on_timeout(monkeypatch):
    models_called: list[str] = []

    def _fake_request(client, model, payload):
        models_called.append(model)
        if len(models_called) == 1:
            raise TimeoutError("timeout")
        return _fake_openai_response()

    monkeypatch.setattr(gpt, "_request_completion", _fake_request)
    monkeypatch.setattr(gpt, "_get_client", lambda: None)
    monkeypatch.setattr(gpt, "_MODEL", "gpt-5")
    monkeypatch.setattr(gpt, "_MODEL_FALLBACK", "gpt-4o-mini")
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    resp = gpt.call_gpt_vision("photo.jpg")
    assert resp["crop"] == "apple"
    assert models_called == ["gpt-5", "gpt-4o-mini"]


def test_call_gpt_vision_raises_timeout_without_fallback(monkeypatch):
    def _fake_request(client, model, payload):
        raise TimeoutError("boom")

    monkeypatch.setattr(gpt, "_request_completion", _fake_request)
    monkeypatch.setattr(gpt, "_get_client", lambda: None)
    monkeypatch.setattr(gpt, "_MODEL", "gpt-5")
    monkeypatch.setattr(gpt, "_MODEL_FALLBACK", None)
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    with pytest.raises(TimeoutError):
        gpt.call_gpt_vision("photo.jpg")


def test_load_timeout_from_env(monkeypatch):
    monkeypatch.setenv("OPENAI_TIMEOUT_SECONDS", "120")
    assert gpt._load_timeout() == 120
    monkeypatch.setenv("OPENAI_TIMEOUT_SECONDS", "invalid")
    assert gpt._load_timeout() == 60
    monkeypatch.setenv("OPENAI_TIMEOUT_SECONDS", "-5")
    assert gpt._load_timeout() == 60
    monkeypatch.delenv("OPENAI_TIMEOUT_SECONDS", raising=False)
    assert gpt._load_timeout() == 60


def test_should_bypass_proxy(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "localhost, api.openai.com ,example.com")
    assert gpt._should_bypass_proxy("api.openai.com")
    assert gpt._should_bypass_proxy("foo.example.com")
    assert not gpt._should_bypass_proxy("openai.com")


def test_get_client_requires_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(gpt, "_client", None)
    monkeypatch.setattr(gpt, "_http_client", None)
    with pytest.raises(RuntimeError):
        gpt._get_client()


def test_client_lazy_init(monkeypatch):
    calls = 0

    class _FakeCompletions:
        def create(self, **kwargs):  # type: ignore[override]
            return _fake_openai_response()

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            nonlocal calls
            calls += 1
            chat = SimpleNamespace(completions=_FakeCompletions())
            self.chat = chat

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(gpt, "OpenAI", _FakeOpenAI)
    monkeypatch.setattr(gpt, "_client", None)
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    gpt.call_gpt_vision("key")
    gpt.call_gpt_vision("key")
    assert calls == 1


def test_call_gpt_vision_empty_output(monkeypatch):
    class _FakeCompletions:
        def create(self, **kwargs):  # type: ignore[override]
            return SimpleNamespace(choices=[])

    monkeypatch.setattr(gpt, "_get_client", lambda: _fake_client(_FakeCompletions().create))
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    with pytest.raises(ValueError):
        gpt.call_gpt_vision("photo.jpg")


def test_call_gpt_vision_timeout(monkeypatch):
    from openai import APITimeoutError
    import httpx

    def _create(**kwargs):  # type: ignore[override]
        raise APITimeoutError(httpx.Request("POST", "https://example.com"))

    monkeypatch.setattr(gpt, "_get_client", lambda: _fake_client(_create))
    monkeypatch.setattr(gpt, "get_public_url", lambda key: "https://example.com/x.jpg")

    with pytest.raises(TimeoutError):
        gpt.call_gpt_vision("photo.jpg")


def test_get_client_recreates_after_close(monkeypatch):
    calls = 0

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            nonlocal calls
            calls += 1
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: _fake_openai_response()))

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(gpt, "OpenAI", _FakeOpenAI)
    monkeypatch.setattr(gpt, "_client", None)
    monkeypatch.setattr(gpt, "_http_client", None)

    first = gpt._get_client()
    gpt._close_client()
    second = gpt._get_client()

    assert calls == 2
    assert first is not second


def test_sanitize_plan_accepts_substance():
    from app.services import gpt

    plan = gpt._sanitize_plan({"substance": "сера"})  # type: ignore[attr-defined]
    assert plan is not None
    assert plan["substance"] == "сера"


def test_sanitize_plan_rejects_empty():
    from app.services import gpt

    plan = gpt._sanitize_plan({})  # type: ignore[attr-defined]
    assert plan is None
