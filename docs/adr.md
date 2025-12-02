# Architecture Decision Record (ADR)

**Проект:** «Карманный агроном» — фаза Telegram‑бот (MVP)

**Версия:** 1.7 — 21 ноября 2025 г.
*(v1.6 → v1.7: добавлен поток живого ассистента и правило «чат — оркестратор, данные — в cases/plans/events»)* 

---

## 1 · Контекст и цели

* **MVP = Telegram‑бот**.
* **Time‑to‑market ≤ 2 нед.**
* Обработка до **50 000 MAU** без редизайна.
* **OPEX минимальный:** 1 small VM + S3.
* Плавный апгрейд к фазам **B (Native)** и **C (On‑device CV)**.
* Живой ассистент — тонкий слой оркестрации поверх существующих сервисов (diagnose/plan/logbook/weather); чат остаётся интерфейсом, бизнес‑состояние хранится в `cases/plans/events/reminders`.

---

## 2 · Тех‑стек

| Слой            | Технологии                                                  |
| --------------- | ----------------------------------------------------------- |
| Языки / Runtime | **Node.js 20** (TypeScript strict)                          |
| ML              | **GPT‑Vision API (OpenAI)**                                 |
| Data Sources    | Government pesticide catalogs                               |
| Storage         | **PostgreSQL 15**, S3‑совместимое хранилище (VK S3 / Minio) |
| Cache / Queue   | Redis 7 (Phase B, опционально)                              |
| Secrets         | **Hashicorp Vault CSI**                                     |
| Payments        | **Tinkoff SBP v2 (Invoice + Autopay)**                      |
| Infra           | Kubernetes 1.30 + ArgoCD (blue/green)                       |
| Monitoring      | Prometheus + Grafana + Loki + Tempo                         |

---

## 3 · C4‑Diagram (text)

**C1 – System**
Farmer → TG‑Bot ↔ Telegram API → App Service (+ AssistantOrchestrator/LLM) → `GPT‑Vision / PostgreSQL / S3` → Prometheus

**C2 – Containers**
`Bot Gateway │ App Service │ Assistant (LLM/tool-calls) │ Worker │ PostgreSQL │ S3 │ Prom+Grafana+Loki`

**C3 – Components (App)**
`DiagnoseController`, `PaymentController`, `AutopayController`, `LimitsController`, `ROIService`, `AssistantOrchestrator (LLM + tool-calls к diagnose/plan/logbook/weather)`

**C4 – Worker**
`Bull Queue → RetryJobHandler (fetch photo → GPT → DB update)`; ассистентские tool-calls обращаются к тем же Plan/Event/Weather сервисам, без дублирования бизнес-логики.

---

## 4 · Data Flow (updated)

1. **/v1/ai/diagnose** → JPEG → S3, row `photos.status=pending`.
2. **GPT call** → `status=ok`, calculate ROI.
3. **Bot** → результат (diagnosis + ROI + «Протокол»).
4. **/v1/limits** → count rows `photos` текущего месяца.
5. **/v1/payments/sbp/webhook** → validate HMAC, update `payments`, prolong **Pro**.
6. **/v1/payments/sbp/autopay/webhook** → validate HMAC, update `payments`, prolong **Pro** (ежемесячно).
7. **/v1/payments/sbp/autopay/cancel** → disable `users.autopay_enabled`.
8. **/v1/partner/orders** → verify signature, insert order.

**Live Chat (Conversational Assistant)**
1. User → Telegram‑бот: «💬 Задать вопрос ассистенту».
2. Bot → App: `POST /v1/assistant/chat` (session_id, user_id, active object, последние cases/plans/events, weather hints).
3. App → LLM: prompt + tool‑calls; LLM → App: ответ + запрошенные tools.
4. App → Domain: `get_objects`, `get_recent_diagnosis`, `create_plan/update_plan`, `create_event/update_event_status`, `autoplan/weather` (те же сервисы, что мастер по фото).
5. App → Bot: текст + CTA «📌 Зафиксировать» (proposal_id).
6. User → Bot: нажимает «📌 Зафиксировать».
7. Bot → App: `POST /v1/assistant/confirm_plan` → PlanService/EventService (draft → proposed → accepted/scheduled), автоплан или ручной слот.
8. App → DB: writes `cases/plans/events/reminders`; Bot → User: подтверждение + «Показать дневник».
> Чат‑история может логироваться (audit/контекст), но бизнес‑состояние хранится только в структурах cases/plans/events/reminders; ассистент не дублирует логику план‑флоу.

---

## 5 · SLO

| Metric                   | Target         |
| ------------------------ | -------------- |
| **diag\_latency\_p95**   | < 8 с          |
| **GPT\_timeout\_ratio**  | < 1 %          |
| **Availability**         | ≥ 99.5 % / мес |
| **Quota leaks**          | 0              |
| **autopay\_fail\_ratio** | < 2 % / месяц  |

---

## 6 · Масштабирование

* **HPA:** `CPU > 65 %` *или* `diag_latency_p95 > 7 с` → +pod.
* **Telegram sharding:** 3 бот‑токена × 30 msg/s.
* **Retry‑worker:** обрабатывает `pending/retrying` + 429 back‑off.
* **PostgreSQL read‑replica** при QPS > 300.
* **Redis** включаем **Phase B**; пока PG row‑lock для квот.

---

## 7 · Resilience & DR

* **PITR 7 дней** (WAL) + snapshot 02:00 MSK.
* **SLA restore ≤ 60 мин**.
* Если Redis off → очередь `photos.status=pending` в PG.

---

## 8 · Security & Compliance

| Контроль                                  | Реализация                                                      |
| ----------------------------------------- | --------------------------------------------------------------- |
| TLS 1.2+ ext, mTLS int                    | Ingress Nginx + cert‑manager                                    |
| X‑API‑Key Bot→API                         | Header, rate‑limit Redis 30 req/min IP                          |
| **HMAC‑SHA256** для SBP Invoice & Autopay | `X‑Sign` + `body.signature`; secret Vault, rotate 90 дн         |
| **IP Allowlist**                          | Webhook‑IP Tinkoff production + sandbox                         |
| **X‑API‑Ver: v1** (обяз.)                 | Reject 426 if missing                                           |
| Business quota                            | `FREE_MONTHLY_LIMIT=5`; `/v1/limits` checks index               |
| **Autopay Cancel**                        | `/autopay/cancel` — проверка JWT + CSRF                         |
| Стандартиз. ошибки                        | `UNAUTHORIZED`, `LIMIT_EXCEEDED`, `GPT_TIMEOUT`, `PAYMENT_FAIL` |

---

## 9 · CI/CD & Secrets

* GitHub Actions: lint → test → docker build.
* ArgoCD blue/green deploy (health‑checks).
* Vault CSI: `GPT` (rotate monthly), `HMAC` (90 дн), DB creds.
* CI gate: `openapi-diff` + Spectral lint.

---

## 10 · Observability

* **Prometheus**: `diag_latency_seconds`, `diag_requests_total`, `roi_calc_seconds`, `quota_reject_total`, `gpt_timeout_total`, `autopay_charge_seconds`, `payment_fail_total`.
* **Grafana dashboards**: Diagnosis, Payments (Invoice + Autopay), Infra.
* **Alerts**: 401 spikes, GPT timeout > 5 %, `diagnosis_fail > 2 %`, `autopay_fail_total{1h} > 5`.

---

## 11 · Payment Sequences

### 11.1 Invoice (Happy Path)

```
User → Bot:  «Купить Pro»
Bot  → Tinkoff: CreateInvoice
User → Bank:   QR‑оплата
Bank → Bot:    /payments/sbp/webhook  (success)
Bot  → DB:      UPDATE users.pro_expires_at
Bot  → User:    «Pro активирован до …»
```

### 11.2 Autopay Renewal

```
Cron → Bot:   expiring‑soon list
Bot  → User:  нотификация (‑3 дня)
T‑0  Bot  → Tinkoff: CreateAutopayCharge
Bank → Bot: /payments/sbp/autopay/webhook (success|fail)
Bot  → DB:   UPDATE …
Bot  → User: «Продлено» / «Ошибка платежа»
```

### 11.3 Autopay Cancel

```
User → Bot: /cancel_autopay
Bot  → API:  POST /autopay/cancel
Bot  → Bank: DeleteBinding
Bot  → User: «Автоплатёж отключён»
```

---

## 12 · Trade‑offs / Rationale

* **Node.js + Prisma** → rapid prototyping, богатая экосистема.
* **Redis** откладываем до Phase B → меньше DevOps, меньше OPEX.
* **VK S3** дешевле AWS, latency РФ.
* **Tinkoff SBP** выбран из‑за sandbox, REST‑API, меньшей комиссии, покрытия Autopay.
* On‑device CV перенесён в Phase C (требует изменения хранилища модели).

---

## 13 · Future Evolution

| Phase | Major add‑ons                                                                 |
| ----- | ----------------------------------------------------------------------------- |
| **B** | Native app, offline‑queue, push‑alerts, Redis cache                           |
| **C** | CV‑модель on‑device (< 20 MB), NDVI‑map, Team API, GraphQL, ClickHouse for BI |

---

## 14 · Open Questions

1. **Redis Phase A** — остаётся опциональным; включить при QPS > 300 или latency issues.
2. **Multi‑region backup** — не срочно; пересмотреть при MAU > 100 k.
3. **ClickHouse** — оценить после Phase B (аналитика ROI, агрономия).

---

## 15 · Approval

| Role        | Name | Status |
| ----------- | ---- | ------ |
| CTO         | —    | ☐      |
| DevOps Lead | —    | ☐      |
| Security    | —    | ☐      |
| ML Lead     | —    | ☐      |

---

Документ `docs/ADR_bot_phase_v1.6.md` заменяет все предыдущие версии ≤ 1.5.
