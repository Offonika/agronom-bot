# Alerting Guide – Slack & Telegram

**Версия 1.1 — 5 августа 2025 г.**
*(v1.0 → v1.1: новые метрики Autopay, GPT timeout, обновлены SLO)*

---

## 1. Правила алертов (Prometheus ➜ Alertmanager)

| ID                     | Expr                                                                                 | For | Severity | Description               |
| ---------------------- | ------------------------------------------------------------------------------------ | --- | -------- | ------------------------- |
| **ALRT-ERROR-RATE**    | `rate(diag_requests_total{status!="ok"}[5m]) / rate(diag_requests_total[5m]) > 0.02` | 5m  | critical | Ошибка > 2 % за 5 мин     |
| **ALRT-LATENCY-P95**   | `histogram_quantile(0.95, sum(rate(diag_latency_seconds_bucket[5m])) by (le)) > 8`   | 5m  | warning  | p95 `/diagnose` > 8 с     |
| **ALRT-GPT-TIMEOUT**   | `rate(gpt_timeout_total[5m]) > 5`                                                    | 5m  | critical | GPT timeout > 5 за 5 мин  |
| **ALRT-QUEUE-PENDING** | `queue_size_pending > 100`                                                           | 0m  | warning  | Очередь pending > 100     |
| **ALRT-AUTOPAY-FAIL**  | `increase(autopay_fail_total[1h]) > 5`                                               | 1h  | warning  | > 5 ошибок Autopay за час |

---

## 2. Конфигурация Alertmanager

```yaml
route:
  group_by: [ alertname ]
  receiver: tg_slack
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 1h
receivers:
  - name: tg_slack
    slack_configs:
      - api_url: ${SLACK_WEBHOOK_URL}
        channel: "#alerts"
        title: "{{ .CommonLabels.alertname }} — {{ .CommonLabels.severity }}"
        text: |-
          {{ range .Alerts }}• *{{ .Labels.instance }}* — {{ .Annotations.description }}\n{{ end }}
        send_resolved: true
    webhook_configs:
      - url: ${TG_WEBHOOK_URL}
        send_resolved: true
```

> Переменные `SLACK_WEBHOOK_URL` и `TG_WEBHOOK_URL` передаются через окружение (Kubernetes `Secret` + `envFrom`).

---

## 3. Тестовое оповещение

```bash
# Запуск тестового алерта
amtool alert add test_alert error="3"
```

Убедитесь, что сообщения появились в Slack `#alerts` и в Telegram‑канале.

---

## 4. SLO Thresholds (Dashboard reference)

| Metric                 | Target   |
| ---------------------- | -------- |
| **uptime**             | ≥ 99.5 % |
| **diag\_latency\_p95** | < 8 с    |
| **error\_rate**        | < 2 %    |

> Снимок дашборда Grafana: `Diagnosis Overview → SLO`.

---

Документ `docs/alerting_guide.md` (v1.1) заменяет версию 1.0.
