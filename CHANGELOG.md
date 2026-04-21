# Changelog

## [1.20.0] — 2026-01-02

### Added
- feat: AI-ассистент теперь доступен только для Pro-подписчиков и beta-пользователей. Free-пользователи видят paywall с CTA «Попробовать Pro» при вызове `/assistant`.
- feat: добавлен метод `db.hasAssistantAccess(userId)` для проверки доступа (Pro или beta bypass).
- feat: событие `assistant_paywall_shown` логируется для аналитики конверсии в Pro.
- docs: обновлён SRS §4.6 с описанием ограничений доступа к ассистенту.

## [Unreleased] — 2025-11-13

### Added
- chore: добавлены новые Codex skills: `agro-doc-sync`, `agro-openapi-contract-guard`, `agro-rag-ingest-quality`, `agro-rag-retrieval-eval`.
- chore: добавлен оркестратор `scripts/agent_orchestrator.sh` для автозапуска проверок по изменённым путям (`app`, `bot`, `openapi`, `load`, `docs`).
- ci: добавлен workflow `.github/workflows/agent-orchestrator.yml` с автозапуском на `push/pull_request` в `develop` и ручным `workflow_dispatch`.
- feat: добавлен базовый RAG-слой для живого ассистента: таблица `knowledge_chunks` (pgvector), retrieval по cosine similarity и передача найденных фрагментов в LLM-контекст.
- feat: добавлен скрипт `scripts/load_knowledge_chunks.py` для загрузки manifest/chunks JSONL в `knowledge_chunks` с эмбеддингами OpenAI.
- feat: добавлены `scripts/rag_preflight.py` (проверка DB/pgvector/knowledge_chunks) и `scripts/rag_smoke_check.py` (E2E smoke retrieval).
- feat: план памяти (draft → proposed → accepted → scheduled) и автопланирование «зелёных окон» (MVP).
- feat: карточка автоплана с кнопками «Принять/Выбрать другое время/Отменить», обновлённый воркер и интерактивная обработка слотов.
- feat: быстрый ручной выбор времени (сегодня вечером/завтра утром/выбрать дату) с напоминаниями, если автоплан недоступен.
- feat: `plan_sessions` теперь фиксируют шаги времени (fallback manual start, `time_scheduled`) и бот умеет восстанавливать карточку «Шаг 3/3» после пауз.
- feat: раздел «📋 Мои планы» даёт краткий обзор ближайших обработок, выделяет блок «Просроченные» (с группировкой и bulk-действиями), а перенос отправляет пользователя в ручной выбор времени; команды `/new`, `/plans`, `/objects` закреплены в меню Telegram и бот шлёт push-уведомления при накоплении просрочек.
- feat: события воронки (`photo_received → slot_confirmed`) + SQL-отчёт (`docs/LOGGING.md`) для мониторинга конверсии.
- feat: дефолтный follow-up без повторяющейся первой фразы + справочник ключевых слов для продолжения диалога.
- feat: аудит `assistant_proposals` (таблица + статус) и Prometheus-метрики/алерты для error-rate живого ассистента.
- feat: beta-режим комнатных растений с онбордингом, мини-опросом и follow-up, плюс логирование beta-метрик/фидбеков.
- feat: в /edit добавлен быстрый выбор активного растения для редактирования.
- feat: единый экран согласий (ПДн + Оферта), отдельное подтверждение автопродления и обновлённый UX подписки с аудитом consent meta.
- feat: платежи получили idempotency key, хранение payment/sbp URL и серверную проверку согласий.
- feat: повторная проверка «то же растение?» с привязкой к кейсу и без списания лимита.
- feat: персистентные paywall‑напоминания (таблица + шедулер) и лимит 1 активного напоминания для Free.
- feat: история в Free ограничена текущим кейсом, Pro получает полный список.
- feat: Tinkoff Init поддерживает передачу Receipt для тестов ФФД (налоговый режим osn по умолчанию).
- docs: обновлены PRD/SRS, добавлены схемы данных, API-контракты, алгоритм автопланировщика, UX-потоки, правила каталога и логирования.
- docs: README и UX flows описывают карточку автоплана (успешный и fallback-путь «Шаг 3/3») и ручной мастер времени.

### Configuration
- добавлены `ASSISTANT_RAG_ENABLED`, `ASSISTANT_RAG_TOP_K`, `ASSISTANT_RAG_MIN_SIMILARITY`, `ASSISTANT_RAG_IVFFLAT_PROBES`, `OPENAI_RAG_EMBEDDING_MODEL` для управления retrieval-слоем ассистента.
- добавлены optional-флаги retrieval-фильтрации: `ASSISTANT_RAG_FILTER_LANG`, `ASSISTANT_RAG_FILTER_CATEGORY`, `ASSISTANT_RAG_MAX_CHUNKS_PER_SOURCE`.
- `.env.example` дополнен переменными `REMINDER_TICK_MS`, `REMINDER_DEFAULT_DELAY_H`, `AUTOPLAN_MIN_HOURS_AHEAD`, `WEATHER_PROVIDER`, `CATALOG_IMPORT_PATH`.
- добавлен `BOT_HANDLER_TIMEOUT_MS`, чтобы управлять лимитом выполнения хендлеров Telegraf (значение `0`/отрицательное отключает таймаут).
- добавлены `OBJECT_CHIPS_ROW_SIZE` и `OBJECT_CHIPS_LIMIT` для настройки раскладки быстрых чипов объектов.
- добавлены `BETA_HOUSEPLANTS_ENABLED`, `BETA_TESTER_IDS`, `BETA_FOLLOWUP_DAYS`, `BETA_FOLLOWUP_RETRY_DAYS` для beta-теста.
- добавлены `SBP_TINKOFF_TAXATION`, `SBP_TINKOFF_RECEIPT_EMAIL`, `SBP_TINKOFF_RECEIPT_PHONE`, `SBP_TINKOFF_RECEIPT_ITEM_NAME`, `SBP_TINKOFF_RECEIPT` для передачи чека в Tinkoff Init.
- добавлена `BETA_SURVEY_COMMENT_TTL_MS` (default 600000 мс) для ограничения окна текстового комментария Q3 и снижения «залипания» опроса.
- добавлена `FAQ_REGION_PROMPT_TTL_MS` (default 900000 мс) для окна ожидания региона после CTA «Спросить про препараты».
- добавлены restart-safe Redis key prefixes `ASSISTANT_SESSION_REDIS_PREFIX`, `REGION_PROMPT_REDIS_PREFIX` и `BETA_SURVEY_COMMENT_REDIS_PREFIX` для восстановления stateful bot-flow после рестарта.

### Fixed
- fix(assistant): устранена потеря нити после смены контекста в чате — сессии ассистента в боте теперь консистентно ключуются по `tg_id`, а отложенный вопрос корректно переигрывается после выбора объекта.
- fix(assistant): добавлена передача `metadata.history` (до 24 реплик) bot→backend→LLM, чтобы ответы учитывали предыдущие сообщения в рамках сессии.
- fix(diagnose): для follow-up с валидным `case_id` backend автоматически подставляет `cases.crop` как fallback `crop_hint`, если явный hint не передан.
- fix(rag): compose DB переведён на `pgvector/pgvector:pg15`; миграция `knowledge_chunks` теперь strict PostgreSQL+pgvector и падает с явной диагностикой при отсутствии extension.
- fix(rag-loader): загрузчик поддерживает `--database-url`, инкрементальный режим `--only-new` (default), batch upsert, retry/backoff embeddings, валидацию manifest/chunks и отчёт `inserted/updated/skipped/failed`.
- fix(rag-retrieval): добавлены dedup по `source_url`, optional lang/category-фильтры и логирование probes/hit-rate.
- fix(gpt): `call_gpt_embeddings` сохраняет порядок входов даже при пустых строках и валидирует размер ответа.
- fix(bot): reply-фото на сообщение бота с валидным диагнозом (TTL 72ч) автоматически активирует follow-up; фото маршрутизируется в follow-up статус без возврата в первичный чеклист `1/8, минимум 3`.
- fix(plan): кнопка из карточки диагноза теперь передаёт `plan_treatment|<diagnosis_id>`; обработчик жёстко связывает план с выбранным diagnosis/object, legacy `plan_treatment` сохранён.
- fix(plan): для indoor-объектов добавлена policy-фильтрация погодных стадий (`rain/осадки`) как для catalog, так и для machine plan; при пустом результате подставляется безопасный indoor fallback-stage.
- fix(qa): мастер `/qa` принимает поле только reply на конкретный prompt-message-id (`awaitingReplyToMessageId`), при mismatch возвращает `qa_intake_reply_required` без сброса шага и игнорирует параллельные callbacks в режиме awaitingField.
- fix(location): после `/location` и `plan_location_geo` бот показывает быстрый `request_location` keyboard; после получения геометки убирает reply-keyboard (`remove_keyboard`).
- fix(gpt-risk): добавлен пост-guard для mealybug без подтверждающих признаков (снижение confidence, `need_reshoot=true`, нейтральный режим без преждевременной химии) + усиление системного prompt.
- fix(bot): добавлен персистентный fallback reply-контекста (`diagnosis_message_contexts`): после рестарта бота reply-фото всё равно восстанавливает связанный diagnosis/object без возврата в primary-flow.
- fix: устранена массовая `Ошибка диагностики` у новых пользователей — `ensureUser` теперь гарантирует `users.api_key`, добавлен backfill `20260211_backfill_user_api_keys` для существующих `NULL`.
- fix: в мультифото-флоу подборка 3–8 фото больше не очищается после неуспешного анализа; очистка выполняется только при `analyzePhoto.ok=true`.
- fix: добавлено уникальное ограничение на `users.tg_id`, чтобы `ON CONFLICT (tg_id)` в bot API не падал в окружениях без индекса.
- fix: Alembic теперь подтягивает core-таблицы (`objects`, `cases`, `plan_stages`, `reminders`, `autoplan_runs` и т.д.) через общий SQL-скрипт, так что бот не падает на `relation ... does not exist`.
- fix: bot перестаёт обрывать обработку фото на 90‑й секунде — таймаут Telegraf теперь настраивается через `BOT_HANDLER_TIMEOUT_MS` (по умолчанию 180 000 мс).
- fix(security): per-user API keys + подпись запросов с `X-Req-*` и защитой от replay через Redis.
- fix: восстановлена интеграция живого ассистента в боте (chat + подтверждение предложений через API).
- fix: бот трактует `bank_error` как финальный статус платежа и сообщает об ошибке сразу.
- fix: возврат/отмена после `success` корректно откатывает последнюю подписку.
- fix: beta-опрос больше не перехватывает рабочие сообщения про регион/препараты и не блокирует последующий диалог (включая reply на подсказку «назовите регион»).
- fix: после CTA «Спросить про препараты» бот принимает короткий ответ с регионом (например, «Москва») даже без reply и даёт явный следующий шаг через кнопку «Спросить ассистента».
- fix: для гипотез по воде/грунту бот добавляет блок уточнения (фото поверхности грунта + дренажа, проверка влажности 2–3 см) и смягчает сценарий «промывки грунта» до условной рекомендации при подтверждённом засолении.
- fix: при риске перелива/подгнивания бот добавляет отдельный алгоритм проверки корней (включая шаг извлечения из горшка) и безопасные действия после подтверждения.
- fix: для кейсов «пятна на листьях» бот добавляет triage-чеклист: тип пятен (по краю/по листу/точечно/цепочкой), проверка ожога после опрыскивания на солнце, проверка прокусов в макро, а также безопасная развилка «залив/хлороз/пересушка».
- fix: в ветке вода/грунт бот учитывает влагоёмкость и структуру субстрата (поведение воды в поддоне + состав смеси) и корректно отвечает на короткие статусы пользователя («мокро/сухо/влажно», тип грунта) без ухода в общий fallback.
- fix: после ввода региона в сценарии «Спросить про препараты» бот теперь сразу присылает краткий ответ по препаратам/ДВ для текущего диагноза (а не только подтверждение региона) и оставляет кнопку ассистента.
- fix(bot): stateful text-flow доведены до restart-safe поведения: региональный FAQ prompt, beta survey Q3 и live assistant восстанавливают состояние из Redis и больше не протекают в общий роутинг после рестарта.
- fix: `same_plant` в мультифото теперь учитывает активный объект (`users.last_object_id`) и не подмешивает чужой последний кейс пользователя при досылке фото.
- fix: добавлен follow-up режим «📎 Дослать фото к этому разбору»: в течение 72 часов бот возобновляет диагностику по исходному `case_id/object_id`, не спрашивает повторно «это то же растение?» и сохраняет нить кейса при досъёмке.
- fix: follow-up можно запускать напрямую из «Мои растения» по активному объекту (кнопка `diag_followup_active`), без поиска старого сообщения с диагнозом.
- fix: устранено зависание `Диагностика в очереди`: добавлен production-сервис `retry_diagnosis` (Python runner), который реально дообрабатывает `photos.status in ('pending','retrying')` через GPT (без `gpt_stub`), обновляет `retry_attempts/status` и выгружает backlog.
- fix: для мультифото в `/v1/ai/diagnose` теперь отправляется и анализируется вся подборка (до 8 кадров) одним запросом; комплексный ответ строится по всем фото, а не по одному кадру.
- fix: для low-confidence (`confidence < 0.65`) бот запускает обязательный re-check (минимум 2 фото: макро симптома + изнанка), скрывает жёсткие CTA планирования до пересъёмки и автоматически сохраняет follow-up контекст кейса.
- fix: добавлен anti-hallucination guard в форматтер диагноза: при низкой уверенности смягчаются категоричные утверждения по видимости и скрываются рискованные «агрессивные» шаги до досъёмки.
