System Requirements Specification (SRS)

Проект: Telegram‑бот «Карманный агроном» (MVP)

Версия: 1.23 — 9 апреля 2026 г. (v1.22 → v1.23: restart-safe bot session hardening)

1 · Scope

Система «Карманный агроном»:

Принимает фотографии листьев ≤ 2 МБ (JPEG).

Перед началом съёмки показывает подсказки «Как сфоткать» (общий вид, лист лицевая, лист изнанка, плод/цветок или корень по ситуации).

Собирает медиагруппу 3–8 фото и запускает анализ только после базового минимума: общий вид + лист (лицевая) + лист (изнанка); плод/цветок и корень остаются опциональными. В API уходит вся подборка, а не один кадр: модель делает комплексный разбор по общему виду и деталям. Показывает чеклист и предлагает дослать недостающие фото или пропустить опциональные кадры. Подборка очищается по таймауту 30 мин и после успешного анализа; при ошибке диагностики сохраняется для повторной отправки. Для low-confidence (`confidence < 0.65`) бот автоматически запускает re-check: просит минимум 2 уточняющих фото (макро симптома + изнанка листа) и не показывает «жёсткие» CTA планирования до повторного анализа. Follow-up «Дослать фото к этому разбору» доступен из карточки диагноза и из экрана «Мои растения» по активному объекту: на 72 часа открывается режим, который привязывает новые фото к исходному кейсу/объекту и не задаёт повторно вопрос «это то же растение?». Если фото отправлено reply на сообщение бота с активным диагнозом (до 72 часов), follow-up режим включается автоматически и фото не попадает в первичный чеклист «минимум 3». Для объектов `type=indoor` план-стадии с погодными триггерами (`дождь/осадки/rain_mm`) отфильтровываются.

Отправляет JPEG в GPT‑Vision; получает диагноз {crop, disease, confidence, reasoning, treatment_plan, next_steps}.

Формирует план обработки, опираясь на официальные нормы и зарегистрированные препараты РФ (PHI), ведёт дневник и напоминания, учитывает погоду/регион.

Различает Free и Pro: Free — 1 кейс/неделю (первые 24 ч безлимит), повторная проверка того же растения в течение 10 дней не списывает кейс, low confidence (<0.6) не списывает; напоминания — 1 активное, история — текущий кейс. Pro — безлимит кейсов, AI‑ассистент, вся история и напоминания без ограничений, более точная модель, курсы 1–3 с автопереносом по погоде и альтернативными рекомендациями, если базовый курс не помог.

Сверяет диагноз с локальной БД протоколов Минсельхоза РФ.

Если найдено — показывает препарат, дозу, PHI + ROI‑калькулятор (экономия ₽/га).

Если не найдено — бейдж «Бета — подтвердить у агронома» и ссылка на поддержку; низкая уверенность сопровождается блоком «Пересъёмка / уточнить культуру».

Продаёт Pro‑Month (199 ₽/мес) через Bot Payments → SBP (Тинькофф). Опционально поддерживает Lifetime (единовременная бессрочная покупка), если доступно в канале оплаты.

Автоплатёж SBP — только после явного согласия (opt‑in); бот уведомляет за 3 дня до списания. Отмена через /cancel_autopay.

При превышении лимита кейсов API возвращает 402 PAYWALL → бот показывает окно оплаты и может поставить напоминание «через N дней» (персистентно).

Для beta‑тестеров комнатных растений лимит не блокирует (402 не отдаём), usage считается для аналитики.

Ведёт историю снимков: Free — текущий кейс, Pro — полный список (/history).

Принимает обращения через /support и пересылает сообщения пользователей в Telegram‑чат поддержки (SUPPORT_CHAT_ID). Сессия /support хранится restart-safe в Redis с TTL; если окно ответа истекло или контекст потерян, бот явно пишет, что сессия прервалась, и не маршрутизирует текст в ассистента/FAQ.

ML‑датасет: фото старше 90 дней копируются в обезличенный бакет ml-dataset только при согласии пользователя.

Хранит координаты объекта (lat/lon в objects.meta) с валидацией диапазона; команда /location и кнопки «Обновить координаты» позволяют вручную указать геолокацию (точка или адрес). При отсутствии координат автоплан использует дефолтные из env и предлагает обновить; воркер логирует источник и фактические координаты (manual/geo_auto/default) для мониторинга доли дефолтов. При активном запросе бот явно пишет, что ждёт точку/адрес не дольше 2 минут и даёт CTA «Пропустить». После `/location` и `plan_location_geo` показывается быстрый reply-keyboard `request_location` («📍 Отправить геопозицию»), после получения геоточки клавиатура убирается (`remove_keyboard`). Сессия обновления координат хранится restart-safe в Redis с TTL и всегда привязана к исходному `object_id`: при потере/истечении контекста бот возвращает `expired/no_request`, а геоточка или адрес не применяются к «последнему объекту» по fallback.

При автодетекте бот предлагает подтверждение «Нашли участок возле …?» с кнопкой карты (OSM), учитывая rate-limit геокодера, TTL 12 ч на подтверждение и защиту от спама (повтор не чаще 30 мин). Geo-запросы логируются.

Out-of-scope (MVP): нативные приложения, on-device CV, карта полей, white-label SDK.

2 · Glossary

Term

Definition

GPT‑Vision

API OpenAI для анализа изображений, возвращает JSON‑диагноз.

Protocol

Запись: crop, disease, product, dosage_value, dosage_unit, phi, registry_date.

Pro

Платный доступ с расширенными лимитами и функциями (точнее модель, курсы 1–3 с автопереносом), 199 ₽/мес.

PHI

Pre‑Harvest Interval — срок ожидания до сбора урожая, дней.

ROI

(expected_loss₽ – cost_treatment₽) / ha.

Autopay SBP

Механизм регулярных списаний по СБП с привязкой счёта пользователя.

3 · Functional Requirements

ID

Description

Priority

FR‑T‑01

Приём изображения ≤ 2 МБ

High

FR‑T‑02

POST /v1/ai/diagnose → диагноз

High

FR‑T‑03

Отправка карточки диагноза + ROI

High

FR‑T‑04

Кнопка «Протокол» / бейдж «Бета»

High

FR‑T‑05

Paywall + покупка Pro через Bot Payments (SBP Тинькофф) с idempotency для повторов; опционально Lifetime (бессрочная покупка), если доступно провайдером

High

FR‑T‑06

Лимит 1 кейса/неделю для Free (GET /v1/limits); повторная проверка того же растения в пределах 10 дней кейс не списывает

High

FR‑T‑07

История снимков /history (cursor‑pagination)

High

FR‑T‑08

Блок «Пересъёмка / уточнить культуру» (советы, CTA «Переснять фото», ссылка на поддержку)

Medium

FR‑T‑09

Webhook партнёра /v1/partner/orders

Medium

FR‑T‑10

ROI‑калькулятор: yield_loss%, price₽, cost₽

Medium

FR‑T‑11

Опция автопродления Pro (/autopay/enable, /autopay/disable) — только при явном согласии пользователя (opt‑in) + уведомление за 3 дня до списания

Medium

FR‑T‑12

Экспорт / удаление данных (/v1/users/{id}/export)

Medium

FR‑T‑13

План обработки опирается на официальные нормы и зарегистрированные препараты РФ (учёт PHI и региона)

High

FR‑T‑14

Дифференциация Free/Pro: Free — 1 кейс/неделю + 1 активное напоминание + история текущего кейса; Pro — безлимит кейсов, ассистент, вся история и напоминания без ограничений, более точная модель, курсы 1–3 с автопереносом по погоде и альтернативным планом при неудаче базового курса

High

FR‑T‑15

Подсказки «Как сфоткать» (4 карточки: общий вид, лицевая сторона листа, изнанка, плод/цветок/корень), кнопка доступна в /new и мастере загрузки, отправляется не чаще 1 раза за сессию

High

FR‑T‑16

Мультифото: бот принимает медиагруппу или последовательные фото, требует минимум 3 кадра (общий + лицевая + изнанка листа), опционально плод/цветок и корень; лимит 8 фото; чеклист и кнопки «Добавить фото» / «Пропустить» / «Готово — анализ». При запуске диагностики в API передаётся вся подборка (до 8 файлов), чтобы ответ строился по комплексному анализу всех кадров; fallback на один кадр используется только для legacy-клиентов. Для `confidence < 0.65` запускается обязательная досъёмка (минимум 2 фото: макро симптома + изнанка), и только после повторного анализа доступны CTA планирования. Подборка очищается только при успешном запуске анализа (или по TTL), при ошибке остаётся активной. «Дослать фото к этому разбору» доступна из карточки диагноза и через «Мои растения» для активного объекта: включается follow-up режим (TTL 72 часа), в котором сессия фото автоматически ссылается на предыдущий `case_id`/`object_id`.

High

FR‑T‑17

У объектов есть координаты (lat/lon в meta) с валидацией диапазона; пользователь может обновить их через /location или кнопки «Обновить координаты». Сессия запроса адреса/геоточки истекает, бот предлагает повторить при таймауте. Для geo-path используется быстрый request-location keyboard с явным CTA отправки точки; адрес остаётся fallback. Состояние /location хранится restart-safe в Redis с TTL и применяет ответ строго к исходному объекту, без fallback на `last_object_id`.
Сорт/культивар и метка участка сохраняются в objects.meta.variety/meta.note; бот запрашивает их после создания объекта и выводит в чипах/«Мои планы». В меню «Мои растения» доступны переименование и удаление объекта; при наличии активных планов бот предлагает удалить объект вместе с их отменой. Для ввода сорта/метки/нового имени бот использует reply-only prompt: ответ принимается только реплаем на конкретное сообщение бота и истекает по TTL.

High

FR‑T‑18

Автодетект локации предлагает карточку с картой (OSM) для подтверждения/изменения; geocoder кешируется, ограничен по пользователям, запросы логируются; повторные карточки не чаще 30 мин, подтверждение актуально 12 ч.

High

FR‑T‑19

Диагноз не привязывается к last_object_id автоматически: если объект не указан, бот предлагает шаг «Создать новое растение» / «Выбрать растение» и сохраняет выбранный объект в recent_diagnoses. При отсутствии объектов создаётся новый с метаданными культуры/сорта (variety). Повторный запуск /plan_treatment по тому же диагнозу не плодит параллельные сессии выбора объекта. CTA из карточки диагноза передаёт `plan_treatment|<diagnosis_id>` и план строится строго для этого diagnosis/object; legacy callback `plan_treatment` остаётся поддержан.

High

FR‑B‑01

Beta‑режим комнатных растений: при первом /start для тестеров (или для всех при `BETA_OPEN_ALL=true`) — онбординг, подсказка выбора indoor‑объекта; после первого диагноза — мини‑опрос (Q1/Q2, Q3 опционально) и follow‑up через N дней с одним ретраем при отсутствии ответа; paywall для beta не блокирует, метрики сохраняются в beta_events/feedback таблицах. Окно для текстового ответа на Q3 ограничено TTL (`BETA_SURVEY_COMMENT_TTL_MS`, по умолчанию 10 минут), pending-состояние этого шага хранится restart-safe в Redis, а сообщения с интентом «регион/препараты/лечение» не должны перехватываться опросом.

High

FR‑B‑02

Команда /support принимает сообщение пользователя и пересылает его в чат поддержки Telegram. Состояние ожидания сообщения хранится restart-safe в Redis с TTL; при истечении или потере контекста бот явно возвращает `support_expired` и не отдаёт такой текст в другие текстовые сценарии.

Medium

FR‑B‑03

QA‑intake в выделенной группе через `/qa`: основной сценарий — кнопочный мастер (сценарий, тип ошибки, критичность) + опциональные поля (растение, ожидание/факт, комментарий, уверенность, diagnosis_id). Сохраняется fallback‑ввод строкой (`/qa ...` и `#qa ...`). Кейс сохраняется даже без найденного diagnosis_id; при наличии recent_diagnosis бот делает мягкую авто‑привязку и пишет качество связи в payload. Для шагов `qa_add:*` значение поля принимается только reply на конкретный prompt-message-id (`awaitingReplyToMessageId`), при mismatch шаг не сбрасывается и возвращается `qa_intake_reply_required`.

Medium

Copy / Tone requirements:

- GPT-ответ формируется дружелюбным голосом ассистента («Давай», «Советую», «Обрати внимание»), без Markdown-кодовых блоков.
- Формат по умолчанию: «кратко + действия» (1–2 строки вывода, 3 шага, 1 уточняющий вопрос). Полный разбор открывается кнопкой «📋 Подробнее».
- Каждое сообщение содержит CTA: «Добавить обработку» или «Выбрать окно» при confidence ≥ 0.6, либо «Переснять фото» в блоке low-confidence.

4 · API Contracts

4.1 Endpoints

POST /v1/ai/diagnose

GET /v1/photos

GET /v1/limits
GET /v1/users/{id}/consents
POST /v1/users/{id}/consents/accept
POST /v1/users/{id}/consents/revoke

POST /v1/assistant/chat — живой ассистент (LLM chat + tool-calls)

POST /v1/assistant/confirm_plan — фиксация предложений ассистента в plan/event/reminder

POST /v1/payments/sbp/webhook — Тинькофф

POST /v1/payments/sbp/autopay/webhook — Тинькофф (регулярные списания)

POST /v1/partner/orders

4.2 Telegram-команды и кнопки

 - «💬 Задать вопрос ассистенту» — вход в режим живого ассистента; использует активный объект и последние диагнозы/plans/events, не ломая мастер по фото.
- `/history` — история снимков (cursor‑pagination).
- `/support` — обращение в поддержку (сообщение пересылается в чат поддержки Telegram).
- `/qa` — QA‑мастер кейсов (виден в меню только QA‑группы; в остальных чатах не рекламируется).
- `/cancel_autopay` — отключение автоплатежа (opt‑out).
- «Как сфоткать?» — кнопка в мастере /new и приёмнике фото, отправляет 4 карточки подсказок раз в сессию.
- «Добавить фото» / «Пропустить» / «Готово — анализ» — этап сборки медиагруппы (минимум 3 фото).
- `/location` — обновить координаты объекта; кнопки «📍 Геолокация» / «⌨️ Ввести адрес» / «✏️ Обновить координаты» в мастере планов.
- Inline CTA: «Запланировать обработку», «Спросить про препараты», «Переснять фото», «📌 Зафиксировать» (подтверждение предложений ассистента), «📋 Подробнее» (полный разбор текущего диагноза).
- После CTA «Спросить про препараты» бот ждёт регион в следующем сообщении (например, «Москва») в пределах TTL и не должен требовать обязательный reply на предыдущий текст. После получения региона бот сразу отправляет краткий ответ по препаратам/ДВ для текущего диагноза и кнопку «Спросить ассистента» для углубления.
- Если после диагноза пользователь отправляет вопрос текстом без распознанного интента, бот автозапускает ассистента; иначе показывает CTA «Спросить ассистента».
- Экспорт PDF доступен в карточке плана из раздела «📋 Мои планы».

4.3 Schemas (excerpt)

DiagnosisResponse:
  crop: string
  crop_ru: string?
  variety: string?
  variety_ru: string?
  object_id: int?
  disease: string
  disease_name_ru: string?
  confidence: number # 0‑1
  reasoning: [string]
  treatment_plan:
    product: string
    dosage: string?
    dosage_value: number?
    dosage_unit: string?
    phi: string?
    phi_days: int?
    safety: string?
  next_steps:
    reminder: string
    green_window: string
    cta: string
  roi:
    economy_per_ha: number
    currency: "RUB"
  need_reshoot: bool?
  reshoot_tips: [string]?
  plan_hash: string?
  plan_kind: enum?

PaymentWebhook:
  id: string  # invoice id
  amount: int # копейки
  status: enum {SUCCESS, FAIL, CANCEL}
  signature: string # HMAC‑SHA256

4.4 Errors

HTTP

Code

Description

400

BAD_REQUEST

Неверное изображение или тело запроса

402

PAYWALL

Требуется подписка Pro

429

LIMIT_EXCEEDED

Превышена квота

502

GPT_TIMEOUT

GPT не ответил за 10 с

4.5 План памяти и автопланирование

#### 4.5.1 Машинный пакет ответа ИИ

- Контроллер диагноза всегда получает JSON-блок `plan_payload`.
- Поля верхнего уровня: `kind` (PLAN_NEW, PLAN_UPDATE, QNA, FAQ), `object_hint`, `diagnosis` { `crop`, `disease`, `confidence` }, `case_id` (опционально), `stages`.
- Каждый `stage` описывает `name`, `trigger` («до цветения», «после дождя >10 мм», «при симптомах»), `notes`, `options`.
- `options` (до 3): `{ product_code?, product_name, ai, dose: { value, unit }, method, phi_days, notes }`.
- Тип `kind` управляет поведением: PLAN_* → создаём/обновляем черновик, QNA/FAQ → просто ответ в чат без изменения плана.

#### 4.5.2 Валидация и нормализация

- Дозировки переводятся в стандартизированные единицы (л/га, г/л, мл/10л), `phi_days` приводится к числу, пустые значения → `null`.
- `product_code` маппится на `product_rules` по культуре/региону; если не найдено — `needs_review` и опция не предлагается до подтверждения.
- Каждая опция сверяется с официальными реестрами РФ (ДВ/препарат, нормы, PHI); несоответствие маркируется `needs_review`.
- Этапы сортируются по фиксированному порядку (весна → до цветения → после дождя → при симптомах), внутри этапа опции сортируются по приоритету каталога.
- Считаем SHA-1 канонического JSON. Совпадение → обновление игнорируется (анти-дребезг).

#### 4.5.3 Жизненный цикл и версии

- **draft** — черновик после PLAN_NEW/PLAN_UPDATE, хранится до показа пользователю.
- **proposed** — пользователь увидел таблицу этапов и карточку автоплана; доступны действия «Принять», «Оставить как есть», «Принять частично».
- **accepted** — пользователь подтвердил хотя бы один вариант или нажал «Принять план».
- **scheduled** — созданы события/напоминания (обработка, PHI, контроль погоды).
- **superseded** — появилась новая accepted/scheduled версия того же object_id + case_id.
- **rejected** — пользователь отклонил апдейт.
- Истина для UI: последний accepted/scheduled по object_id + case_id. PLAN_UPDATE не перезаписывает активный план без согласия.

#### 4.5.4 Дифф и конфликты

- Draft сравнивается с активным планом: diff по этапам (новые, удалённые, изменённые опции, PHI, дозы).
- Если изменения затрагивают уже запланированное событие, пользователь получает выбор: «Принять изменения» (перенести события), «Оставить как есть», «Принять частично» (только будущие этапы).
- Косметические правки (описания без смены доз/PHI/ДВ) применяются автоматически; критические (рост дозы, PHI, смена действующего вещества) всегда требуют подтверждения.

#### 4.5.5 Автоплан и слоты

- `POST /treatments/{id}/autoplan` создаёт `autoplan_run` и ставит задачу воркеру.
- Воркер проверяет прогноз 72 ч вперёд (шаг 30 мин). Правила — в `docs/ALGORITHMS/auto_planner.md`.
- Если подходящих окон нет, план помечается `awaiting_window`; попытка повторяется после обновления прогноза или команды оператора.
- В Pro курсах 1–3 при факте дождя/осадков после этапа бот переносит следующий шаг на ближайшее 🟢 окно; если курс не сработал, формируется альтернативный план (новые опции на этап).
- События/напоминания содержат `plan_stage_id` и `stage_option_id`, что позволяет пересоздавать их при частичных принятиях.
- Для идемпотентности хранится `slot_signature = treatment_id + slot_start`; дубликаты игнорируются.

#### 4.6 Conversational assistant (Live chat)

- **Доступ:** AI-ассистент доступен только для Pro-подписчиков (`pro_expires_at > NOW()`) или beta-пользователей (`is_beta = true` при `BETA_HOUSEPLANTS_ENABLED=true`). Free-пользователи видят paywall с предложением оформить Pro при вызове `/assistant`. Событие `assistant_paywall_shown` логируется для аналитики конверсии.
- Чат — интерфейс. Истина о диагнозах, планах, событиях и напоминаниях остаётся в `cases/plans/events/reminders`; чат‑сообщения могут логироваться как разговорный контекст, но не заменяют данные БД.
- Режим живого ассистента не ломает мастер по фото: использует активный `object_id` и последние `diagnosis/plan/event`, но создаёт/обновляет сущности через те же сервисы, что и сценарий «Фото → План → Время».
- При явной смене темы (например, «виноград» при активном комнатном объекте) бот предлагает выбрать растение или продолжить без привязки.
- Ассистент обязан спрашивать уточнения (объект, культура, препарат, время) и не создавать «сырые» планы без минимального набора полей.
- Для фактических справочных ответов доступен optional retrieval-слой (RAG): при `ASSISTANT_RAG_ENABLED=true` ассистент подтягивает релевантные чанки из `knowledge_chunks` (`pgvector`, cosine similarity) и передаёт их в контекст LLM.
- Сессия живого ассистента хранится restart-safe в Redis с TTL: после рестарта восстанавливаются `history`, `pendingMessage`, `pendingTopic`, `pendingProposalId` и активный `object_id`; если сессия истекла, бот не должен ошибочно трактовать короткий follow-up как продолжение старого диалога.

##### 4.6.1 Endpoint `/v1/assistant/chat`

- **Request:** `{ session_id?, message, user_id, object_id?, locale, channel=tg, metadata: { recent_diagnosis_id?, plan_session_id?, history?: [{ role: "user"|"assistant", text }] } }`.
- **Response:** `{ assistant_message, followups[], proposals[] }`, где `proposals[]` содержит `proposal_id`, `kind` (`plan`|`event`|`clarify`), `plan_payload` (тот же JSON, что в 4.5.1), `suggested_actions[]` (`pin`, `ask_clarification`, `show_plans`, `open_logbook`).
- Поддерживается streaming/long‑poll или простые POST‑ответы; бот всегда добавляет CTA «📌 Зафиксировать» для `kind=plan|event`.

##### 4.6.2 Tools / internal API, которыми пользуется ассистент

- `get_objects`, `get_active_object`, `get_cases_for_object`, `get_recent_diagnosis` (использует `/v1/diagnoses/recent`), `get_plan_sessions` (восстановление мастера).
- `create_case` (при необходимости фиксирует диагноз с object_hint), `create_plan` / `update_plan` (тот же сервис, что у мастера, статус draft→proposed), `create_event` / `update_event_status` (дневник/напоминания), `get_last_plan_for_object`, `get_events_for_object`.
- `get_weather_window` и `autoplan` — обращаются к текущему сервису погоды/очереди (`/treatments/{id}/autoplan`), без альтернативных правил.
- Все tool‑calls проходят валидацию существующих ограничений (каталог препаратов, PHI, погода, object ownership); при ошибках ассистент обязан вернуть дружелюбный текст из уже существующих пользовательских ошибок.

##### 4.6.3 Фиксация договорённостей («📌 Зафиксировать»)

- Кнопка или callback передаёт `proposal_id` в `POST /v1/assistant/confirm_plan` вместе с `user_id`, `object_id`, `preferred_time?`, `plan_session_id?`.
- Бекенд конвертирует `proposal.plan_payload` в `cases/plans/events/reminders`, повторно используя `PlanService`/`EventService` (draft → proposed → accepted → scheduled). При отсутствии времени можно:
  - вызвать автоплан (воркер + окно погоды) или
  - открыть ручной выбор времени (пресеты «Сегодня вечером», «Завтра утром», «Выбрать дату») через существующий мастер `plan_sessions`.
- Ответ: `{status: accepted|scheduled, plan_id, event_ids[], reminder_ids[] }` + текст подтверждения для бота. При конфликте с активным планом отправляется diff и запрос подтверждения, как в 4.5.4.

##### 4.6.4 Валидация и ошибки

- Минимум для фиксации: `object_id` (или выбранный пользователем объект), культура, препарат/ДВ, доза + единица, метод, ориентировочная дата/окно (или указание вызвать автоплан). Без этого ассистент задаёт уточняющие вопросы.
- Ошибки `OBJECT_NOT_FOUND`, `PRODUCT_FORBIDDEN`, `PHI_CONFLICT`, `WEATHER_UNAVAILABLE`, `SESSION_EXPIRED`, `BUTTON_EXPIRED` используют уже принятый формат user errors (см. план-флоу и `userErrors.js`); ассистент не создаёт пустые сущности при ошибке.
- Если предложения противоречат активным PHI или погодным окнам, ассистент обязан объяснить причину и предложить альтернативу или ручной ввод времени.

##### 4.6.5 Knowledge retrieval (RAG)

- Инфра-контракт: RAG поддерживается только на PostgreSQL 15+ с установленным `pgvector` (`vector` extension).
- Таблица `knowledge_chunks` хранит чанки внешних материалов: `source_url`, `category`, `priority`, `chunk_text`, `meta_json`, `embedding`.
- `embedding` строится моделью `text-embedding-3-small` (по умолчанию), размерность `1536`.
- Runtime retrieval включается через флаги:
  - `ASSISTANT_RAG_ENABLED` (`0/1`)
  - `ASSISTANT_RAG_TOP_K` (default `4`, максимум `8`)
  - `ASSISTANT_RAG_MIN_SIMILARITY` (default `0.2`)
  - `ASSISTANT_RAG_IVFFLAT_PROBES` (default `50`, для стабильности ANN-поиска)
  - `OPENAI_RAG_EMBEDDING_MODEL` (default `text-embedding-3-small`)
  - `ASSISTANT_RAG_FILTER_LANG` (опционально: CSV/JSON список языков)
  - `ASSISTANT_RAG_FILTER_CATEGORY` (опционально: CSV/JSON список категорий)
- Retrieval ограничивает дубликаты по источнику (`source_url`) — по умолчанию не более 2 чанков на источник.
- Загрузка данных выполняется скриптом `scripts/load_knowledge_chunks.py` из manifest/chunks JSONL:
  - `--database-url` имеет приоритет над `DATABASE_URL`;
  - `--only-new` (default `true`) эмбеддит только новые/изменённые чанки;
  - итоговый отчёт обязателен: `inserted/updated/skipped/failed`.
- Для нового стенда используется bootstrap-порядок: `alembic upgrade head` → `python scripts/rag_preflight.py` → `python scripts/load_knowledge_chunks.py --only-new` → `python scripts/rag_smoke_check.py`.

5 · Data Model (PostgreSQL)

users(
  id SERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  pro_expires_at TIMESTAMP,
  autopay_enabled BOOLEAN DEFAULT FALSE,
  is_trial_used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT now()
);

photos(
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  file_id TEXT,
  crop TEXT,
  disease TEXT,
  confidence NUMERIC(4,3),
  roi NUMERIC(10,2),
  ts TIMESTAMP DEFAULT now()
);

protocols(
  id SERIAL PRIMARY KEY,
  crop TEXT,
  disease TEXT,
  category TEXT,
  status TEXT,
  waiting_days INT,
  product TEXT,
  dosage_value NUMERIC(6,2),
  dosage_unit TEXT,
  phi INT,
  registry_date DATE
);

payments(
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  amount INT,
  currency TEXT,
  source TEXT,              -- "SBP:Tinkoff"
  external_id TEXT,
  provider_payment_id TEXT,
  autopay BOOLEAN DEFAULT FALSE,
  autopay_charge_id TEXT,
  autopay_binding_id TEXT,
  prolong_months INT,
  status TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

photo_usage(
  user_id BIGINT,
  month CHAR(7),            -- YYYY-MM
  used INT,
  updated_at TIMESTAMP,
  PRIMARY KEY (user_id, month)
);

Индексы: photos_user_ts_idx(user_id, ts DESC); счётчики сбрасывает CRON 5 0 1 * * (Europe/Moscow).

6 · Sequence Diagrams

6.1 Diagnose — Happy Path

User  → Bot:  фото (JPEG)
Bot   → TG:   getFile
Bot   → GPT:  diagnose
GPT   → Bot:  JSON
Bot   → DB:   INSERT photos (+ROI)
Bot   → User: диагноз + ROI + кнопка «Протокол»

Диагностический JSON возвращает:

- `crop`, `disease`, `disease_name_ru`, `confidence`.
- `reasoning[]` — 2–4 коротких фраз («жёлтые пятна», «налёт на верхних листьях»).
- `treatment_plan` — `product`, `substance`, `dosage_value`/`dosage_unit` (или fallback `dosage`), `method`, `phi_days|phi`, `safety_note`.
- `next_steps` — `reminder`, `green_window`, `cta`.
- `need_reshoot` и `reshoot_tips[]` (если `confidence < 0.6` или изображение низкого качества).
- `assistant_ru` и `assistant_followups_ru[]` — готовый живой ответ и карточки на follow-up вопросы.
  Для сценариев вода/грунт/корни (`жёсткая вода`, `засоление`, `перелив`, `пересушивание`) ответ должен содержать блок уточнения: запрос фото поверхности грунта + фото дренажа/поддона + проверка влажности на 2–3 см перед жёсткими рекомендациями.
  Бот должен корректно обрабатывать короткие ответы пользователя на этот блок (`мокро`, `сухо`, `влажно`, описание состава грунта) и давать следующий шаг по диагностике воды/субстрата, а не общий fallback «не понял вопрос».
  При риске перелива/подгнивания ответ дополнительно должен содержать алгоритм проверки корней с явным шагом «вынуть растение из горшка и осмотреть корни», а затем безопасные шаги восстановления.
  Для сценариев пятен на листьях ответ должен добавлять короткий triage-блок: классификация пятен (по краю/по листу/точечно/цепочкой), проверка ожога после опрыскивания на солнце, проверка прокусов через макро/лупу, затем развилка на «залив/хлороз» и безопасное постепенное восстановление после пересушки.
- `crop_confidence` + `crop_candidates[]` — отдельная уверенность и топ‑кандидаты именно по культуре.
- `need_clarify_crop` + `clarify_crop_variants[]` — варианты культуры, если модель не уверена. Дополнительно backend принудительно включает этот флаг, если `crop_confidence < CROP_CLARIFY_THRESHOLD` (по умолчанию `0.75`), даже если модель не выставила его сама.
- `plan_missing_reason` — пояснение, почему план отсутствует (должно быть пустым в штатном сценарии).

Бот рассылает единый RU‑ответ с блоками «📸 Диагноз» → «🧪 Почему так» → «🧴 Что делать» → «⏰ Что дальше» + подсказки вопросов и CTA‑кнопки. При low-confidence/recheck или при `need_clarify_crop=true` скрываются жёсткие CTA («Запланировать», «Спросить про препараты») до уточнения данных.

6.2 Purchase Pro (one‑time)

User → Bot:  нажал «Купить Pro»
Bot  → Tinkoff:  CreateInvoice (SBP‑QR)
Bot  → User:     QR‑код
Tinkoff → Bot:   POST /payments/sbp/webhook (SUCCESS)
Bot  → DB:       UPDATE users.pro_expires_at
Bot  → User:     «Pro активирован до …»

6.3 Autopay Renewal

Cron → Bot:  проверка expiring‑soon
Bot  → User: нотификация (3 дня)
T‑0 Bot   → Tinkoff: CreateAutopayCharge
Tinkoff → Bot: POST /payments/sbp/autopay/webhook (SUCCESS|FAIL)
Bot → User:  «Продлено / Ошибка платежа»
Autopay запускается только если user дал явный opt‑in (autopay_enabled=true); перед списанием обязательна нотификация.

6.4 Limit Reached

API возвращает 402 PAYWALL → бот показывает окно оплаты.

7 · Edge Cases

Code

Behavior

NO_LEAF

confidence < 0.2 → сообщение «Не удалось распознать лист…»

BLUR

variance < 50 → то же сообщение

GPT_TIMEOUT

GPT > 10 с → фото pending, уведомление пользователя

LIMIT_EXCEEDED

Free‑user > 1 кейс/неделю → 402 PAYWALL (кроме повторной проверки того же растения)

PAYMENT_FAIL

Webhook status=FAIL → grace 3 дня, повтор оплаты

8 · Non‑Functional Requirements

Metric

Target

diag_latency_p95

≤ 8 с

Availability

≥ 99.5 % / month

GPT OPEX

≤ 0.50 ₽ / фото

Billing_fairness

Нет автосписаний без явного согласия; уведомление ≥ 3 дня до продления, возможность отмены до списания

Expert SLA

90 % ответов ≤ 2 ч

9 · Observability

Prometheus метрики:

diag_latency_seconds

diag_requests_total

roi_calc_seconds

gpt_timeout_total

payment_fail_total

quota_reject_total

autopay_charge_seconds

Alerts:

gpt_timeout_total{5m} > 5 %

rate(error) > 2 %

queue_pending > 100

autopay_fail_total{1h} > 5

10 · Security

SBP Webhook: HMAC‑SHA256 (X-Sign + body.signature), секреты в Vault, rotation 90 дн.

GPT Key: Vault, rotation 30 дн.

Photos: S3 lifecycle delete 90 дн; при users.opt_in=true экспорт в ml-dataset (anonymised) на 2 года.

Соответствие ФЗ‑152/GDPR: /v1/users/{id}/export, /v1/dsr/delete_user — SLA 30 дн.

11 · Legal & Consents

Бот показывает единый экран согласий (Политика ПДн + Оферта) при первом входе и при попытке отправить фото без согласия. До обработки фото и запуска оплаты требуется принятие обоих документов. Автопродление подтверждается отдельным экраном (opt‑in) перед покупкой с автоплатежом. Согласия фиксируются в `consent_events` (audit trail) и `user_consents` (актуальный статус) с указанием версии документа и источника. API для чтения/обновления согласий: GET `/v1/users/{id}/consents`, POST `/v1/users/{id}/consents/accept`, POST `/v1/users/{id}/consents/revoke`.

12 · DB Migration Policy

Alembic (semver). Rollback SLA 15 мин.

13 · Scalability

One worker ≈ 30 msg/s; HPA при CPU > 75 %. GPT concurrency 10/worker; Redis queue, fallback PG.

14 · Logs & Monitoring

Grafana‑Loki JSON‑логи: user_id, diag_id, latency, roi, error_code, autopay. Retention 30 дн.

15 · UX – Error Messages

Code

Message

NO_LEAF

«Не удалось распознать лист. Снимите крупнее и при дневном свете.»

LIMIT_EXCEEDED

«Лимит 5 бесплатных фото исчерпан. Pro — 199 ₽/мес без ограничений.»

GPT_TIMEOUT

«Сеть нестабильна, фото сохранено — пришлём результат позже.»

PAYMENT_FAIL

«Платёж не прошёл. Попробуйте другую карту или отмените автоплатёж.»

16 · Open Questions (закрыто в v1.7)

Вопрос

Ответ

SBP‑провайдер

Тинькофф основной, fallback — ЮKassa (Сбер)

Продление Pro

Автоплатёж SBP (opt‑in), уведомление −3 дня

ML‑датасет

Да, при Opt‑In и двойной анонимизации

17 · Approval

Role

Name

Status

CTO

—

☐

ML Lead

—

☐

FinOps

—

☐

Legal

—

☐

Документ docs/srs.md (v1.12) заменяет все предыдущие версии ≤ 1.11.
