Security & Compliance Checklist – «Карманный агроном» (Bot‑Phase)

Version 1.6 — 5 August 2025(v1.5 → v1.6: Tinkoff Autopay flow, IP allowlist for webhooks, idempotency keys, Opt‑In ML‑датасет)

Все меры маппятся на ISO 27001:2022 Annex A. Персональные данные минимальны; ФЗ‑152 не триггерится (анонимные фото, хэш‑uid).

1 · API Security Controls

Control

Implementation

Authentication

X-API-Key (per-user), X-User-ID, X-Req-Ts, X-Req-Nonce, X-Req-Sign, X-Req-Body-Sha256 (headers) — валидируются per‑request; key хранится в Vault

Metrics

GET /metrics (API + Bot) — защищён X-Metrics-Token или Authorization: Bearer при включении METRICS_TOKEN/BOT_METRICS_TOKEN
Versioning

X-API-Ver: v1 — обязательный, иначе 426

HMAC Integrity

API: X-Req-Sign (HMAC‑SHA256) по payload user_id/ts/nonce/method/path/query/body_sha256, с анти‑replay через Redis TTL.
Webhooks: X-Sign + signature в body (SHA‑256) для:• /v1/payments/sbp/webhook (Invoice)• /v1/payments/sbp/autopay/webhook• /v1/partner/orders

IP Allowlist

Webhook‑ингресс принимает только IP‑пулы Tinkoff (prod & sandbox) + AgroStore

Idempotency

external_id (Invoice) / autopay_charge_id (Autopay) — PK в payments, повтор вебхука безопасен

Rate‑limit

30 req/min IP, 120 req/min user (Pro — unlimited) via Redis INCR+EXPIRE; 429 + log

Business quota

FREE_MONTHLY_LIMIT (5) проверяется таблицей photo_usage; 402 on exceed

Autopay Cancel

POST /autopay/cancel — JWT (telegram hash=) + CSRF double‑submit

2 · Data Security

Area

Measure

Transport

TLS 1.2+ for external, mTLS inside cluster

At rest

AES‑256 (RDS, S3 buckets incl. ml-dataset)

Secrets

Vault CSI, policies:GPT API Key — 30 dHMAC secret — 90 dDB creds — dynamic 24 h

Retention

Photos S3 — 90 d → soft‑delete 30 d → purge.
ML‑dataset (users.opt_in=true) — 2 y.

Payments

Stored 5 y (ФЗ‑402); card PAN не хранится (SBP)

DSR

/v1/dsr/delete_user — каскад, SLA 30 d

3 · Logging & Monitoring

Item

Details

Structured logs

JSON; fields: user_id, diag_id, endpoint, latency, error_code, autopay

Retention

30 d (Loki), S3 export 90 d (cold)

Metrics

diag_latency_seconds, diag_requests_total, quota_reject_total, gpt_timeout_total, payment_fail_total, autopay_charge_seconds

Alerts

GPT timeout > 5 % (5 min), error‑rate > 2 %, autopay_fail_total{1h}>5, spikes 401

4 · Compliance Verification

Secrets rotation enforced via Vault policies.

OpenAPI schemas linted (Spectral) + openapi-diff gate in CI.

Static analysis (ESLint, tsc strict) + npm audit in pipeline.

Manual audit checklist (QA + Security) per release.

Pen‑test scope yearly; last scan 2025‑07‑10 (no critical vulns).

5 · Advisory / Risk

Проверьте race‑condition при параллельной загрузке 2+ фото: используйте row‑level lock (FOR UPDATE) на photo_usage.

Следить за ростом QPS > 300 — включить Redis + rate‑limit offload.
