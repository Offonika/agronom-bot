Retry Logic – «Карманный агроном»

Версия 1.2 — 12 февраля 2026 г. (v1.1 → v1.2: production retry-воркер без GPT stub, запуск в Docker Compose)

1 · Статусы photos.status

- `pending` — снимок сохранён, диагноз не получен в первичном запросе.
- `retrying` — выполнена хотя бы одна повторная попытка, ждём следующую.
- `failed` — исчерпаны попытки (`retry_attempts >= RETRY_LIMIT`) или устойчивые ошибки.
- `ok` — диагноз получен.

2 · Retry worker

- Entry point: `scripts/retry_diagnosis_runner.py`
- Service: `retry_diagnosis` в `docker-compose.yml`
- Модель: повторные попытки идут через тот же `call_gpt_vision`, что и основной `/v1/ai/diagnose` (без заглушки `gpt_stub`).
- Источник фото: S3 (`photos.file_id` → `app.services.storage.download_photo`).

2.1 Алгоритм цикла

1. Выбрать batch (`status IN ('pending','retrying')`, `deleted=false`) по свежим записям.
2. Для каждой записи:
   - если `retry_attempts >= RETRY_LIMIT` → `failed`;
   - если `file_id` не похож на S3 key (legacy Telegram `file_id`) → сразу `failed`;
   - иначе скачать фото из S3 и повторно вызвать GPT;
   - при валидном результате (`crop` + `disease`) → `ok`, заполнить `confidence/roi`;
   - при таймауте/ошибке/пустом результате → `retrying` или `failed` (по лимиту).
3. Лог цикла: `scanned/succeeded/retried/failed`.

2.2 Переменные среды

- `RETRY_LIMIT` (default `3`) — максимум попыток.
- `RETRY_BATCH_SIZE` (default `20`) — размер батча за цикл.
- `RETRY_RUN_INTERVAL_SECONDS` (default `60`) — интервал между циклами.

3 · Observability

- Проверка очереди: `scripts/queue_monitor.py`.
- Рекомендованный контроль: количество `photos.status IN ('pending','retrying')` и возраст самой старой pending записи.

4 · QA сценарий

- Создать запись `pending`, убедиться, что сервис `retry_diagnosis` в `docker compose ps` имеет статус `Up`.
- Дождаться 1–2 циклов и проверить, что статус изменился на `ok/retrying/failed`.
- При достижении лимита попыток запись должна перейти в `failed`.
