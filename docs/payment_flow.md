Payment Flow – SBP Integration

Версия 1.1 — 5 августа 2025 г.(v1.0 → v1.1: добавлена интеграция с Tinkoff Autopay, эндпойнт /autopay/cancel, описана retry‑логика)

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

Стоимость Pro — 34 900 ₽/мес. Сумма в копейках рассчитывается как `34900 * months`.
Если autopay=true, backend создаёт Invoice + Autopay Binding (см. Tinkoff API v2 init + bind_card).

200 OK

{
  "payment_id": "INV-7ab52",
  "url": "https://sbp.tinkoff.ru/pay?q=...",
  "autopay_binding_id": "BND-91c8" // опционально
}

1.2 POST /v1/payments/sbp/webhook

Webhook для единоразовых платежей.

{
  "external_id": "INV-7ab52",
  "status": "success",      // success | fail | cancel | bank_error
  "paid_at": "2025-08-05T10:12:03Z",
  "signature": "<hmac>"
}

Backend проверяет HMAC‑SHA256 (X-Sign и signature в теле).

При success → payments.status=success, продлевается users.pro_expires_at.

Ответ всегда 200. При ошибке валидации — 403, логируется инцидент.

Retry‑логика провайдера: до 5 попыток, шаг ≈ 60 с. Backend обязан быть идемпотентным → проверка payments.external_id.

1.3 POST /v1/payments/sbp/autopay/webhook

Webhook о попытке регулярного списания.

{
  "autopay_charge_id": "CHG-3f12",
  "binding_id": "BND-91c8",
  "user_id": 1,
  "amount": 34900,
  "status": "success",      // success | fail | cancel | bank_error
  "charged_at": "2025-09-05T00:01:02Z",
  "signature": "<hmac>"
}

При success → продлевается Pro ещё на месяц, создаётся запись в payments (autopay=true).

При fail → бот отправляет уведомление, включается grace‑period 3 дня.

1.4 POST /v1/payments/sbp/autopay/cancel

Отмена привязки счёта пользователем.

{
  "user_id": 1
}

204 No Content — автоплатёж деактивирован.

2. Схемы данных

2.1 payments

Column

Type

Note

id

SERIAL PK



user_id

INT FK



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

INT

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

За 3 дня до списания бот: «Через 3 дня будет списано 349 ₽. Отменить — /cancel_autopay».

После успешного списания — уведомление «Pro продлён до …».

При fail — бот: «Не удалось списать платёж, у вас ещё 3 дня, чтобы оплатить вручную».

5. Локальная отладка

# Создать Invoice (единоразовый)
node scripts/mock_bank.js INV-7ab52 success

# Тест Autopay Charge
node scripts/mock_bank.js CHG-3f12 success --autopay

6. Безопасность

signature = HMAC_SHA256(body_without_signature, BANK_SECRET)

Секрет хранится в Vault, rotation 90 дн.

Webhook‑IP беллист — Tinkoff production + sandbox.

7. Изменения в коде (payments.py)

Функция verify_hmac(body, headers).

Корутина process_payment_webhook(payload) — единоразовые платежи.

Корутина process_autopay_webhook(payload) — регулярные платежи.

async def cancel_autopay(user_id) — дерегистрация через API банка + UPDATE users.autopay_enabled=false.