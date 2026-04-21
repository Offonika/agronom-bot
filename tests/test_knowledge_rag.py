from __future__ import annotations

from types import SimpleNamespace

from app import db as db_module
from app.services import knowledge_rag


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self._rows


class _Session:
    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls

    def execute(self, sql, params=None):
        self._calls.append((str(sql), params or {}))
        if "SET LOCAL ivfflat.probes" in str(sql):
            return _Result([])
        return _Result(self._rows)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_build_llm_knowledge_context_disabled(monkeypatch):
    monkeypatch.setenv("ASSISTANT_RAG_ENABLED", "0")
    assert knowledge_rag.build_llm_knowledge_context("трипсы на фикусе") == []


def test_retrieve_context_skips_non_postgres(monkeypatch):
    monkeypatch.setenv("ASSISTANT_RAG_ENABLED", "1")
    monkeypatch.setattr(
        db_module,
        "engine",
        SimpleNamespace(dialect=SimpleNamespace(name="sqlite")),
    )
    assert knowledge_rag.retrieve_context("как лечить трипсов") == []


def test_retrieve_context_applies_similarity_and_probes(monkeypatch):
    monkeypatch.setenv("ASSISTANT_RAG_ENABLED", "1")
    monkeypatch.setenv("ASSISTANT_RAG_TOP_K", "3")
    monkeypatch.setenv("ASSISTANT_RAG_MIN_SIMILARITY", "0.8")
    monkeypatch.setenv("ASSISTANT_RAG_IVFFLAT_PROBES", "77")

    monkeypatch.setattr(
        knowledge_rag,
        "call_gpt_embeddings",
        lambda texts, model="text-embedding-3-small": [[0.1, 0.2, 0.3]],
    )

    rows = [
        {
            "id": 1,
            "source_url": "https://example.org/plant-1",
            "title": "Houseplant Pests",
            "category": "pests",
            "priority": "A",
            "chunk_text": "Thrips can be controlled with isolation and regular inspection.",
            "similarity": 0.83,
        },
        {
            "id": 2,
            "source_url": "https://example.org/plant-2",
            "title": "Houseplant Watering",
            "category": "care",
            "priority": "B",
            "chunk_text": "Do not overwater.",
            "similarity": 0.31,
        },
    ]
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        db_module,
        "engine",
        SimpleNamespace(dialect=SimpleNamespace(name="postgresql")),
    )
    monkeypatch.setattr(db_module, "SessionLocal", lambda: _Session(rows, calls))

    result = knowledge_rag.retrieve_context("как лечить трипсов")
    assert len(result) == 1
    assert result[0]["source_url"] == "https://example.org/plant-1"
    assert result[0]["similarity"] == 0.83
    assert any("SET LOCAL ivfflat.probes" in sql for sql, _ in calls)
    set_local_call = [params for sql, params in calls if "SET LOCAL ivfflat.probes" in sql][0]
    assert set_local_call["probes"] == 77


def test_retrieve_context_dedup_by_source(monkeypatch):
    monkeypatch.setenv("ASSISTANT_RAG_ENABLED", "1")
    monkeypatch.setenv("ASSISTANT_RAG_TOP_K", "3")
    monkeypatch.setenv("ASSISTANT_RAG_MIN_SIMILARITY", "0.1")
    monkeypatch.setenv("ASSISTANT_RAG_MAX_CHUNKS_PER_SOURCE", "1")

    monkeypatch.setattr(
        knowledge_rag,
        "call_gpt_embeddings",
        lambda texts, model="text-embedding-3-small": [[0.1, 0.2, 0.3]],
    )

    rows = [
        {
            "id": 1,
            "source_url": "https://example.org/same-source",
            "title": "Chunk 1",
            "category": "pests",
            "priority": "A",
            "chunk_text": "Text 1",
            "similarity": 0.95,
        },
        {
            "id": 2,
            "source_url": "https://example.org/same-source",
            "title": "Chunk 2",
            "category": "pests",
            "priority": "A",
            "chunk_text": "Text 2",
            "similarity": 0.93,
        },
        {
            "id": 3,
            "source_url": "https://example.org/another-source",
            "title": "Chunk 3",
            "category": "care",
            "priority": "B",
            "chunk_text": "Text 3",
            "similarity": 0.91,
        },
    ]
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        db_module,
        "engine",
        SimpleNamespace(dialect=SimpleNamespace(name="postgresql")),
    )
    monkeypatch.setattr(db_module, "SessionLocal", lambda: _Session(rows, calls))

    result = knowledge_rag.retrieve_context("query")
    assert len(result) == 2
    assert result[0]["source_url"] == "https://example.org/same-source"
    assert result[1]["source_url"] == "https://example.org/another-source"


def test_retrieve_context_applies_lang_and_category_filters(monkeypatch):
    monkeypatch.setenv("ASSISTANT_RAG_ENABLED", "1")
    monkeypatch.setenv("ASSISTANT_RAG_FILTER_LANG", "ru,en")
    monkeypatch.setenv("ASSISTANT_RAG_FILTER_CATEGORY", '["pests","care"]')

    monkeypatch.setattr(
        knowledge_rag,
        "call_gpt_embeddings",
        lambda texts, model="text-embedding-3-small": [[0.1, 0.2, 0.3]],
    )

    rows = [
        {
            "id": 1,
            "source_url": "https://example.org/plant",
            "title": "Houseplant Pests",
            "category": "pests",
            "priority": "A",
            "chunk_text": "Thrips can be controlled.",
            "similarity": 0.83,
        }
    ]
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        db_module,
        "engine",
        SimpleNamespace(dialect=SimpleNamespace(name="postgresql")),
    )
    monkeypatch.setattr(db_module, "SessionLocal", lambda: _Session(rows, calls))

    knowledge_rag.retrieve_context("как лечить трипсов")
    retrieval_call_params = [params for sql, params in calls if "FROM knowledge_chunks" in sql][0]
    assert retrieval_call_params["lang_filter"] == ["ru", "en"]
    assert retrieval_call_params["category_filter"] == ["pests", "care"]
