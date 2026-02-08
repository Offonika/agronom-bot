from __future__ import annotations
import os
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite:////tmp/agronom_test.db"
os.environ.setdefault("OPENAI_API_KEY", "test")
os.environ["SKIP_PLAN_METADATA_MIGRATION"] = "1"
os.environ.setdefault("HMAC_SECRET", "test-hmac-secret")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret")
os.environ.setdefault("HMAC_SECRET_PARTNER", "test-hmac-partner")
os.environ.setdefault("API_KEY", "test-api-key")
os.environ.setdefault("TINKOFF_IPS", '["127.0.0.1","testclient"]')
os.environ.setdefault("PARTNER_IPS", '["127.0.0.1","testclient"]')
os.environ.setdefault("TRUSTED_PROXIES", '["127.0.0.1","testclient"]')

import pytest
from alembic import command
from alembic.config import Config

from app import dependencies, db as db_module
from app.models import Base

# Ensure tests always run against SQLite regardless of host env
from fastapi.testclient import TestClient
from app.main import app
from app.config import Settings
from app.db import init_db
from sqlalchemy import text as sa_text
from app.dependencies import compute_signature

@pytest.fixture(scope="session", autouse=True)
def apply_migrations():
    """Apply Alembic migrations before running tests."""
    cfg_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    config = Config(str(cfg_path))
    db_url = os.environ["DATABASE_URL"]
    stdout_buf, stderr_buf = StringIO(), StringIO()
    if db_url.startswith("sqlite:///"):
        from sqlalchemy import create_engine

        engine = create_engine(db_url)
        Base.metadata.create_all(engine)
    else:
        try:
            with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
                command.upgrade(config, "head")
        except Exception as exc:
            print("Alembic upgrade failed:", exc)
            print("stdout:\n", stdout_buf.getvalue())
            print("stderr:\n", stderr_buf.getvalue())
            raise
    init_db(Settings())
    _ensure_plan_tables()


@pytest.fixture(scope="session", autouse=True)
def remove_test_db():
    """Remove temporary SQLite database after tests finish."""
    yield
    db_url = os.environ.get("DATABASE_URL")
    if db_url and db_url.startswith("sqlite:///"):
        db_path = Path(db_url.replace("sqlite:///", ""))
        if db_path.exists():
            db_path.unlink()


@pytest.fixture(scope="module")
def client(apply_migrations):
    """Yields a TestClient with lifespan events."""
    with TestClient(app) as client:
        original_request = client.request

        def signed_request(method, url, *args, **kwargs):
            headers = dict(kwargs.pop("headers", {}) or {})
            if "X-API-Key" in headers and "X-API-Ver" in headers and "X-User-ID" in headers:
                user_id = int(headers["X-User-ID"])
                api_key = headers["X-API-Key"]
                with db_module.SessionLocal() as session:
                    session.execute(
                        sa_text(
                            "INSERT OR IGNORE INTO users (id, tg_id, api_key, created_at) "
                            "VALUES (:uid, :tg, :api_key, CURRENT_TIMESTAMP)"
                        ),
                        {"uid": user_id, "tg": user_id, "api_key": api_key},
                    )
                    session.execute(
                        sa_text(
                            "UPDATE users SET api_key = :api_key "
                            "WHERE id = :uid AND (api_key IS NULL OR api_key = '')"
                        ),
                        {"uid": user_id, "api_key": api_key},
                    )
                    session.commit()
            if (
                "X-API-Key" in headers
                and "X-API-Ver" in headers
                and "X-User-ID" in headers
                and "X-Req-Sign" not in headers
            ):
                from urllib.parse import urlparse
                import json
                import time
                import uuid
                import hashlib

                parsed = urlparse(url)
                path = parsed.path or url
                query = parsed.query or ""
                ts = int(time.time())
                nonce = uuid.uuid4().hex
                payload = {
                    "user_id": int(headers["X-User-ID"]),
                    "ts": ts,
                    "nonce": nonce,
                    "method": method.upper(),
                    "path": path,
                    "query": query,
                }
                if "json" in kwargs and kwargs["json"] is not None:
                    canonical = json.dumps(
                        kwargs["json"],
                        separators=(",", ":"),
                        sort_keys=True,
                        ensure_ascii=False,
                    ).encode()
                    body_hash = hashlib.sha256(canonical).hexdigest()
                    headers["X-Req-Body-Sha256"] = body_hash
                    payload["body_sha256"] = body_hash
                headers["X-Req-Ts"] = str(ts)
                headers["X-Req-Nonce"] = nonce
                headers["X-Req-Sign"] = compute_signature(headers["X-API-Key"], payload)
            kwargs["headers"] = headers
            return original_request(method, url, *args, **kwargs)

        client.request = signed_request
        yield client


@pytest.fixture(autouse=True)
def mock_redis(monkeypatch):
    class _Pipe:
        def __init__(self, store):
            self.store = store
            self.ops = []

        def incr(self, key):
            self.ops.append(("incr", key))
            return self

        def expire(self, key, ttl):
            self.ops.append(("expire", key, ttl))
            return self

        async def execute(self):
            results = []
            for op in self.ops:
                if op[0] == "incr":
                    key = op[1]
                    self.store[key] = self.store.get(key, 0) + 1
                    results.append(self.store[key])
                else:
                    results.append(True)
            self.ops.clear()
            return results

    class _Redis:
        def __init__(self):
            self.store = {}

        def pipeline(self):
            return _Pipe(self.store)

        async def setex(self, key: str, _ttl: int, value):
            self.store[key] = value
            return True

        async def set(self, key: str, value, ex: int | None = None, nx: bool = False):
            if nx and key in self.store:
                return None
            self.store[key] = value
            return True

        async def get(self, key: str):
            return self.store.get(key)

        async def delete(self, key: str):
            return 1 if self.store.pop(key, None) is not None else 0

    fake = _Redis()
    monkeypatch.setattr(dependencies, "redis_client", fake)
    # Поддерживаем ассистента и другие сервисы, которые импортируют redis_client напрямую.
    try:
        import app.services.assistant as assistant_service

        monkeypatch.setattr(assistant_service, "redis_client", fake)
    except Exception:
        pass
    yield


def _ensure_plan_tables():
    if db_module.engine is None:
        return
    engine = db_module.engine
    if engine.dialect.name != "sqlite":
        return
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url.startswith("sqlite:///"):
        return
    db_path = Path(db_url.replace("sqlite:///", ""))
    _bootstrap_plan_table(db_path)

def _bootstrap_plan_table(db_path: Path) -> None:
    import sqlite3

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        _ensure_events_table(conn)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plans (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                object_id INTEGER NOT NULL,
                case_id INTEGER,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                version INTEGER NOT NULL DEFAULT 1,
                hash TEXT,
                source TEXT,
                payload TEXT,
                plan_kind TEXT,
                plan_errors TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        statements = [
            """
            CREATE TABLE IF NOT EXISTS objects (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                type TEXT,
                location_tag TEXT,
                meta TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS cases (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                object_id INTEGER,
                crop TEXT,
                disease TEXT,
                confidence REAL,
                raw_ai TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS plan_stages (
                id INTEGER PRIMARY KEY,
                plan_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                kind TEXT NOT NULL,
                note TEXT,
                phi_days INTEGER,
                meta TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS stage_options (
                id INTEGER PRIMARY KEY,
                stage_id INTEGER NOT NULL,
                product TEXT NOT NULL,
                ai TEXT,
                dose_value REAL,
                dose_unit TEXT,
                method TEXT,
                meta TEXT,
                is_selected BOOLEAN NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                event_id INTEGER NOT NULL,
                fire_at TEXT NOT NULL,
                sent_at TEXT,
                channel TEXT DEFAULT 'telegram',
                status TEXT NOT NULL DEFAULT 'pending',
                payload TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS autoplan_runs (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                plan_id INTEGER NOT NULL,
                stage_id INTEGER NOT NULL,
                stage_option_id INTEGER,
                status TEXT NOT NULL DEFAULT 'pending',
                min_hours_ahead INTEGER NOT NULL DEFAULT 2,
                horizon_hours INTEGER NOT NULL DEFAULT 72,
                reason TEXT,
                error TEXT,
                weather_context TEXT,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS treatment_slots (
                id INTEGER PRIMARY KEY,
                autoplan_run_id INTEGER,
                plan_id INTEGER NOT NULL,
                stage_id INTEGER NOT NULL,
                stage_option_id INTEGER,
                slot_start TEXT NOT NULL,
                slot_end TEXT NOT NULL,
                score REAL,
                reason TEXT,
                status TEXT NOT NULL DEFAULT 'proposed',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS assistant_proposals (
                id INTEGER PRIMARY KEY,
                proposal_id TEXT NOT NULL UNIQUE,
                user_id INTEGER NOT NULL,
                object_id INTEGER,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                plan_id INTEGER,
                event_ids TEXT NOT NULL DEFAULT '[]',
                reminder_ids TEXT NOT NULL DEFAULT '[]',
                error_code TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                confirmed_at TEXT
            )
            """,
        ]
        for stmt in statements:
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def _ensure_events_table(conn) -> None:
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    )
    exists = cursor.fetchone() is not None
    required = {
        "plan_id",
        "stage_id",
        "stage_option_id",
        "autoplan_run_id",
        "type",
        "due_at",
        "slot_end",
        "status",
        "completed_at",
        "reason",
        "source",
        "created_at",
        "event",
        "ts",
    }
    if exists:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
        if required.issubset(columns):
            return
        conn.execute("DROP TABLE IF EXISTS events")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            event TEXT,
            ts TEXT DEFAULT CURRENT_TIMESTAMP,
            plan_id INTEGER,
            stage_id INTEGER,
            stage_option_id INTEGER,
            autoplan_run_id INTEGER,
            type TEXT,
            due_at TEXT,
            slot_end TEXT,
            status TEXT DEFAULT 'scheduled',
            completed_at TEXT,
            reason TEXT,
            source TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
