#!/usr/bin/env bash
set -euo pipefail

# Run Alembic migrations safely.
# - Checks for long-running DDL queries (>2 seconds) and aborts if any exist.
# - Supports --dry-run to output the SQL plan without executing.

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/agronom}"
# Normalize for psql: strip any driver prefix like postgresql+psycopg://
DB_PSQL_URL=$(echo "$DB_URL" | sed -E 's#^postgresql\+[^:]+://#postgresql://#')

if [[ "${1:-}" == "--dry-run" ]]; then
    alembic upgrade head --sql
    exit 0
fi

# If DATABASE_URL points to SQLite, skip PostgreSQL checks
if [[ "$DB_URL" == sqlite://* ]]; then
    alembic upgrade head
    exit 0
fi

# Query pg_stat_activity for active DDL statements running longer than 2 seconds
CHECK_SQL="SELECT query FROM pg_stat_activity WHERE state = 'active' 
  AND now() - query_start > interval '2 seconds'
  AND query ~* '^(alter|create|drop|truncate|reindex|cluster)';"

BLOCKING=$(psql "$DB_PSQL_URL" -Atc "$CHECK_SQL" || true)

if [[ -n "$BLOCKING" ]]; then
    echo "Blocking DDL detected:\n$BLOCKING"
    echo "Abort migration."
    exit 1
fi

alembic upgrade head
