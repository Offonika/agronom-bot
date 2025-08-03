Retry Logic – «Карманный агроном»

Версия 1.1 — 5 августа 2025 г.(v1.0 → v1.1: добавлен счётчик attempts, новые алерты Prometheus)

1 · Статусы photos.status

Status

Meaning

pending

Снимок сохранён, GPT‑Vision не ответил (таймаут)

retrying

Повтор запущен, предыдущая попытка ошиблась

failed

Исчерпаны попытки (retry_attempts ≥ RETRY_LIMIT)

ok

Диагноз успешно получен

2 · Очередь retry-diagnosis

Файл: worker/retry_diagnosis.js.

Библиотека: BullMQ + Redis.

Cron: 0 1 * * * (01:00 MSK, ежедневно).

2.1 Алгоритм

SELECT photos WHERE status='pending' OR status='retrying'.

Для каждой записи:

If retry_attempts ≥ RETRY_LIMIT → status='failed'.

Else: call GPT‑Vision →

success → status='ok', retry_attempts++.

error   → status='retrying', retry_attempts++.

Лог: handled=N, success=M, fail=K.

2.2 Переменные среды

Var

Default

Desc

RETRY_LIMIT

3

макс. попыток на фото

RETRY_CRON

0 1 * * *

расписание

REDIS_URL



redis://

3 · Observability

Prometheus metric retry_attempts_total{status}.

Alert ALRT-RETRY-FAIL – rate(retry_attempts_total{status="failed"}[15m]) > 10.

4 · Тест‑кейс (QA)

TC-110: поместить 2 файла в pending и выключить GPT mock → после 4 циклов status='failed'.

5 · Схема ER изменение

ALTER TABLE photos
  ADD COLUMN retry_attempts INT DEFAULT 0 NOT NULL;

Документ docs/retry_logic.md (v1.1) заменяет v1.0.

