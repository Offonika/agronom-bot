"""RAG retrieval helpers for assistant knowledge base."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from sqlalchemy import bindparam, text

from app import db as db_module
from app.services.gpt import call_gpt_embeddings

logger = logging.getLogger(__name__)

_SPACES_RE = re.compile(r"\s+")


def rag_enabled() -> bool:
    raw = os.environ.get("ASSISTANT_RAG_ENABLED", "0")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def retrieve_context(query: str, *, limit: int | None = None) -> list[dict[str, Any]]:
    if not rag_enabled():
        return []
    if not query or not query.strip():
        return []
    if db_module.engine is None:
        logger.debug("RAG skipped: db engine is not initialized")
        return []
    if db_module.engine.dialect.name != "postgresql":
        logger.debug("RAG skipped: only postgresql/pgvector is supported")
        return []

    top_k = limit if isinstance(limit, int) and limit > 0 else _env_int("ASSISTANT_RAG_TOP_K", default=4)
    top_k = max(1, min(top_k, 8))
    min_similarity = _env_float("ASSISTANT_RAG_MIN_SIMILARITY", default=0.2)
    probes = max(1, min(_env_int("ASSISTANT_RAG_IVFFLAT_PROBES", default=50), 200))
    max_per_source = max(1, min(_env_int("ASSISTANT_RAG_MAX_CHUNKS_PER_SOURCE", default=2), 4))
    lang_filter = _env_csv("ASSISTANT_RAG_FILTER_LANG")
    category_filter = _env_csv("ASSISTANT_RAG_FILTER_CATEGORY")
    embedding_model = (os.environ.get("OPENAI_RAG_EMBEDDING_MODEL") or "text-embedding-3-small").strip()

    try:
        vectors = call_gpt_embeddings([query], model=embedding_model)
    except Exception as exc:  # pragma: no cover - network/provider failures
        logger.warning("RAG embedding failed: %s", exc)
        return []
    if not vectors or not vectors[0]:
        return []

    query_vector = _vector_literal(vectors[0])
    candidate_limit = min(64, max(top_k * 8, top_k))
    sql = _build_retrieval_query(
        with_lang_filter=bool(lang_filter),
        with_category_filter=bool(category_filter),
    )
    params: dict[str, Any] = {
        "query_vector": query_vector,
        "limit": candidate_limit,
    }
    if lang_filter:
        params["lang_filter"] = lang_filter
    if category_filter:
        params["category_filter"] = category_filter

    with db_module.SessionLocal() as session:
        session.execute(text("SET LOCAL ivfflat.probes = :probes"), {"probes": probes})
        rows = session.execute(sql, params).mappings()
        result: list[dict[str, Any]] = []
        source_hits: dict[str, int] = {}
        raw_hits = 0
        for row in rows:
            raw_hits += 1
            similarity_raw = row.get("similarity")
            similarity = float(similarity_raw) if similarity_raw is not None else 0.0
            if similarity < min_similarity:
                continue
            source_url = str(row.get("source_url") or "").strip()
            if source_url:
                source_count = source_hits.get(source_url, 0)
                if source_count >= max_per_source:
                    continue
                source_hits[source_url] = source_count + 1
            text_raw = str(row.get("chunk_text") or "")
            snippet = _SPACES_RE.sub(" ", text_raw).strip()
            if len(snippet) > 420:
                snippet = f"{snippet[:417].rstrip()}..."
            result.append(
                {
                    "id": row.get("id"),
                    "source_url": source_url or row.get("source_url"),
                    "title": row.get("title"),
                    "category": row.get("category"),
                    "priority": row.get("priority"),
                    "similarity": round(similarity, 4),
                    "snippet": snippet,
                }
            )
            if len(result) >= top_k:
                break
        logger.info(
            "RAG retrieval probes=%s raw_hits=%s returned=%s hit_rate=%.2f filters(lang=%s,category=%s)",
            probes,
            raw_hits,
            len(result),
            len(result) / float(top_k),
            ",".join(lang_filter) if lang_filter else "-",
            ",".join(category_filter) if category_filter else "-",
        )
        return result


def build_llm_knowledge_context(message: str) -> list[dict[str, Any]]:
    try:
        rows = retrieve_context(message)
    except Exception as exc:  # pragma: no cover - defensive fallback
        logger.warning("RAG retrieval failed: %s", exc)
        return []
    return [
        {
            "title": row.get("title"),
            "source_url": row.get("source_url"),
            "category": row.get("category"),
            "similarity": row.get("similarity"),
            "excerpt": row.get("snippet"),
        }
        for row in rows
    ]


def _env_int(name: str, *, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def _env_float(name: str, *, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


def _env_csv(name: str) -> list[str]:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = None
        if isinstance(data, list):
            return [str(item).strip() for item in data if str(item).strip()]
    return [part.strip() for part in raw.split(",") if part.strip()]


def _build_retrieval_query(*, with_lang_filter: bool, with_category_filter: bool):
    where: list[str] = ["embedding IS NOT NULL"]
    bind_params: list[Any] = []
    if with_lang_filter:
        where.append("lang IN :lang_filter")
        bind_params.append(bindparam("lang_filter", expanding=True))
    if with_category_filter:
        where.append("category IN :category_filter")
        bind_params.append(bindparam("category_filter", expanding=True))

    query = text(
        f"""
        SELECT
            id,
            source_url,
            title,
            category,
            priority,
            chunk_text,
            (1 - (embedding <=> CAST(:query_vector AS vector))) AS similarity
        FROM knowledge_chunks
        WHERE {" AND ".join(where)}
        ORDER BY embedding <=> CAST(:query_vector AS vector)
        LIMIT :limit
        """
    )
    if bind_params:
        query = query.bindparams(*bind_params)
    return query


def _vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{float(v):.8f}" for v in values) + "]"
