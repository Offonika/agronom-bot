# Sandbox оплата через SBP

Для локальной разработки используется упрощённый провайдер.
В режиме `APP_ENV=development` функция `create_sbp_link()`
возвращает ссылку вида `https://sandbox/pay?tx=<external_id>`.

## Как запустить

1. Установите зависимости и примените миграции:
   ```bash
   pip install -r requirements.txt
   alembic upgrade head
   ```
2. Запустите API:
   ```bash
   uvicorn app.main:app --reload
   ```
3. Сгенерируйте ссылку на оплату (например, через `/v1/payments/create`).
4. Для симуляции успешного платежа выполните:
   ```bash
   node fastify/mock_bank.js <external_id>
   ```
   Скрипт отправит webhook на `/v1/payments/sbp/webhook` с нужными
   параметрами. Значения `API_BASE_URL`, `API_KEY` и `HMAC_SECRET`
   берутся из `.env`.

В продакшене при наличии переменных `SBP_API_URL` и `SBP_API_TOKEN`
функция обращается к реальному API провайдера для создания ссылки.
