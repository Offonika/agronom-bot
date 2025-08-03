import os
import subprocess
import pytest

from app import dependencies

# Ensure tests run against SQLite when DATABASE_URL is not defined
os.environ.setdefault("DATABASE_URL", "sqlite:///./app.db")

from fastapi.testclient import TestClient
from app.main import app
from app.config import Settings
from app.db import init_db

@pytest.fixture(scope="session", autouse=True)
def apply_migrations():
    """Apply Alembic migrations before running tests."""
    subprocess.run(["alembic", "upgrade", "head"], check=True)
    init_db(Settings())


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

