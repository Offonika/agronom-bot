Architecture Design Record (ADR)
Project: «Карманный агроном» – Bot Phase
Version 1.3 — 20 July 2025
(v1.2 → v1.3: added /v1/limits, HMAC-in-body, X-API-Ver, API quota logic, updated scaling and error handling)
1 · Context & Goals
MVP = Telegram‑bot.Launch ≤ 2 weeks.Handle ≤ 50 000 MAU without redesign.Keep OPEX minimal (1 small VM + S3).Provide clear migration path to native app (Phase B/C).
2 · Stack Overview
(см. C4) Node.js, GPT-Vision API, PostgreSQL, Redis, S3-compatible storage, Vault, k8s, Prometheus, Loki, Grafana.
3 · C4 Diagrams (text)
C1 System: Farmer → Telegram Bot ↔ Telegram API → App Svc → GPT‑Vision / PostgreSQL / S3 → Prometheus.C2 Containers: Bot Gateway, App Service, Worker, PG 14, S3 (VK), Prom+Grafana+Loki+Tempo.C3 App Components: DiagnoseController, ProtocolController, PaymentController, LimitsController.C4 Worker: BullQueue → RetryJobHandler (fetch photo → GPT → update DB).
4 · Data Flow
Photo → Bot → App /v1/ai/diagnose → store JPEG in S3 + row in photos (status=pending) → GPT → update status=ok → Bot./protocol → App → protocols table → Bot./limits → App → counts photo rows for current month./partner/orders → HMAC check (header+body) → insert order.Webhook: /v1/payments/sbp/webhook → update user → Bot.
5 · Service-Level Objectives (SLO)
diag_latency_p95 < 8s; GPT_timeout_ratio < 1%; uptime ≥ 99.5%; 0 critical quota leaks.
6 · Scaling Plan
HPA: CPU > 65% or diag_latency_p95 > 7s → scale pod.Telegram sharding: ≤ 3 tokens × 30 msg/s.Retry-Worker handles GPT fails & 429 retry queue.PostgreSQL read-replica: enabled if QPS > 300.Quota logic uses monthly index scan on photos table per user_id.
7 · Resilience & DR
PITR 7d WAL + full snapshot 02:00 MSK. Redis optional Phase A. Restore test SLA ≤ 60m.
8 · Security & Compliance
TLS 1.2+ (external), mTLS (internal).X‑API‑Key Bot ↔ App, HMAC‑SHA256 for SBP & partner orders.signature duplicated in body + header (X-Sign).API versioning required: X-API-Ver: v1.Business quota: 5 diagnosis/month for Free tier — enforced via /v1/limits.Error codes standardized (ErrorResponse.code): UNAUTHORIZED, LIMIT_EXCEEDED, GPT_TIMEOUT.
9 · CI/CD & Secrets
GitHub Actions: test → build → Docker.ArgoCD blue/green deploy.Vault CSI for secrets: GPT, SBP, HMAC.Secrets rotated: GPT monthly, HMAC every 90d.API schema diff gated in CI (openapi-diff).
10 · Observability
Prometheus: diag_latency_seconds, diag_requests_total, gpt_timeout_total, quota_reject_total.Grafana dashboards: Diagnosis, Payments, Infra.Logs: Loki (JSON: user_id, diag_id, quota).Alerts: 401 spikes, GPT timeout > 5%, diagnosis_fail > 2%.
11 · Payment Sequence (Happy Path)
User → Bot → invoice → SBP → webhook /v1/payments/sbp/webhook → DB → Bot confirms Pro.
12 · Trade-offs / Rationale
Node = fast. GPT = fast. Redis = Phase B. CV model = Phase C. VK S3 = low-cost.
13 · Future Evolution
Phase B = native app. Phase C = on-device CV. GraphQL gateway. DDD refactor > 50k MAU.
14 · Open Questions
Redis Phase A or B? S3 provider choice? Is x-region backup MVP?
15 · Approval
This document supersedes v1.2. Stored in /docs/adr_bot_phase_v1.3.md