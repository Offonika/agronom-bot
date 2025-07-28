import os
import subprocess
import pytest

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

