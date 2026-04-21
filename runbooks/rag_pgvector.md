# RAG pgvector runbook

## Цель
Быстро проверить, что окружение готово к `knowledge_chunks` и retrieval.

## Проверки
1. Поднимите БД из compose (образ с pgvector):
   ```bash
   docker compose up -d db
   ```
2. Убедитесь, что extension установлен:
   ```sql
   SELECT extname FROM pg_extension WHERE extname='vector';
   ```
3. Прогоните preflight:
   ```bash
   python scripts/rag_preflight.py --database-url "$DATABASE_URL"
   ```

Ожидаемый результат: `RAG preflight passed`.
