from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


def _load_module():
    root = Path(__file__).resolve().parents[1]
    module_path = root / "scripts" / "load_knowledge_chunks.py"
    spec = importlib.util.spec_from_file_location("load_knowledge_chunks_module", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _make_manifest(tmp_path: Path, chunks_jsonl: Path) -> Path:
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(
        "status,seed_url,chunks_jsonl,title,category,priority\n"
        f"200,https://example.org/a,{chunks_jsonl},Title,pests,A\n",
        encoding="utf-8",
    )
    return manifest


def _make_chunks(tmp_path: Path) -> Path:
    chunks_jsonl = tmp_path / "chunks.jsonl"
    chunks_jsonl.write_text(
        '{"chunk_text":"first chunk","source_url":"https://example.org/a","chunk_id":"1"}\n'
        '{"chunk_text":"second chunk","source_url":"https://example.org/b","chunk_id":"2"}\n',
        encoding="utf-8",
    )
    return chunks_jsonl


def _args_for(manifest: Path) -> argparse.Namespace:
    return argparse.Namespace(
        manifest=str(manifest),
        database_url="postgresql://user:pass@localhost:5432/agronom",
        batch_size=2,
        upsert_batch_size=200,
        limit_sources=0,
        limit_chunks=0,
        embedding_model="text-embedding-3-small",
        dry_run=True,
        skip_embeddings=True,
        only_new=True,
        max_embed_retries=2,
        embed_retry_backoff_sec=0.01,
    )


def test_only_new_skips_existing_hashes(tmp_path, monkeypatch):
    module = _load_module()
    manifest = _make_manifest(tmp_path, _make_chunks(tmp_path))

    class _FakeEngine:
        dialect = SimpleNamespace(name="postgresql")

        def dispose(self):
            return None

    monkeypatch.setattr(module, "_ensure_rag_prerequisites", lambda url: _FakeEngine())
    monkeypatch.setattr(module, "_fetch_existing_hashes", lambda engine, hashes: {hashes[0]})

    report, wrote = module.run(_args_for(manifest))
    assert wrote is False
    assert report.inserted == 1
    assert report.updated == 0
    assert report.skipped == 1
    assert report.failed == 0


def test_dry_run_without_db_works_when_only_new_disabled(tmp_path, monkeypatch):
    module = _load_module()
    manifest = _make_manifest(tmp_path, _make_chunks(tmp_path))
    args = _args_for(manifest)
    args.database_url = None
    args.only_new = False
    args.skip_embeddings = False
    monkeypatch.delenv("DATABASE_URL", raising=False)

    def _fake_embed(chunks, **kwargs):
        for item in chunks:
            item["embedding"] = "[0.1,0.2]"
        return chunks, 0

    monkeypatch.setattr(module, "_embed_chunks", _fake_embed)

    report, wrote = module.run(args)
    assert wrote is False
    assert report.inserted == 2
    assert report.updated == 0
    assert report.failed == 0


def test_main_returns_non_zero_on_missing_manifest(monkeypatch):
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_parse_args",
        lambda: argparse.Namespace(
            manifest="/tmp/does-not-exist.csv",
            database_url=None,
            batch_size=32,
            upsert_batch_size=200,
            limit_sources=0,
            limit_chunks=0,
            embedding_model="text-embedding-3-small",
            dry_run=True,
            skip_embeddings=True,
            only_new=False,
            max_embed_retries=3,
            embed_retry_backoff_sec=1.0,
        ),
    )
    assert module.main() == 1


def test_manifest_validation_reports_missing_chunks_jsonl(tmp_path):
    module = _load_module()
    manifest = tmp_path / "bad_manifest.csv"
    manifest.write_text("status,seed_url\n200,https://example.org/a\n", encoding="utf-8")
    with pytest.raises(ValueError):
        module._read_manifest_rows(manifest, limit_sources=0)


def test_repeat_run_with_only_new_skips_second_embedding(tmp_path, monkeypatch):
    module = _load_module()
    manifest = _make_manifest(tmp_path, _make_chunks(tmp_path))
    args = _args_for(manifest)
    args.dry_run = False
    args.skip_embeddings = False

    class _FakeEngine:
        dialect = SimpleNamespace(name="postgresql")

        def dispose(self):
            return None

    db_hashes: set[str] = set()
    embed_calls = 0

    def _fake_fetch_existing(engine, hashes):
        return {item for item in hashes if item in db_hashes}

    def _fake_embed(chunks, **kwargs):
        nonlocal embed_calls
        embed_calls += 1
        for item in chunks:
            item["embedding"] = "[0.1,0.2]"
        return chunks, 0

    def _fake_upsert(engine, chunks, **kwargs):
        db_hashes.update(str(item["chunk_hash"]) for item in chunks)
        return len(chunks)

    monkeypatch.setattr(module, "_ensure_rag_prerequisites", lambda url: _FakeEngine())
    monkeypatch.setattr(module, "_fetch_existing_hashes", _fake_fetch_existing)
    monkeypatch.setattr(module, "_embed_chunks", _fake_embed)
    monkeypatch.setattr(module, "_upsert_chunks", _fake_upsert)

    first_report, first_wrote = module.run(args)
    second_report, second_wrote = module.run(args)

    assert first_wrote is True
    assert first_report.inserted == 2
    assert second_wrote is False
    assert second_report.skipped >= 2
    assert embed_calls == 1
