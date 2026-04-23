# env.py
import os
import sys
from pathlib import Path

# Add project root to PYTHONPATH before importing app modules
sys.path.append(str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
from alembic import context
from sqlalchemy import create_engine, pool

# Load .env variables
load_dotenv()

from app.models import Base  # noqa: E402

target_metadata = Base.metadata

SKIP_PLAN_META = os.getenv("SKIP_PLAN_METADATA_MIGRATION", "0") == "1"
PLAN_META_REVISION = "20251113_add_plan_metadata"


def _process_revision_directives(context, revision, directives):
    print("process_revision_directives called, skip:", SKIP_PLAN_META)
    if not SKIP_PLAN_META:
        return
    filtered = []
    for directive in directives:
        if getattr(directive, "revision", None) == PLAN_META_REVISION:
            continue
        filtered.append(directive)
    directives[:] = filtered

# 3. URL из env
url = (
    os.getenv("DATABASE_URL")
    or os.getenv("DB_URL")
    or "sqlite:////tmp/agronom_test.db"
)

config = context.config
config.set_main_option("sqlalchemy.url", url)

def run_migrations_offline() -> None:
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
        process_revision_directives=_process_revision_directives,
    )
    with context.begin_transaction():
        context.run_migrations()

def run_migrations_online() -> None:
    connectable = create_engine(url, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
            process_revision_directives=_process_revision_directives,
        )
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
