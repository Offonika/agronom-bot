Payment Flow – SBP Integration

Версия 1.3 — 22 ноября 2025 г.(v1.2 → v1.3: T‑Bank Token webhooks, ретраи автоплатежа)

0. UX & Consents

- Экран согласий (Политика ПДн + Оферта) обязателен до оплаты и обработки фото.
- /subscribe показывает варианты оплаты, автопродление подтверждается отдельным экраном перед оплатой с автоплатежом.
- Backend проверяет согласия (privacy + offer) перед созданием платежа; при autopay=true дополнительно требуется согласие autopay.

1. REST API

Method

Endpoint

Purpose

POST

/v1/payments/create

Сформировать счёт на оплату подписки Pro (1–12 мес).

POST

/v1/payments/sbp/webhook

Webhook от Тинькофф SBP по единоразовым платежам (invoice).

POST

/v1/payments/sbp/autopay/webhook

Webhook по регулярному списанию (Autopay Charge).

POST

/v1/payments/sbp/autopay/cancel

Отмена автоплатежа пользователем.

1.1 POST /v1/payments/create

{
  "user_id": 1,
  "plan": "pro",
  "months": 1,
  "autopay": true
}

Стоимость Pro — 199 ₽/мес. Сумма в копейках рассчитывается как `PRO_MONTH_PRICE_CENTS * months`.
В API можно передавать `Idempotency-Key`, чтобы повторы не создавали новый счёт.
Если autopay=true, backend создаёт Invoice через Tinkoff API v2 (Init → GetQr) и передаёт `CustomerKey=user_id` + `Recurrent=Y`. После успешного платежа сохраняется `RebillId` в `users.autopay_rebill_id`.
Если `SBP_MODE=tinkoff_test`, backend вызывает Tinkoff API (Init → GetQr), сохраняет `PaymentId` в `payments.provider_payment_id` и синхронизирует статус через GetState при опросе `/v1/payments/{id}`.
Для webhooks T‑Bank укажите `SBP_TINKOFF_NOTIFICATION_URL` на `/v1/payments/sbp/webhook` или `/v1/payments/sbp/autopay/webhook` (оба принимают Token).

200 OK

{
  "payment_id": "INV-7ab52",
  "url": "https://pay.tbank.ru/xxxx",
  "sbp_url": "https://qr.nspk.ru/xxxx", // опционально (только если SBP_QR_ENABLED=true)
  "autopay_binding_id": "BND-91c8" // опционально
}

1.2 POST /v1/payments/sbp/webhook

Webhook для единоразовых платежей.
Поддерживаются 2 формата:
1) Внутренний (HMAC, payload ниже).
2) Нативный T‑Bank (Token + TerminalKey). В этом случае body содержит поля T‑Bank (OrderId, PaymentId, Status, Amount, Token, RebillId и т.д.).

{
  "external_id": "INV-7ab52",
  "status": "success",      // success | fail | cancel | bank_error
  "paid_at": "2025-08-05T10:12:03Z",
  "signature": "<hmac>"
}

Backend проверяет HMAC‑SHA256 (X-Sign и signature в теле) или Token T‑Bank (если он есть в payload).

При success → payments.status=success, продлевается users.pro_expires_at.

Ответ 200 при успешной обработке. При неверном JSON — 400, при проблемах с подписью или запрещённом IP — 403 (логируется инцидент).

Retry‑логика провайдера: до 5 попыток, шаг ≈ 60 с. Backend обязан быть идемпотентным → проверка payments.external_id.

1.3 POST /v1/payments/sbp/autopay/webhook

Webhook о попытке регулярного списания.
Поддерживаются 2 формата:
1) Внутренний (HMAC, payload ниже).
2) Нативный T‑Bank (Token + TerminalKey).

{
  "autopay_charge_id": "CHG-3f12",
  "binding_id": "BND-91c8",
  "user_id": 1,
  "amount": 19900,
  "status": "success",      // success | fail | cancel | bank_error
  "charged_at": "2025-09-05T00:01:02Z",
  "signature": "<hmac>"
}

При success → продлевается Pro ещё на месяц, создаётся запись в payments (autopay=true).
Если binding_id уже закреплён за другим пользователем — webhook отклоняется (403). При первом success binding_id сохраняется в users.autopay_rebill_id.

При fail → бот отправляет уведомление, включается grace‑period 3 дня.

1.4 POST /v1/payments/sbp/autopay/cancel

Отмена привязки счёта пользователем.

{
  "user_id": 1
}

Требуются `Authorization: Bearer <jwt>` и `X-CSRF-Token`, плюс стандартные заголовки подписи запроса.

204 No Content — автоплатёж деактивирован. В режиме `tinkoff/tinkoff_test` дополнительно выполняется RemoveCustomer по `CustomerKey=user_id` (ошибки не блокируют ответ, логируются).

2. Схемы данных

2.1 payments

Column

Type

Note

id

SERIAL PK



user_id

BIGINT (tg_id)



amount

INT

копейки

currency

TEXT

RUB

status

payment_status

success / fail / cancel / bank_error

provider

TEXT

SBP:Tinkoff

external_id

TEXT

invoice id или charge id

autopay

BOOLEAN

TRUE для Autopay

autopay_cycle_key

TEXT

YYYYMMDD (дата продления)

autopay_attempt

INT

Номер попытки автосписания

autopay_next_retry_at

TIMESTAMP

Когда запускать следующую попытку

created_at

TIMESTAMP



updated_at

TIMESTAMP



prolong_months

INT

1–12

2.2 events

Column

Type

Example

id

SERIAL PK



user_id

BIGINT

1

event

TEXT

payment_success, autopay_fail

ts

TIMESTAMP

2025‑08‑05 10:12:03

3. Retry & Idempotency

Invoice Webhook повторяется до 5 раз каждые ~60 с, пока backend не вернёт 200.

Backend фиксирует external_id в payments. Повторное уведомление → UPDATE … SET paid_at = EXCLUDED.paid_at без побочных эффектов.

Для Autopay Charge idempotency‑key — autopay_charge_id.

4. Сценарии фронта

Успех платежа → фронт перенаправляет по QR → банк. После success бот уведомляет: «Pro активирован до …».

Неуспех платежа (fail / cancel / bank_error) → бот: «Платёж не прошёл, попробуйте снова». В лобби остаётся кнопка «Оплатить».

Автоплатёж

Регулярные списания выполняет `scripts/autopay_runner.py` (cron/ручной запуск) через Tinkoff Charge по `RebillId`.
OrderId для автосписания: `AUTO-<user_id>-<YYYYMMDD>-A<attempt>`.
При success/fail/cancel бот отправляет уведомление пользователю.
Для горизонтального масштабирования используется уникальный ключ `(user_id, autopay_cycle_key, autopay_attempt)` — дубликаты попыток не создаются.
Повторные попытки настраиваются через `AUTOPAY_RETRY_DELAYS_HOURS` (например `24,48` → 3 попытки всего).
Статусы, по которым разрешён ретрай: `AUTOPAY_RETRY_STATUSES` (по умолчанию `fail,bank_error`).
Зависшие попытки (включая случаи с PaymentId, когда статус долго остаётся NEW/AUTHORIZED) автоматически помечаются как ошибочные после `AUTOPAY_PENDING_TTL_MINUTES` (по умолчанию 15 минут).
Если все ретраи исчерпаны, автопродление выключается и пользователю отправляется `AUTOPAY_DISABLED_TEXT`.
Если у пользователя есть активный ручной платёж со статусом `pending`, автосписание пропускается на время `AUTOPAY_MANUAL_BLOCK_HOURS` (по умолчанию 24 часа).
Если сумма в уведомлении T‑Bank отличается от ожидаемой, платёж фиксируется как `bank_error`, автопродление выключается, пользователю отправляется `AUTOPAY_DISABLED_TEXT`.

За 3 дня до списания бот: «Через 3 дня будет списано 199 ₽. Отменить — /cancel_autopay».

После успешного списания — уведомление «Pro продлён до …».

При fail — бот: «Не удалось списать платёж, у вас ещё 3 дня, чтобы оплатить вручную».

5. Локальная отладка

# Создать Invoice (единоразовый)
node scripts/mock_bank.js invoice INV-7ab52 success

# Тест Autopay Charge
node scripts/mock_bank.js autopay CHG-3f12 success --user 42 --binding BND-91c8 --amount 19900

# Прогон автосписаний (dry-run)
python scripts/autopay_runner.py --dry-run

# Режим Tinkoff тестового API (Init + GetQr + GetState)
# SBP_MODE=tinkoff_test
# SBP_API_URL=https://securepay.tinkoff.ru/v2
# TINKOFF_TERMINAL_KEY=XXXXDEMO
# TINKOFF_SECRET_KEY=YYYY
# SBP_QR_ENABLED=false
# SBP_TINKOFF_DATA={}           # JSON для поля DATA в Init (опционально)
# SBP_TINKOFF_QR_DATA={}        # JSON для дополнительных полей GetQr (опционально)
# SBP_TINKOFF_TAXATION=osn      # налоговый режим для чека (osn)
# SBP_TINKOFF_RECEIPT_EMAIL=    # e-mail для чека (нужно для теста ФФД)
# SBP_TINKOFF_RECEIPT_PHONE=    # телефон для чека (альтернатива e-mail)
# SBP_TINKOFF_RECEIPT_ITEM_NAME=PRO subscription
# SBP_TINKOFF_RECEIPT={}        # JSON чека, если нужно переопределить полностью
# AUTOPAY_LEAD_DAYS=0           # за сколько дней до окончания запускать Charge
# AUTOPAY_RUN_INTERVAL_MINUTES=60
# AUTOPAY_SUCCESS_TEXT=Автоплатёж прошёл успешно. PRO продлён.
# AUTOPAY_FAIL_TEXT=Не удалось списать оплату за PRO. Оплатите вручную в /subscribe.

# Значения по умолчанию (можно задать в env):
# TEST_USER_ID, MOCK_AMOUNT, MOCK_BINDING_ID, HMAC_SECRET, API_BASE_URL

6. Безопасность

signature = HMAC_SHA256(body_without_signature, BANK_SECRET)

Секрет хранится в Vault, rotation 90 дн.

Webhook‑IP беллист — Tinkoff production + sandbox.
`TINKOFF_IPS` поддерживает CIDR. Если API стоит за Apache/Nginx или Docker‑прокси, добавьте IP/сеть прокси в `TRUSTED_PROXIES`, иначе `X-Forwarded-For` будет проигнорирован и webhook может быть заблокирован.

7. Изменения в коде (payments.py)

Функция verify_hmac(body, headers).

Корутина process_payment_webhook(payload) — единоразовые платежи.

Корутина process_autopay_webhook(payload) — регулярные платежи.

async def cancel_autopay(user_id) — RemoveCustomer в Tinkoff API + UPDATE users.autopay_enabled=false.
