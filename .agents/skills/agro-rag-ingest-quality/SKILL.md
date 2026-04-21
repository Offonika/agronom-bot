---
name: agro-rag-ingest-quality
description: "Веди ingestion-контроль RAG для houseplants: quality-check источников, preview, manifest и smoke-проверки чанков перед загрузкой в индекс."
---

# Agro RAG Ingest Quality

## Scope

- Применяй skill для пайплайна `load/rag_raw -> load/rag_preview -> load/*manifest*` и подготовки чанков.
- Не применяй для задач, не связанных с контентной базой RAG.

## Workflow

1. Проверь входные источники:
- наличие/доступность файлов в `load/rag_raw`
- корректность формата и извлечённого текста в `load/rag_preview`
2. Прогони preflight/smoke:
- `./venv/bin/python scripts/rag_preflight.py`
- `./venv/bin/python scripts/rag_smoke_check.py`
3. Проверь manifest:
- консистентность `manifest.jsonl` и `manifest.csv`
- отсутствие критичных пустых полей (`source/url/title/text`)
4. Проверь базовые quality-сигналы:
- разумный объём текста на документ
- отсутствие явных дублей/мусорных страниц
- язык и тематика соответствуют домену houseplants
5. Подготовь отчёт ingest:
- сколько документов прошло/отбраковано
- какие источники требуют ручной доработки
- рекомендации до индексации

## Guardrails

- Не смешивай сырой HTML и очищенный текст в одном поле манифеста.
- Не пропускай документы без минимального полезного контента.
- При массовых ошибках останавливай загрузку и фиксируй блокер.
