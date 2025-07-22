import subprocess
import pytest

@pytest.fixture(scope="session", autouse=True)
def apply_migrations():
    """Apply Alembic migrations before running tests."""
    subprocess.run(["alembic", "upgrade", "head"], check=True)

