from app.services.plan_payload import (
    PlanPayloadError,
    normalize_plan_payload,
)


def test_normalize_plan_payload_basic():
    payload = {
        "kind": "plan_new",
        "object_hint": "🍅 Грядка",
        "diagnosis": {"crop": "tomato", "disease": "blight", "confidence": 0.91},
        "stages": [
            {
                "name": "До цветения",
                "trigger": "до распускания",
                "options": [
                    {
                        "product_name": "Топаз",
                        "dose": "5 мл/10 л",
                        "method": "опрыскивание",
                        "phi_days": 7,
                        "product_code": "TOPAZ-001",
                    },
                    {"product_name": "Раек", "dose_value": 4, "dose_unit": "мл/10л"},
                    {"product_name": "Алирин", "dose_value": 2, "dose_unit": "табл"},
                    {"product_name": "Лишний вариант"},
                ],
            },
            {
                "name": "После дождя",
                "options": [
                    {"product_name": "Хом", "dose": "40 г"},
                ],
            },
        ],
    }

    result = normalize_plan_payload(payload)
    assert result.plan.kind == "PLAN_NEW"
    assert result.data["object_hint"] == "🍅 Грядка"
    assert len(result.data["stages"]) == 2
    first_stage = result.data["stages"][0]
    assert len(first_stage["options"]) == 3  # limited to MAX_OPTIONS_PER_STAGE
    assert first_stage["options"][0]["needs_review"] is False
    assert first_stage["options"][1]["needs_review"] is True  # no product_code
    assert isinstance(result.plan_hash, str)
    assert len(result.plan_hash) == 40  # sha1 hex


def test_normalize_plan_payload_errors():
    payload = {
        "kind": "PLAN_UPDATE",
        "stages": [
            {
                "name": "Этап без опций",
                "options": [],
            }
        ],
    }
    try:
        normalize_plan_payload(payload)
    except PlanPayloadError as exc:
        assert "no valid stages" in str(exc)
    else:
        raise AssertionError("PlanPayloadError was not raised")
