# QA Test Plan – «Карманный агроном» (Telegram‑бот)

**Версия 1.8 — 5 августа 2025 г.**
*(v1.7 → v1.8: SRS v1.7, Autopay SBP flow, новые security‑checks)*

---

## 1. Цели тестирования

* Проверить соответствие **SRS v1.7**.
* Проверить соблюдение **SLO** (см. §3) для фаз β и GA.
* Проверить поведение при превышении лимита **5 фото/мес**.
* Проверить валидацию **HMAC‑подписей** (invoice & autopay).
* Проверить обязательность заголовков **X-API-Ver: v1** и **X-User-ID**.
* Валидировать новые эндпойнты Autopay (`/sbp/autopay/webhook`, `/sbp/autopay/cancel`).

---

## 2. Область тестирования

* **Диагностика:** `/v1/ai/diagnose` (multipart + base64).
* **История снимков:** `/v1/photos`.
* **Платежи:**

  * `/v1/payments/sbp/webhook` – invoice (одноразовый).
  * `/v1/payments/sbp/autopay/webhook` – регулярные списания.
  * `/v1/payments/sbp/autopay/cancel` – отмена привязки.
* **Партнёрский заказ:** `/v1/partner/orders` (HMAC).
* **Ограничение Free‑плана:** `/v1/limits`.
* **Автопродление Pro:** cron‑нотификации и grace‑period.
* **Хранение снимков:** TTL = 90 дней + экспорт в `ml-dataset` (opt-in).
* **Интернационализация:** RU/EN fallback.

---

## 3. Критерии приёмки

* **β-релиз:** P0‑багов — 0; P1 — ≤ 3; все P0‑P1 кейсы — **PASS**.
* **SLO:** latency *P95* < 8 с; error‑rate ≤ 1 %.
* **Coverage:** 100 % business‑rule edge cases (см. §6).

---

## 4. Тест‑среды

| Layer   | Env                                           |
| ------- | --------------------------------------------- |
| Backend | Staging API (`api-stg.agronom.internal`)      |
| Bot     | TG Sandbox Bot (`@agronom_bot_stg`)           |
| CI      | GitHub Actions + Postman/newman + pytest + k6 |

---

## 5. Контрольный набор изображений

`s3://agro-testset-v1/` – 1 000 JPG, CSV-метки, MD5 & SHA‑256 manifest (ver. 2025‑07‑20).

---

## 6. Тест‑кейсы

### 6.1 Приоритеты

* **P0** – безопасность, платёж, блокирующая ошибка.
* **P1** – бизнес‑правила, лимиты, крит. UX.
* **P2** – тексты, логи, i18n.

### 6.2 Matrix

| ID         | Priority | Summary                                                                       |
| ---------- | -------- | ----------------------------------------------------------------------------- |
| **TC‑010** | P0       | Отсутствие `X-Signature` → `403`, лог инцидента                               |
| **TC‑020** | P0       | Подпись неверна (`signature≠hmac`) → `403`, retry‑policy provider сохраняется |
| **TC‑030** | P1       | Фото до mock‑ответа: diagnose → mock JSON, файл в S3/Minio                    |
| **TC‑040** | P1       | Диагноз + ROI + «Протокол»/«Бета» карточка                                    |
| **TC‑041** | P1       | Кнопка «Протокол» открывает deep‑link AgroStore                               |
| **TC‑050** | P0       | 402 Paywall при > 5 фото/мес                                                  |
| **TC‑060** | P1       | Воркер `usage_reset` сбрасывает счётчики (01 число, 00:05 MSK)                |
| **TC‑070** | P0       | Путь Invoice paywall → success webhook → Pro активирован                      |
| **TC‑075** | P0       | Autopay Charge `success` → продление Pro, grace‑period сброшен                |
| **TC‑076** | P0       | Autopay Charge `fail` → уведомление, grace‑period 3 дня                       |
| **TC‑077** | P1       | `/autopay/cancel` → статус `204`, `users.autopay_enabled=false`               |
| **TC‑078** | P1       | Cron‑нотификация «Через 3 дня будет списание…»                                |
| **TC‑080** | P1       | `/history` выводит 10 последних снимков (cursor)                              |
| **TC‑090** | P2       | `/help` – RU/EN, корректный список команд                                     |
| **TC‑100** | P2       | Навигация меню: старт → история → диагностика                                 |

---

## 7. Нагрузочное тестирование

`k6 load_diag.js` – 5 000 RPS, 5 мин. **PASS**: error‑rate < 1 %, latency *P95* < 8 с.

---

## 8. API Integration Tests (CI)

* Postman Collection **v1.8**

  * Проверка кодов 200/400/401/402/502.
  * Ajv‑валидация схем OpenAPI.
  * Invoice → webhook → статус.
  * Autopay → webhook success/fail.
  * Paywall flow (`/limits` → 5/5 → diagnose = 402 → paywall).
* Pytest – unit & contract tests (mock Tinkoff API).

---

## 9. Security Checks

| Check              | Target                                       |
| ------------------ | -------------------------------------------- |
| **SSL Labs**       | Grade A                                      |
| **SQL‑inj**        | N/A                                          |
| **HMAC Invoice**   | header + body, SHA‑256                       |
| **HMAC Autopay**   | header + body, SHA‑256                       |
| **Rate‑limit**     | 30 req/min IP, 120 req/min user (Free) → 429 |
| **Business‑limit** | > 5 фото → 402                               |
| **IP Allowlist**   | Webhook‑IP Tinkoff only                      |
| **Idempotency**    | Повторный webhook не меняет state            |

---

## 10. Schedule & Roles

| Role        | Name        | Tool          |
| ----------- | ----------- | ------------- |
| QA Engineer | А. Иванов   | Postman, k6   |
| DevOps      | С. Петров   | Helm, CI │    |
| Security    | Л. Смирнова | ZAP, SSL Labs |
| Product     | М. Кузнецов | Notion / JIRA |

---

## 11. Risk & Mitigation

См. **Risk Register v1.2** (актуализирован 01 авг 2025).

---

## 12. Sign‑off

| Role             | Name | Status |
| ---------------- | ---- | ------ |
| QA Lead          | —    | ☐      |
| Security Officer | —    | ☐      |
| Product Owner    | —    | ☐      |

---

> Файл `docs/test_plan.md` (v1.8) заменяет все предыдущие версии ≤ 1.7.
