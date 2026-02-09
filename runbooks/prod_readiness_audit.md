# Prod Readiness Audit (Single Server)

Дата: 2026-02-09

## Critical

- [x] `.env` и прочие секреты исключены из Docker build context: см. `.dockerignore` (`.env*`, `.secrets/`).
- [x] Секреты Prometheus больше не хардкодятся в репо: `monitoring/prometheus/prometheus.yml` использует `bearer_token_file` + docker secret `metrics_token`.
- [x] Postgres из docker-compose не публикуется наружу: `db` проброшен как `127.0.0.1:5433:5432`.
- [x] Контейнеры больше не “живут” на bind-mount исходников: `docker-compose.yml` без volumes для `bot`/`api`. Это устраняет класс ошибок, когда `git pull/checkout` меняет код прямо в работающем контейнере.

## High

- [x] Ротация приложенческих ключей выполнена (должно быть отражено в `.env` и секретах): `JWT_SECRET`, `API_KEY`, `METRICS_TOKEN`/`BOT_METRICS_TOKEN`, `HMAC_SECRET`, `HMAC_SECRET_PARTNER`, `POSTGRES_PASSWORD`, `OPENAI_API_KEY`, `BOT_TOKEN_DEV/PROD`.
- [x] Python зависимости приведены к состоянию `pip-audit: no known vulnerabilities` (см. `requirements.txt`).
- [x] Node.js prod deps для воркеров очищены от известных уязвимостей: `npm audit --omit=dev` = 0 (см. `package.json`, `package-lock.json`).
- [x] Из репозитория удалены случайно закоммиченные артефакты `node_modules/*`.

## Medium

- [x] Firewall/сетевые политики хоста: `ufw` активен, входящие по умолчанию закрыты. Открыты только: 22/tcp, 80/tcp, 443/tcp, 4433/tcp+udp (Outline), 8443/tcp и 8444/tcp (xray/VPN).
- [x] Посторонний публичный Postgres для PowerBI/`pricing` не открыт “на всех”: порт `55433/tcp` запрещён для всех, кроме allowlist IP (и внутренней подсети). Важно: сам Postgres должен слушать те IP, на которые реально приходит трафик.
- [ ] Бэкапы: убедиться, что есть регулярные бэкапы `pg_data` + стратегия восстановления (и тест восстановления).
- [ ] Мониторинг: при необходимости поднять `--profile monitoring` и проверить алерты/дашборды.
- [ ] Публичные `/docs`: если API будет опубликован наружу, рекомендуется закрыть `/docs`/`/openapi.json` (auth или отключение в prod) и добавить отдельный `/healthz`.

## Low

- [ ] Привести процесс ветвления к единому стандарту (в репо нет `develop`, фактически релизы идут из `main`).
