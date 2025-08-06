import os
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

from app import dependencies

# Ensure tests run against SQLite when DATABASE_URL is not defined
os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/agronom_test.db")
os.environ.setdefault("OPENAI_API_KEY", "test")

from fastapi.testclient import TestClient
from app.main import app
from app.config import Settings
from app.db import init_db

@pytest.fixture(scope="session", autouse=True)
def apply_migrations():
    """Apply Alembic migrations before running tests."""
    cfg_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    config = Config(str(cfg_path))
    stdout_buf, stderr_buf = StringIO(), StringIO()
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            command.upgrade(config, "head")
    except Exception as exc:
        print("Alembic upgrade failed:", exc)
        print("stdout:\n", stdout_buf.getvalue())
        print("stderr:\n", stderr_buf.getvalue())
        raise
    init_db(Settings())


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

    fake = _Redis()
    monkeypatch.setattr(dependencies, "redis_client", fake)
    yield

