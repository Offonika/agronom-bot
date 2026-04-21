from app.services import assistant_orchestrator


def test_finalize_assistant_text_strips_inline_followups_and_plan_number():
    answer = (
        "Если всё верно — нажмите «📋 Открыть план #50».\n"
        "Можно спросить:\n"
        "• Как сейчас поливаете?\n"
        "• Есть ли запах?"
    )
    followups = ["Когда был последний полив?", "Можно спросить:"]

    clean_answer, clean_followups = assistant_orchestrator._finalize_assistant_text(
        answer,
        followups,
        user_message="Что делать дальше?",
    )

    assert "#50" not in clean_answer
    assert "Можно спросить" not in clean_answer
    assert "Как сейчас поливаете" not in clean_answer
    assert clean_followups == ["Когда был последний полив?"]


def test_finalize_assistant_text_drops_chemistry_block_without_request():
    answer = (
        "Поливайте после просушки верхнего слоя.\n"
        "Медь/фунгицид сейчас не нужен."
    )

    clean_answer, _ = assistant_orchestrator._finalize_assistant_text(
        answer,
        [],
        user_message="Чем и как удобрять?",
    )

    assert "поливайте" in clean_answer.lower()
    assert "фунгицид" not in clean_answer.lower()
    assert "медь" not in clean_answer.lower()


def test_finalize_assistant_text_keeps_chemistry_block_on_direct_question():
    answer = "Медь/фунгицид сейчас не нужен."

    clean_answer, _ = assistant_orchestrator._finalize_assistant_text(
        answer,
        [],
        user_message="Нужен ли фунгицид?",
    )

    assert "фунгицид" in clean_answer.lower()


def test_finalize_assistant_text_normalizes_form_of_address():
    answer = "Сейчас у тебя какой сезон и как поливаешь?"

    clean_answer, _ = assistant_orchestrator._finalize_assistant_text(
        answer,
        [],
        user_message="Чем удобрять?",
    )

    assert "у Вас" in clean_answer
    assert "тебя" not in clean_answer.lower()


def test_normalize_dialog_history_filters_invalid_and_limits_size():
    raw = [{"role": "system", "text": "ignore"}]
    raw.extend({"role": "user", "text": f"msg-{idx}"} for idx in range(30))
    raw.append({"role": "assistant", "text": "  "})

    normalized = assistant_orchestrator._normalize_dialog_history(raw)

    assert len(normalized) == 24
    assert normalized[0]["text"] == "msg-6"
    assert normalized[-1]["text"] == "msg-29"
    assert all(item["role"] == "user" for item in normalized)


def test_build_llm_context_includes_dialog_history(monkeypatch):
    monkeypatch.setattr(assistant_orchestrator.knowledge_rag, "build_llm_knowledge_context", lambda _msg: [])
    ctx = assistant_orchestrator.AssistantContext(
        user_id=1,
        object_id=None,
        objects=[],
        recent_diagnosis=None,
        latest_plan=None,
        latest_events=[],
        dialog_history=[
            {"role": "user", "text": "Как спасти фикус?"},
            {"role": "assistant", "text": "Проверьте влажность грунта."},
        ],
    )

    llm_context = assistant_orchestrator._build_llm_context(
        ctx,
        object_label="растения",
        answer="fallback",
        followups=["Нужен осмотр корней?"],
        proposals=[],
        user_message="Листья желтеют",
    )

    assert llm_context["dialog_history"] == ctx.dialog_history
