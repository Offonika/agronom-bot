"""Preflight checks for RAG bootstrap on PostgreSQL + pgvector."""

from __future__ import annotations

import argparse
import os
import sys

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate RAG DB prerequisites")
    parser.add_argument(
        "--database-url",
        default=None,
        help="PostgreSQL DSN (overrides DATABASE_URL)",
    )
    return parser.parse_args()


def _resolve_database_url(cli_database_url: str | None) -> str:
    url = (cli_database_url or os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is required (or pass --database-url)")
    return url


def run_preflight(database_url: str) -> None:
    engine = create_engine(database_url, future=True)
    if engine.dialect.name != "postgresql":
        raise RuntimeError("RAG requires PostgreSQL with pgvector")

    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
        vector_exists = bool(
            conn.execute(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')"
                )
            ).scalar()
        )
        table_exists = bool(
            conn.execute(
                text(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM information_schema.tables
                        WHERE table_schema = 'public'
                          AND table_name = 'knowledge_chunks'
                    )
                    """
                )
            ).scalar()
        )

    print("[ok] DB connection")
    if not vector_exists:
        raise RuntimeError(
            "pgvector extension is missing. "
            "Install pgvector and run: SELECT extname FROM pg_extension WHERE extname='vector';"
        )
    print("[ok] extension vector")
    if not table_exists:
        raise RuntimeError(
            "knowledge_chunks table is missing. Run `alembic upgrade head` first."
        )
    print("[ok] table knowledge_chunks")


def main() -> int:
    args = _parse_args()
    try:
        database_url = _resolve_database_url(args.database_url)
        run_preflight(database_url)
    except (RuntimeError, SQLAlchemyError) as exc:
        print(f"[fail] {exc}", file=sys.stderr)
        return 1
    print("RAG preflight passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
