# Metrics Report Workflow

Version 1.0 — 2025‑07‑27

This runbook describes how to generate the post‑release metrics report.
The script `scripts/metrics_report.py` gathers key indicators from
Prometheus and the database and posts a summary to Slack.

## Usage

```bash
# set required environment variables
export PROMETHEUS_URL=http://prometheus.example.com
export DATABASE_URL=postgresql://user:pass@localhost/db
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX

python scripts/metrics_report.py
```

## Scheduling

In production the report should be sent 72 hours after a new release.
This can be achieved with a Kubernetes CronJob or any CI scheduler.
The job simply runs the script with the environment variables above.

The message is posted to the channel `#agronom-reports`.
