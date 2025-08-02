#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------
# 🔐 Безопасный запуск Alembic миграций (PostgreSQL)
# ------------------------------------------------------
# • Прерывает выполнение, если есть DDL-запросы >2 сек
# • Поддерживает режим --dry-run
# • Подгружает переменные из .env (без # и пустых)
# ------------------------------------------------------

# Загрузить переменные из .env
if [ -f ".env" ]; then
  set -a
  source <(grep -v '^#' .env | grep -v '^\s*$')
  set +a
fi

# Получить DATABASE_URL, или использовать значение по умолчанию
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/agronom}"

# Удаляем драйвер psycopg2, если указан
DB_PSQL_URL=$(echo "$DB_URL" | sed -E 's#^postgresql\+[^:]+://#postgresql://#')

# 👉 Только показать SQL без выполнения
if [[ "${1:-}" == "--dry-run" ]]; then
  alembic upgrade head --sql
  exit 0
fi

# 🧪 Пропускаем проверку для SQLite
if [[ "$DB_URL" == sqlite://* ]]; then
  alembic upgrade head
  exit 0
fi

# 🔍 Проверка на блокирующие DDL-запросы в PostgreSQL
CHECK_SQL="SELECT query FROM pg_stat_activity WHERE state = 'active' 
  AND now() - query_start > interval '2 seconds'
  AND query ~* '^(alter|create|drop|truncate|reindex|cluster)';"

BLOCKING=$(psql "$DB_PSQL_URL" -Atc "$CHECK_SQL" || true)

if [[ -n "$BLOCKING" ]]; then
  echo -e "🚫 Обнаружены активные DDL-запросы:\n$BLOCKING"
  echo "Миграция отменена."
  exit 1
fi

# 🚀 Запуск миграций Alembic
alembic upgrade head
