# Deploy (Single Server, Docker Compose)

Working directory: `/opt/agronom-bot`

## Autostart On Boot (systemd)

Unit: `/etc/systemd/system/agronom-bot-stack.service`

Commands:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agronom-bot-stack.service
sudo systemctl status agronom-bot-stack.service --no-pager
```

Note:
- The unit starts only core services (API/bot/workers/db/redis/minio). Optional monitoring stack is not started automatically.

## Optional: Monitoring Stack

Monitoring services are behind the `monitoring` profile.

Prereqs:
- Create `.secrets/metrics_token` (same value as `METRICS_TOKEN` / `BOT_METRICS_TOKEN`).
- Ensure `.env` contains `METRICS_TOKEN=...` (otherwise metrics will be unprotected and Prometheus auth is unnecessary).

Start:

```bash
cd /opt/agronom-bot
docker compose --profile monitoring up -d
docker compose ps
```

Stop:

```bash
cd /opt/agronom-bot
docker compose stop prometheus loki grafana
docker compose rm -f prometheus loki grafana
```

## Update Without Surprises (No Accidental db/minio Recreate)

Principle: update only stateless services explicitly and do not pull in dependencies.

Services to update normally:
- `api`
- `bot`
- `autoplan`
- `autopay`
- `usage_reset`

Steps:

```bash
cd /opt/agronom-bot

# 1) sanity check
docker compose config -q

# 2) build updated images
docker compose build api bot autoplan autopay usage_reset

# 3) apply DB migrations using the new api image (does not recreate db)
docker compose run --rm --no-deps api alembic upgrade head

# 4) restart only these services (do not touch db/minio/redis)
docker compose up -d --no-deps api bot autoplan autopay usage_reset

# 5) verify
docker compose ps
docker logs --tail 50 agronom-bot-api-1
docker logs --tail 50 agronom-bot-bot-1
```

If you must update `db` or `minio`, do it explicitly and schedule downtime.
