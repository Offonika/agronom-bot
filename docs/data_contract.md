Data Contract – «Карманный агроном» (Bot‑Phase)

Version 1.8 — 5 August 2025(v1.7 → v1.8: добавлены поля autopay, autopay_enabled, обновлены API‑маппинги, уточнён ML‑датасет, удалена устаревшая photo_quota)

0 · Scope

Документ фиксирует схему БД, правила хранения, линии происхождения данных и JSON‑контракты API для MVP Telegram‑бота.

1 · Storage & Retention

Фото хранятся в S3 (photos/) с TTL = 90 дней (lifecycle rule).

ML‑датасет (ml-dataset/) — копия снимков status=ok > 90 дн при Opt‑In пользователя, TTL = 2 года.

Табличные строки photos остаются ещё 30 дней после TTL с флагом deleted=true.

Платёжные данные храним 5 лет (ФЗ‑402).

2 · Logical Schema (ER‑text)

users 1—n photos
users 1—n payments
users 1—n partner_orders
users 1—n events
photos 1—1 protocols

3 · Table Definitions

3.1 users

Column

Type

Notes

id

SERIAL PK

tg_id

BIGINT UNIQUE NOT NULL

pro_expires_at

TIMESTAMP

autopay_enabled

BOOLEAN DEFAULT FALSE

created_at

TIMESTAMP DEFAULT now()

3.2 photos

Column

Type

Notes

id

SERIAL PK

user_id

INT FK → users(id)

file_id

TEXT

file_unique_id

TEXT

width

INT

height

INT

file_size

INT

crop

TEXT

disease

TEXT

confidence

NUMERIC(4,3)

retry_attempts

INT DEFAULT 0

status

photo_status

ts

TIMESTAMP DEFAULT now()

deleted

BOOLEAN DEFAULT FALSE

3.3 protocols  — unchanged

3.4 payments

Column

Type

Notes

id

SERIAL PK

user_id

INT FK → users(id)

amount

INT

копейки

currency

TEXT

RUB

status

payment_status

provider

TEXT

SBP:Tinkoff

external_id

TEXT

invoice/charge id

autopay

BOOLEAN DEFAULT FALSE

autopay_binding_id

TEXT

binding identifier

prolong_months

INT

created_at

TIMESTAMP DEFAULT now()

updated_at

TIMESTAMP

3.5 partner_orders

Column

Type

Notes

id

SERIAL PK

user_id

INT FK

order_id

TEXT

внеш. id AgroStore

protocol_id

INT FK → protocols(id)

price_kopeks

INT

signature

TEXT

HMAC партнёра

status

order_status

created_at

TIMESTAMP DEFAULT now()

3.6 photo_usage

Column

Type

PK

user_id

INT

✓

month

CHAR(7)

YYYY‑MM, ✓

used

INT

updated_at

TIMESTAMP

3.7 events

Column

Type

Notes

id

SERIAL PK

user_id

INT

event

TEXT

e.g. payment_success, autopay_fail

ts

TIMESTAMP DEFAULT now()

4 · Enum Definitions

CREATE TYPE payment_status AS ENUM ('success','fail','cancel','bank_error');
CREATE TYPE photo_status   AS ENUM ('pending','ok','retrying','failed');
CREATE TYPE order_status   AS ENUM ('new','processed','cancelled');
CREATE TYPE error_code     AS ENUM ('NO_LEAF','LIMIT_EXCEEDED','GPT_TIMEOUT','BAD_REQUEST','UNAUTHORIZED');

5 · Data Lifecycle

graph TD
  PENDING[photos.status=pending] -->|predict| OK[status=ok]
  PENDING -->|retry| RETRY[status=retrying]
  RETRY -->|fail| FAILED[status=failed]
  RETRY -->|predict| OK

S3: auto‑delete спустя 90 дней.

DB: deleted=true → 30 дней → hard delete.

ML‑dataset: Opt‑In → TTL 2 года.

Quota (photo_usage) ресет 1‑го числа месяца (cron).

6 · API ↔ DB Mapping

Endpoint

Action

POST /v1/ai/diagnose

INSERT → photos, UPDATE photo_usage.used

GET  /v1/limits

SELECT photo_usage + count photos

POST /v1/payments/sbp/webhook

INSERT → payments (invoice)

POST /v1/payments/sbp/autopay/webhook

INSERT → payments (autopay)

POST /v1/payments/sbp/autopay/cancel

UPDATE users.autopay_enabled=false

POST /v1/partner/orders

INSERT → partner_orders (signature)

6.1 · /v1/ai/diagnose

Принимает фото (multipart image или JSON image_base64).Возвращает {crop, disease, confidence}; создаёт photos + инкрементирует photo_usage.used.

7 · Ownership & Lineage

Airflow DAG export_daily_metrics → S3 → Metabase.См. Data_Lineage.xlsx.

8 · Privacy & Compliance

Фото обезличены (EXIF удаляется).

TTL: 90 дн (S3) + 30 дн soft‑delete.

ML‑датасет — только при Opt‑In, TTL 2 года.

Платежи: storage 5 лет (ФЗ‑402).

DSR: POST /v1/dsr/delete_user — каскадное удаление по user_id ≤ 30 дн.

9 · Change Management

Схема версионируется через Alembic (semver).

Breaking → bump minor.

CI: openapi-diff + PR review Data Owner.

10 · Sign-off

Role

Name

Date

Tech Lead

—

☐

Data Owner

—

☐

QA

—

☐