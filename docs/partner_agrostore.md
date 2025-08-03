Partner Integration Brief
AgroStore × «Карманный агроном»
Версия 1.1 — 20 июля 2025 г.
(v1.0 → v1.1: уточнён Order Webhook, добавлены ссылки на OpenAPI и QA-тесты)

§4. Order Webhook
4.0 Описание
Метод: POST /v1/partner/orders

Схема: см. OpenAPI v1.4 (openapi.yaml, раздел paths).

Код	HTTP	Описание	Примечание
202	POST	Queued — заказ принят	Обрабатывается асинхронно
400	POST	Bad Request	Ошибка JSON-схемы / отсутствуют поля
401	POST	Unauthorized	Неверная подпись HMAC-SHA256

4.1 Аутентификация
Заголовок X-Sign содержит HMAC-SHA256 подпись от «сырого» тела запроса.

Секрет передаётся партнёру отдельно; ротация — раз в 90 дней.

Для стабильного хэша тело сериализуется так:

python
Копировать
Редактировать
json.dumps(payload, separators=(",", ":"), sort_keys=True)
4.2 Схема payload (фрагмент)
json
Копировать
Редактировать
{
  "order_id": "string",
  "user_tg_id": 123456789,
  "protocol_id": 42,
  "price_kopeks": 15900,
  "signature": "hex"
}
4.3 Примеры ошибок
json
Копировать
Редактировать
// 400 Bad Request
{ "code": "BAD_REQUEST", "message": "price_kopeks must be >0" }

// 401 Unauthorized
{ "code": "UNAUTHORIZED", "message": "Invalid signature" }
§5. QA & Monitoring
Элемент	Детали
Тест-кейсы	TC-028 (позитивный), TC-029 (неверная подпись)
Метрика Prometheus	partner_orders_total{status="fail"}
Алерт	P2 — > 5 ошибок за 5 минут

§6. Deep-link Schema (v1)
arduino
Копировать
Редактировать
https://agrostore.ru/agronom?
  pid={product_id}&
  src=bot&
  uid={sha256(tg_id)}&
  dis=5&
  utm_campaign=agrobot
Пример:

arduino
Копировать
Редактировать
https://agrostore.ru/agronom?pid=12345&src=bot&uid=07ab...ef&dis=5&utm_campaign=agrobot
Купон AGRO5 применяется автоматически после перехода.

§7. SLA
Health-endpoint партнёра

http
Копировать
Редактировать
GET /status → 200 OK
{
  "status": "up"
}
§8. Отчётность
Файл: agro_orders_YYYYMMDD.csv

Хранилище: agro-report/ (S3)

Колонка	Описание
provider_id	ID заказа у партнёра
tg_hash	SHA-256 от tg_id
amount_rub	Сумма, ₽
discount_rub	Скидка, ₽
status	Статус заказа
created_at	Дата/время

Сверка комиссий — до 3-го числа каждого месяца.

§9. Таймлайн интеграции
Уточняется индивидуально в рамках проекта.

§10. KPI
Показатель	Цель
Переходы по deep-link	≥ 50 / день после релиза
Конверсия click → paid	≥ 10 %
Комиссия	≥ ₽30 000 за 30 дней

§11. Контакты
Партнёр	AgroStore.ru — e-commerce (СЗР, семена, удобрения)
Контакт	Иван Громов, Partner Manager
Email	i.gromov@agrostore.ru
Telegram	@gromov_agro
Телефон	+7 926 123-45-67

§12. Sign-off
Документ хранится: /docs/partner_agrostore.md
Для новых партнёров — копировать и адаптировать шаблон.




