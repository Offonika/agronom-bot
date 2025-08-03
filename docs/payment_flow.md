# Payment Flow – SBP Integration

Версия 1.0 — 27 июля 2025 г.

Документ описывает процесс создания платежа и получение webhook от провайдера СБП.

## 1. API

### POST `/v1/payments/create`
Создаёт счёт на оплату подписки. Тело запроса:
```json
{
  "user_id": 1,
  "plan": "pro",
  "months": 1
}
```
Ответ `200`:
```json
{
  "payment_id": "<external_id>",
  "url": "https://sbp.example/pay"
}
```
В случае ошибки авторизации возвращает `401` с `ErrorResponse`.

### POST `/v1/payments/sbp/webhook`
Webhook от банка. Подпись HMAC передаётся в заголовке `X-Signature` и дублируется в теле.
Пример полезной нагрузки:
```json
{
  "external_id": "<payment_id>",
  "status": "success",
  "paid_at": "2025-07-27T10:00:00Z",
  "signature": "<hmac>"
}
```
Ответ всегда `200`. При валидационных ошибках или неправильной подписи возможны `400`/`403`/`404`.

Сервер вычисляет HMAC-SHA256 от остального тела и сверяет его со значением `signature`.
При несовпадении возвращается `403 Forbidden` и запись об инциденте попадает в лог.

## 2. Таблицы БД

### `payments`
`id PK`, `user_id FK`, `amount INT`, `currency TEXT`, `status payment_status`, `created_at TIMESTAMP`, `updated_at TIMESTAMP`, `provider TEXT`, `external_id TEXT`, `prolong_months INT`

### `events`
`id PK`, `user_id INT`, `event TEXT`, `ts TIMESTAMP`

## 3. Сценарии ответа для фронта

1. **Успех создания платежа** — фронт получает ссылку `url` и перенаправляет пользователя на страницу банка.
2. **Уведомление об успехе** — после webhook статус платежа меняется на `success`, таблица `users.pro_expires_at` обновляется. Бот отправляет уведомление.
3. **Ошибка оплаты** — при статусе `fail`, `cancel` или `bank_error` бот сообщает о неудаче и предлагает повторить попытку.

---

Для локальной разработки можно запустить скрипт `fastify/mock_bank.js <external_id>`,
который отправит тестовый webhook на указанный API.
