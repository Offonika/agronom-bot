from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, text


def _integration_db_url() -> str:
    return (
        os.environ.get("RAG_PGVECTOR_TEST_DATABASE_URL")
        or os.environ.get("DATABASE_URL", "")
    ).strip()


def test_pgvector_schema_ready_on_postgres():
    if os.environ.get("RUN_RAG_PGVECTOR_INTEGRATION") != "1":
        pytest.skip("set RUN_RAG_PGVECTOR_INTEGRATION=1 to run pgvector integration checks")

    database_url = _integration_db_url()
    if not database_url.startswith("postgresql"):
        pytest.skip("pgvector integration test requires PostgreSQL DATABASE_URL")

    engine = create_engine(database_url, future=True)
    try:
        with engine.connect() as conn:
            assert conn.execute(text("SELECT 1")).scalar() == 1
            has_vector = bool(
                conn.execute(
                    text(
                        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')"
                    )
                ).scalar()
            )
            assert has_vector is True

            has_table = bool(
                conn.execute(
                    text(
                        """
                        SELECT EXISTS (
                            SELECT 1
                            FROM information_schema.tables
                            WHERE table_schema='public' AND table_name='knowledge_chunks'
                        )
                        """
                    )
                ).scalar()
            )
            assert has_table is True

            has_index = bool(
                conn.execute(
                    text(
                        """
                        SELECT EXISTS (
                            SELECT 1
                            FROM pg_indexes
                            WHERE schemaname='public'
                              AND tablename='knowledge_chunks'
                              AND indexname='ix_knowledge_chunks_embedding_ivfflat'
                        )
                        """
                    )
                ).scalar()
            )
            assert has_index is True
    finally:
        engine.dispose()
