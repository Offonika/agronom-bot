System Requirements Specification (SRS)
Telegram‑бот «Карманный агроном» (MVP)
Версия 1.4 — 20 июля 2025 г.
1. Scope
Документ охватывает Telegram‑бот «Карманный агроном» (далее — Система) на этапе MVP.
Система:
• Принимает фотографии листьев ≤ 5 МБ.
• Отправляет JPEG ≤ 2 МБ в GPT‑Vision; получает диагноз {crop,disease,confidence}.
• Выдаёт протокол обработки (product, dosage_value, dosage_unit, phi) при наличии записи в БД, иначе помечает как «Бета».
• Ограничивает бесплатный тариф 5 фото/месяц, продаёт Pro‑подписку (₽ 499) через Bot Payments 2.0 / СБП.
• Сохраняет историю снимков и предоставляет команду /history.
Out‑of‑scope: нативные приложения, оф‑лайн CV‑модели, карта полей, white‑label‑SDK.
2. Glossary
Term
Definition
GPT‑Vision
OpenAI сервис анализа изображений, возвращает JSON‑диагноз.
Protocol
Запись обработки: crop, disease, product, dosage_value, dosage_unit, phi.
Pro
Платный доступ на 365 дней, снимает лимит фото.
PHI
Pre‑Harvest Interval — срок ожидания до сбора урожая, дней.

3. Functional Requirements
ID
Description
Priority
FR‑T‑01
Upload Photo — приём изображения ≤ 5 МБ.
High
FR‑T‑02
Diagnose — POST /v1/ai/diagnose, возвращает диагноз.
High
FR‑T‑03
Show Protocol — кнопка после диагноза.
High
FR‑T‑04
Purchase Pro — платёж через Bot Payments (СБП).
High
FR‑T‑05
Limit Enforcement — контроль 5 фото/мес для free.
High
FR‑T‑06
History — /history (GET /v1/photos) с пагинацией cursor‑based.
High
FR‑T‑07
Expert Request — /ask_expert отправляет запрос модератору.
High
FR‑T‑08
Partner Order Webhook — /v1/partner/orders принимает заказ.
High

4. API Contracts
4.1 Endpoints
/v1/ai/diagnose [POST]
/v1/photos [GET]
/v1/payments/sbp/webhook [POST]
/v1/partner/orders [POST]
4.2 Schemas (excerpt)
• dosage_value: number
• dosage_unit: enum { ml_10l, g_per_l }
• ErrorResponse.code: enum { NO_LEAF, LIMIT_EXCEEDED, GPT_TIMEOUT, BAD_REQUEST }
• PhotoItem включает ts, id, crop, disease, confidence
4.3 Errors
HTTP
Code
Description
400
BAD_REQUEST
Невалидное изображение / тело запроса
429
LIMIT_EXCEEDED
Исчерпана бесплатная квота
502
GPT_TIMEOUT
LLM не ответила  > 10 сек

5. Data Model (PostgreSQL)
users(id PK, tg_id BIGINT, pro_expires_at TIMESTAMP, created_at TIMESTAMP)
photos(id PK, user_id FK, file_id TEXT, crop TEXT, disease TEXT, confidence NUMERIC, ts TIMESTAMP)
protocols(id PK, crop TEXT, disease TEXT, product TEXT, dosage_value NUMERIC, dosage_unit TEXT, phi INT)
payments(id PK, user_id FK, amount INT, source TEXT, status TEXT, created_at TIMESTAMP)
idx: photos_user_ts(user_id, ts DESC)
6. Sequence Diagrams (Text)
6.1 Happy Path
User → Bot: send photo
Bot → TG: getFile
Bot → GPT: diagnose
GPT → Bot: JSON
Bot → DB: insert photo
Bot → User: message diagnosis + кнопка «Протокол»
6.2 Purchase Pro
User → Bot: click Pay
Bot → TG Payments: invoice
User → SBP: pay
SBP → Bot: webhook
Bot → DB: insert payment, update user.pro
Bot → User: confirmation
7. Edge Cases
Code
Behavior
NO_LEAF
confidence < 0.2 — сообщение «Не удалось распознать лист…»
BLUR
variance < 50 — то же сообщение.
GPT_TIMEOUT
GPT > 10 с → фото в pending, сообщение user.
LIMIT_EXCEEDED
Free‑пользователь превысил 5 фото в месяц.

8. Non‑Functional Requirements
Latency: P95 diag_latency_seconds < 8 с (upload → reply).
Uptime: ≥ 99.5 % / месяц.
Bot API: ≤ 30 msg/s; HPA масштабирует pods при 75 % load.
Security: TLS 1.2+, AES‑256 at rest, GPT‑key rotate monthly.
9. Service‑Level Objectives (SLO)
Metric
Target
Comment
diag_latency_p95
< 8 с


availability
≥ 99.5 %
per month
pending_retry_success
≥ 95 %
≤ 30 мин
expert_response_12h
≥ 90 %



10. Observability
Prometheus metrics: diag_latency_seconds, diag_requests_total, gpt_timeout_total, payment_fail_total, queue_size_pending.
Grafana dashboards: Diag‑health, Payments, System Load.
Alerts: GPT timeouts > 5 % /5 мин → Slack #alerts.
11. Security Details
Webhook SBP: HMAC‑SHA256 header X‑Sign, secret in Vault, rotate 90 дней.
GPT Key: Vault KV, rotate monthly.
Data retention: photos auto‑delete after 90 дн (S3 lifecycle).
GDPR DSR endpoints: /v1/users/{id}/export, /delete — SLA 30 дн.
12. DB Migration Policy
Tool: Alembic (semver tags). Script 2025_07_20_01_init.sql. Down‑migrations CI‑tested; rollback SLA 15 мин.
13. Scalability Plan
One bot‑worker = 30 msg/s. HPA spawns new pod at 75 % load. GPT concurrency 10/worker; excess queued in Redis (Phase A) or written to PG if Redis unavailable.
14. Monitoring & Logging Implementation
CloudWatch/Grafana‑Loki: structured JSON logs — user_id, diag_id, latency, error_code. Retention 30 дн.
15. UX Copy – Error Messages
Code
Message
NO_LEAF
«Не удалось распознать лист. Снимите крупнее и при дневном свете.»
LIMIT_EXCEEDED
«Лимит 5 бесплатных фото исчерпан. Оформите Pro, чтобы снимать без ограничений.»
GPT_TIMEOUT
«Сеть нестабильна, фото сохранено — мы пришлём результат позже.»

16. Open Questions
• SBP‑провайдер — Тинькофф или Сбер?
• Продление Pro — авто‑renew или ручная оплата?
• Храним ли анонимные фото > 90 дн для ML‑обучения?
17. Approval
Role
Name
Status
CTO
—
□
ML Lead
—
□
FinOps
—
□
Legal
—
□


