"""add knowledge chunks table for assistant RAG

Revision ID: 20260224_add_knowledge_chunks
Revises: 20260224_add_diagnosis_message_contexts
Create Date: 2026-02-24 20:45:00.000000
"""

from __future__ import annotations

from alembic import op
from sqlalchemy.exc import DBAPIError


# revision identifiers, used by Alembic.
revision = "20260224_add_knowledge_chunks"
down_revision = "20260224_add_diagnosis_message_contexts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        raise RuntimeError(
            "Migration 20260224_add_knowledge_chunks requires PostgreSQL 15+ with pgvector. "
            "Use docker-compose DB image pgvector/pgvector:pg15 and rerun `alembic upgrade head`."
        )

    try:
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    except DBAPIError as exc:
        raise RuntimeError(
            "Failed to create extension `vector`. Ensure pgvector is installed in PostgreSQL "
            "and verify with: SELECT extname FROM pg_extension WHERE extname='vector';"
        ) from exc

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id BIGSERIAL PRIMARY KEY,
            source_url TEXT NOT NULL,
            title TEXT,
            category VARCHAR(64),
            priority VARCHAR(8),
            lang VARCHAR(8) NOT NULL DEFAULT 'en',
            chunk_text TEXT NOT NULL,
            chunk_hash VARCHAR(64) NOT NULL,
            meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            embedding vector(1536),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_knowledge_chunks_chunk_hash UNIQUE (chunk_hash)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_source_url "
        "ON knowledge_chunks (source_url)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_category_priority "
        "ON knowledge_chunks (category, priority)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_embedding_ivfflat "
        "ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        raise RuntimeError(
            "Migration 20260224_add_knowledge_chunks downgrade requires PostgreSQL 15+ with pgvector."
        )

    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_embedding_ivfflat")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_category_priority")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_source_url")
    op.execute("DROP TABLE IF EXISTS knowledge_chunks")
