"""Load parsed RAG chunks into PostgreSQL pgvector table."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import bindparam, create_engine, text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@dataclass
class LoadReport:
    inserted: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0
    parsed: int = 0
    loaded_sources: int = 0

    def format(self) -> str:
        return (
            f"inserted={self.inserted} updated={self.updated} "
            f"skipped={self.skipped} failed={self.failed}"
        )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load knowledge chunks to pgvector table")
    parser.add_argument(
        "--manifest",
        default="load/rag_houseplants_seed_2026_02_24/manifest.csv",
        help="Path to manifest.csv produced by ingestion pipeline",
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="PostgreSQL DSN (overrides DATABASE_URL)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="OpenAI embeddings batch size",
    )
    parser.add_argument(
        "--upsert-batch-size",
        type=int,
        default=200,
        help="Database upsert batch size",
    )
    parser.add_argument(
        "--limit-sources",
        type=int,
        default=0,
        help="Optional limit of source rows from manifest (0 = no limit)",
    )
    parser.add_argument(
        "--limit-chunks",
        type=int,
        default=0,
        help="Optional limit of chunks to upload (0 = no limit)",
    )
    parser.add_argument(
        "--embedding-model",
        default=os.environ.get("OPENAI_RAG_EMBEDDING_MODEL", "text-embedding-3-small"),
        help="Embedding model to use",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and process chunks without writing into DB",
    )
    parser.add_argument(
        "--skip-embeddings",
        action="store_true",
        help="Skip OpenAI embeddings generation (embedding will be NULL)",
    )
    parser.add_argument(
        "--only-new",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Process only new/changed chunks by chunk_hash (default: true)",
    )
    parser.add_argument(
        "--max-embed-retries",
        type=int,
        default=3,
        help="Max retries for each embedding batch on transient errors",
    )
    parser.add_argument(
        "--embed-retry-backoff-sec",
        type=float,
        default=1.0,
        help="Base backoff delay in seconds (exponential)",
    )
    return parser.parse_args()


def _resolve_database_url(cli_database_url: str | None, *, required: bool) -> str | None:
    value = (cli_database_url or os.environ.get("DATABASE_URL") or "").strip()
    if required and not value:
        raise RuntimeError("DATABASE_URL is required (or pass --database-url)")
    return value or None


def _read_manifest_rows(path: Path, limit_sources: int) -> list[dict[str, str]]:
    with path.open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        fieldnames = set(reader.fieldnames or [])
        if "chunks_jsonl" not in fieldnames:
            raise ValueError(f"{path}: missing required column `chunks_jsonl`")

        rows: list[dict[str, str]] = []
        for row_idx, row in enumerate(reader, start=2):
            status = str(row.get("status") or "").strip()
            if status and status != "200":
                continue
            chunk_file = str(row.get("chunks_jsonl") or "").strip()
            if not chunk_file:
                raise ValueError(f"{path}:{row_idx}: missing chunks_jsonl for successful row")
            rows.append(row)

    if limit_sources > 0:
        rows = rows[:limit_sources]
    return rows


def _iter_chunks(
    rows: list[dict[str, str]],
    *,
    manifest_path: Path,
    limit_chunks: int,
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for row_idx, row in enumerate(rows, start=1):
        chunk_file_raw = str(row.get("chunks_jsonl") or "").strip()
        chunk_file_path = Path(chunk_file_raw)
        if not chunk_file_path.is_absolute():
            chunk_file_path = (manifest_path.parent / chunk_file_path).resolve()
        if not chunk_file_path.exists():
            raise ValueError(
                f"{manifest_path}: row #{row_idx} points to missing chunks file: {chunk_file_path}"
            )

        with chunk_file_path.open(encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, start=1):
                raw = line.strip()
                if not raw:
                    continue
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise ValueError(
                        f"{chunk_file_path}:{line_no}: invalid JSON ({exc.msg})"
                    ) from exc
                if not isinstance(payload, dict):
                    raise ValueError(f"{chunk_file_path}:{line_no}: chunk payload must be an object")
                chunk = _build_chunk(payload, row=row, chunk_file=chunk_file_path, line_no=line_no)
                chunks.append(chunk)
                if limit_chunks > 0 and len(chunks) >= limit_chunks:
                    return chunks
    return chunks


def _build_chunk(
    payload: dict[str, Any],
    *,
    row: dict[str, str],
    chunk_file: Path,
    line_no: int,
) -> dict[str, Any]:
    chunk_text = str(payload.get("chunk_text") or "").strip()
    if not chunk_text:
        raise ValueError(f"{chunk_file}:{line_no}: missing required field `chunk_text`")

    source_url = str(payload.get("source_url") or row.get("seed_url") or "").strip()
    if not source_url:
        raise ValueError(f"{chunk_file}:{line_no}: missing source_url (payload.source_url or seed_url)")

    chunk_hash = hashlib.sha256(f"{source_url}\n{chunk_text}".encode("utf-8")).hexdigest()
    meta = {
        "ingested_at": row.get("ingested_at"),
        "seed_url": row.get("seed_url"),
        "final_url": row.get("final_url"),
        "raw_html": row.get("raw_html"),
        "parsed_txt": row.get("parsed_txt"),
        "chunk_id": payload.get("chunk_id"),
        "char_count": payload.get("char_count"),
    }
    lang = str(payload.get("lang") or "").strip().lower()
    if not lang:
        lang = "ru" if ".ru" in source_url else "en"

    return {
        "source_url": source_url,
        "title": str(payload.get("title") or row.get("title") or "").strip() or None,
        "category": str(payload.get("category") or row.get("category") or "").strip() or None,
        "priority": str(payload.get("priority") or row.get("priority") or "").strip() or None,
        "lang": lang,
        "chunk_text": chunk_text,
        "chunk_hash": chunk_hash,
        "meta_json": json.dumps(meta, ensure_ascii=False),
        "embedding": None,
    }


def _dedupe_chunks(chunks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    duplicates = 0
    for chunk in chunks:
        chunk_hash = str(chunk["chunk_hash"])
        if chunk_hash in seen:
            duplicates += 1
            continue
        seen.add(chunk_hash)
        unique.append(chunk)
    return unique, duplicates


def _vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"


def _ensure_rag_prerequisites(database_url: str) -> Any:
    engine = create_engine(database_url, future=True)
    if engine.dialect.name != "postgresql":
        raise RuntimeError("load_knowledge_chunks.py supports only PostgreSQL + pgvector")
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
    if not vector_exists:
        raise RuntimeError(
            "pgvector extension is missing. "
            "Run `python scripts/rag_preflight.py` for diagnostics."
        )
    if not table_exists:
        raise RuntimeError(
            "knowledge_chunks table not found. Run `alembic upgrade head` first."
        )
    return engine


def _fetch_existing_hashes(engine: Any, chunk_hashes: list[str]) -> set[str]:
    if not chunk_hashes:
        return set()

    stmt = text(
        "SELECT chunk_hash FROM knowledge_chunks WHERE chunk_hash IN :chunk_hashes"
    ).bindparams(bindparam("chunk_hashes", expanding=True))
    existing: set[str] = set()
    with engine.connect() as conn:
        for idx in range(0, len(chunk_hashes), 1000):
            batch = chunk_hashes[idx : idx + 1000]
            rows = conn.execute(stmt, {"chunk_hashes": batch})
            existing.update(str(row[0]) for row in rows)
    return existing


def _select_chunks_for_processing(
    chunks: list[dict[str, Any]],
    *,
    existing_hashes: set[str],
    only_new: bool,
) -> tuple[list[dict[str, Any]], int]:
    selected: list[dict[str, Any]] = []
    skipped = 0
    for chunk in chunks:
        chunk_hash = str(chunk["chunk_hash"])
        if only_new and chunk_hash in existing_hashes:
            skipped += 1
            continue
        selected.append(chunk)
    return selected, skipped


def _embed_chunks(
    chunks: list[dict[str, Any]],
    *,
    batch_size: int,
    model: str,
    max_retries: int,
    backoff_seconds: float,
) -> tuple[list[dict[str, Any]], int]:
    from app.services.gpt import call_gpt_embeddings

    if not chunks:
        return [], 0

    ready: list[dict[str, Any]] = []
    failed = 0
    retry_limit = max(0, int(max_retries))
    safe_batch_size = batch_size if batch_size > 0 else 32
    base_backoff = backoff_seconds if backoff_seconds > 0 else 1.0

    for idx in range(0, len(chunks), safe_batch_size):
        batch = chunks[idx : idx + safe_batch_size]
        texts = [str(item["chunk_text"]) for item in batch]
        vectors: list[list[float]] | None = None
        for attempt in range(retry_limit + 1):
            try:
                vectors = call_gpt_embeddings(texts, model=model)
                break
            except Exception as exc:  # pragma: no cover - network/provider failures
                if attempt >= retry_limit:
                    print(
                        f"[warn] embeddings failed for batch {idx // safe_batch_size + 1}: {exc}",
                        file=sys.stderr,
                    )
                    break
                delay = base_backoff * (2**attempt)
                print(
                    f"[warn] retry embeddings batch {idx // safe_batch_size + 1} "
                    f"attempt={attempt + 1}/{retry_limit} in {delay:.1f}s: {exc}",
                    file=sys.stderr,
                )
                time.sleep(delay)

        if vectors is None:
            failed += len(batch)
            continue
        if len(vectors) != len(batch):
            print(
                "[warn] embeddings response size mismatch; "
                f"expected={len(batch)} got={len(vectors)}",
                file=sys.stderr,
            )
            failed += len(batch)
            continue

        for item, vector in zip(batch, vectors):
            item["embedding"] = _vector_literal(vector)
            ready.append(item)

    return ready, failed


def _upsert_chunks(engine: Any, chunks: list[dict[str, Any]], *, batch_size: int) -> int:
    if not chunks:
        return 0

    query = text(
        """
        INSERT INTO knowledge_chunks (
            source_url,
            title,
            category,
            priority,
            lang,
            chunk_text,
            chunk_hash,
            meta_json,
            embedding,
            created_at,
            updated_at
        ) VALUES (
            :source_url,
            :title,
            :category,
            :priority,
            :lang,
            :chunk_text,
            :chunk_hash,
            CAST(:meta_json AS JSONB),
            CAST(:embedding AS vector),
            NOW(),
            NOW()
        )
        ON CONFLICT (chunk_hash) DO UPDATE SET
            source_url = EXCLUDED.source_url,
            title = EXCLUDED.title,
            category = EXCLUDED.category,
            priority = EXCLUDED.priority,
            lang = EXCLUDED.lang,
            chunk_text = EXCLUDED.chunk_text,
            meta_json = EXCLUDED.meta_json,
            embedding = EXCLUDED.embedding,
            updated_at = NOW()
        """
    )
    safe_batch_size = batch_size if batch_size > 0 else 200
    total = 0
    with engine.begin() as conn:
        for idx in range(0, len(chunks), safe_batch_size):
            batch = chunks[idx : idx + safe_batch_size]
            conn.execute(query, batch)
            total += len(batch)
    return total


def _print_report(report: LoadReport) -> None:
    print(
        "Report:",
        report.format(),
    )


def run(args: argparse.Namespace) -> tuple[LoadReport, bool]:
    report = LoadReport()
    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        raise RuntimeError(f"manifest not found: {manifest_path}")

    rows = _read_manifest_rows(manifest_path, args.limit_sources)
    report.loaded_sources = len(rows)
    chunks = _iter_chunks(rows, manifest_path=manifest_path, limit_chunks=args.limit_chunks)
    if not chunks:
        print("No chunks found in manifest")
        return report, False

    chunks, duplicates = _dedupe_chunks(chunks)
    report.parsed = len(chunks)
    report.skipped += duplicates

    print(f"Loaded {report.loaded_sources} sources from manifest")
    print(f"Parsed {report.parsed} chunks")

    requires_database = args.only_new or not args.dry_run
    database_url = _resolve_database_url(args.database_url, required=requires_database)
    existing_hashes: set[str] = set()
    engine = None
    try:
        if database_url:
            engine = _ensure_rag_prerequisites(database_url)
            existing_hashes = _fetch_existing_hashes(
                engine, [str(chunk["chunk_hash"]) for chunk in chunks]
            )
            if existing_hashes:
                print(f"Existing chunks in DB by hash: {len(existing_hashes)}")

        pending, skipped_existing = _select_chunks_for_processing(
            chunks,
            existing_hashes=existing_hashes,
            only_new=bool(args.only_new),
        )
        report.skipped += skipped_existing

        if not pending:
            print("No new/changed chunks to process")
            return report, False

        if args.skip_embeddings:
            print("Embeddings: skipped")
            for item in pending:
                item["embedding"] = None
        else:
            print(f"Embedding model: {args.embedding_model}")
            pending, failed = _embed_chunks(
                pending,
                batch_size=args.batch_size,
                model=args.embedding_model,
                max_retries=args.max_embed_retries,
                backoff_seconds=args.embed_retry_backoff_sec,
            )
            report.failed += failed
            if failed:
                print(f"Embedding failed for chunks: {failed}", file=sys.stderr)

        if not pending:
            return report, False

        for item in pending:
            if str(item["chunk_hash"]) in existing_hashes:
                report.updated += 1
            else:
                report.inserted += 1

        if args.dry_run:
            print("Dry-run complete, DB write skipped")
            return report, False

        if engine is None:
            raise RuntimeError("Database engine is not initialized")
        _upsert_chunks(engine, pending, batch_size=args.upsert_batch_size)
        return report, True
    finally:
        if engine is not None:
            engine.dispose()


def main() -> int:
    args = _parse_args()
    try:
        report, wrote = run(args)
    except Exception as exc:
        print(f"[fatal] {exc}", file=sys.stderr)
        return 1

    if wrote:
        print("DB upsert complete")
    _print_report(report)
    if report.failed > 0:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
