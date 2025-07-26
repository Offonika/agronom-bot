(v1.4 → v1.5: monthly usage via photo_usage, payment on limit reach)
Security & Compliance Checklist – «Карманный агроном» (Bot‑Phase)
Version 1.5 — 26 July 2025
(v1.3 → v1.4: API rate-limit, business quota FREE_MONTHLY_LIMIT/mo (default 5), signature in body, UNAUTHORIZED error, API versioning X‑API‑Ver, /v1/limits added)
All controls map to ISO 27001 Annex A. Personal data limited; 152‑ФЗ not triggered.
1. API Security Controls
• API requests require `X-API-Key` (header)• Partner API requires `X-Sign` (HMAC-SHA256) and duplicate `signature` field in body• Signature is validated using shared secret from Vault (rotated every 90 days)• All API requests must include `X-API-Ver: v1` (required for version control)• Rate limit: 30 RPS per user• Business quota: FREE_MONTHLY_LIMIT diagnosis requests/month for Free users (default 5), tracked per user_id• Violations return `ErrorResponse` with machine-readable code: `UNAUTHORIZED`, `LIMIT_EXCEEDED`, etc.
2. Data Security
• TLS 1.2+ enforced on all endpoints• Data at rest is AES-256 encrypted (S3, RDS)• GPT API key stored in Vault, rotated monthly• Diagnosis photos auto-deleted after 90 days (S3 lifecycle policy)• GDPR/DSR endpoints: /v1/users/{id}/export, /delete (SLA: 30 days)• Photos linked to user_id for enforcement of quota and GDPR exports
3. Logging & Monitoring
• All diagnosis and payment requests logged with user_id, diag_id, latency, error_code• Logs are structured (JSON) and retained for 30 days (Loki)• Alerts configured for GPT timeout rate > 5% and 401 spikes• Metrics tracked in Prometheus: diag_latency_seconds, diag_requests_total, quota_reject_total
4. Compliance Verification
• Secrets stored in Vault with rotation policies (GPT: 30d, HMAC: 90d)• All API schemas validated via OpenAPI + Spectral in CI• API diff changes tracked in ADR (v1.2+)• Manual audit checklist reviewed each release (QA + Security)• Edge case coverage for business rules (e.g., quota violations) in QA plan