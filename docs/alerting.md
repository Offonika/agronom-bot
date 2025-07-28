# Alerting Guide – Slack & Telegram

Версия 1.0 — 27 июля 2025 г.

Документ описывает базовую настройку Alertmanager для проекта «Карманный агроном». Алерт отправляется в Slack и Telegram через вебхуки.

## 1. Правила алертов

- **error_rate** > 2 % за последние 5 минут
- **p95** `/diagnose` > 3 секунд
- **queue_size_pending** > 100

## 2. Конфигурация Alertmanager

```yaml
route:
  receiver: tg_slack
receivers:
  - name: tg_slack
    slack_configs:
      - api_url: ${SLACK_WEBHOOK_URL}
        channel: '#alerts'
    webhook_configs:
      - url: ${TG_WEBHOOK_URL}
```

Переменные `SLACK_WEBHOOK_URL` и `TG_WEBHOOK_URL` передаются через окружение.

## 3. Тестовое оповещение

1. Запустите Alertmanager с указанной конфигурацией.
2. С помощью `amtool` отправьте тестовый алерт:
   ```bash
   amtool alert add test_error rate=3
   ```
3. Убедитесь, что сообщение появилось в каналах Slack и Telegram.
