# Partner Integration Brief – AgroStore × «Карманный агроном»

Версия 1.1 — 20 июля 2025 г.  
(v1.0 → v1.1: уточнён Order Webhook, ссылки на OpenAPI, QA‑tests)

---

## §4 Order Webhook

Бот принимает уведомление о заказе препарата через HTTPS‑вебхук:

**POST `/v1/partner/orders`**  
(схема описана в OpenAPI v1.2 → `openapi.yaml`, раздел `paths`)

| HTTP | Код | Описание                    | Примечание                                 |
|------|-----|-----------------------------|---------------------------------------------|
| POST | 202 | Queued                      | Заказ принят, асинхронная обработка         |
| POST | 400 | Bad request                 | JSON‑schema error / missing fields          |
| POST | 401 | Unauthorized                | Неверная подпись HMAC‑SHA256                |

**Аутентификация:**  
Header `X‑Sign` (HMAC‑SHA256) вычисляется по сырому телу запроса.
Секрет выдаётся партнёру отдельно и ротируется каждые 90 дней.
Тело нужно сериализовать через `json.dumps(payload, separators=(",", ":"), sort_keys=True)`
перед расчётом подписи, чтобы обеспечить стабильный результат.

### 4.1 Payload schema (excerpt)


{
  "order_id": "string",
  "user_tg_id": 123456789,
  "protocol_id": 42,
  "price_kopeks": 15900,
  "signature": "hex"
}
4.2 Error examples
400 Bad request:


{ "code": "BAD_REQUEST", "message": "price_kopeks must be >0" }
401 Unauthorized:



{ "code": "UNAUTHORIZED", "message": "Invalid signature" }
§5 QA & Monitoring
Тест‑кейс TC‑028 добавлен в QA Test Plan v1.1 (позитивное)

TC‑029 — негативный (неверная подпись)

Метрика в Prometheus:


partner_orders_total{status="fail"}
Алерт: P2 > 5 ошибок / 5 мин

§6 Deep‑link Schema (v1)
text

https://agrostore.ru/agronom?
  pid={product_id}&
  src=bot&
  uid={sha256(tg_id)}&
  dis=5&
  utm_campaign=agrobot
Пример:

https://agrostore.ru/agronom?pid=12345&src=bot&uid=07ab...ef&dis=5&utm_campaign=agrobot
После перехода купон AGRO5 применяется автоматически.

§7 SLA
Партнёр предоставляет health‑endpoint:

GET /status → 200 OK
{
  "status": "up"
}
§8 Отчётность
Daily CSV: agro_orders_YYYYMMDD.csv
Загружается в S3: agro-report/

Колонки:

provider_id

tg_hash

amount_rub

discount_rub

status

created_at

Сверка комиссий — 3‑го числа месяца

§9 Таймлайн интеграции
(опционально уточняется в проекте)

§10 KPIs
≥ 50 переходов/день после релиза

Конверсия click → paid ≥ 10 %

Комиссия ≥ ₽30 000 за 30 дней

§11 Контакты
Партнёр: АгроStore.ru
Тип: e‑commerce СЗР, семена, удобрения

Контактное лицо:
Иван Громов, Partner Manager
📧 i.gromov@agrostore.ru
📱 @gromov_agro
📞 +7 926 123‑45‑67

§12 Sign‑off
Документ хранится в: /docs/partner_agrostore.md
Новые партнёры — копируем и адаптируем.



