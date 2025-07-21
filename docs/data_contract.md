Data Contract – «Карманный агроном» (Bot‑Phase)
Version 1.3 — 20 July 2025
(v1.2 → v1.3: добавлен лимит 5 фото/мес, новая таблица photo_quota, поле signature в partner_orders, расширен enum ошибок, обновлён lifecycle)
0 · Scope
Документ фиксирует схему БД, правила хранения, линии происхождения данных и JSON‑контракты API для MVP Telegram‑бота.
1 · Storage & Retention
Фото хранятся в S3 с TTL = 90 дней (через lifecycle rule). Табличные строки (photos) остаются ещё 30 дней с флагом deleted для аудита.
2 · Logical Schema (ER‑text)
users 1—n photosusers 1—n paymentsusers 1—n partner_ordersusers 1—1 photo_quotaphotos 1—1 protocols
3 · Table Definitions
3.1 users
id PK, tg_id BIGINT, pro_expires_at TIMESTAMP, created_at TIMESTAMP
3.2 photos
id PK, user_id FK, file_id TEXT, file_unique_id TEXT, width INT, height INT, file_size INT, crop TEXT, disease TEXT, confidence NUMERIC, status TEXT, ts TIMESTAMP, deleted BOOLEAN
3.3 protocols
Без изменений
3.4 payments
id PK, user_id FK, amount INT, source TEXT, status payment_status, created_at TIMESTAMP
3.5 partner_orders
id PK, user_id FK, order_id TEXT, protocol_id INT, price_kopeks INT, signature TEXT, created_at TIMESTAMP, status order_status
3.6 photo_quota (NEW)
user_id PK, used_count INT, month_year CHAR(7)
4 · Enum Definitions
CREATE TYPE payment_status AS ENUM ('success','fail','cancel','bank_error');CREATE TYPE photo_status   AS ENUM ('pending','ok','retrying');CREATE TYPE order_status   AS ENUM ('new','processed','cancelled');CREATE TYPE error_code     AS ENUM ('NO_LEAF', 'LIMIT_EXCEEDED', 'GPT_TIMEOUT', 'BAD_REQUEST', 'UNAUTHORIZED');
5 · Data Lifecycle
graph TDPENDING[photos.status=pending] -->|predict| OK[status=ok]PENDING -->|retry| RETRY[status=retrying]RETRY -->|predict| OKPhotos auto-delete from S3 after 90d. DB rows soft-deleted 30d later. Quota resets monthly.
6 · API ↔ DB Mapping (extract)
/v1/ai/diagnose → insert photos/v1/limits → read photo_quota + count from photos/v1/payments/sbp/webhook → insert payments/v1/partner/orders → insert partner_orders (with signature)
7 · Ownership & Lineage
Airflow DAG: export_daily_metrics → S3 → Metabase. См. Data_Lineage.xlsx.
8 · Privacy & Compliance
Фото обезличены (нет EXIF). TTL 90 дней в S3 + 30 дн в БД. DPIA §4 выполнена.Платёжные данные храним 5 лет (ФЗ‑402).DSR endpoint: /v1/dsr/delete_user → удаление по user_id каскадно.
9 · Change Management
Схема версионируется через Alembic (semver). Breaking — bump minor.CI проверяет openapi-diff, PR требует ревью Data Owner.
10 · Sign-off
Approved by: Tech Lead, Data Owner, QA.