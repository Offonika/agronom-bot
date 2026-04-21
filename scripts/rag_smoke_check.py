"""Smoke-check retrieval path for RAG."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RAG retrieval smoke check")
    parser.add_argument(
        "--query",
        default="трипсы на комнатных растениях",
        help="User-like query for retrieval check",
    )
    parser.add_argument(
        "--min-hits",
        type=int,
        default=1,
        help="Required minimal number of retrieved chunks",
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="PostgreSQL DSN override",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=4,
        help="Retrieval limit for this smoke check",
    )
    return parser.parse_args()


def main() -> int:
    from app.config import Settings
    from app.db import init_db
    from app.services.knowledge_rag import retrieve_context

    args = _parse_args()
    if args.database_url:
        os.environ["DATABASE_URL"] = args.database_url
    os.environ["ASSISTANT_RAG_ENABLED"] = "1"
    os.environ["ASSISTANT_RAG_TOP_K"] = str(max(1, args.top_k))

    try:
        init_db(Settings())
        rows = retrieve_context(args.query, limit=max(1, args.top_k))
    except Exception as exc:
        print(f"[fail] smoke check failed: {exc}", file=sys.stderr)
        return 1

    count = len(rows)
    print(f"retrieved={count}")
    for row in rows[:3]:
        print(f"- {row.get('similarity')}: {row.get('source_url')}")
    return 0 if count >= max(1, args.min_hits) else 2


if __name__ == "__main__":
    raise SystemExit(main())
