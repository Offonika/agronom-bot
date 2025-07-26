# env.py
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from alembic import context
from sqlalchemy import create_engine, pool

# 1. .env
load_dotenv()

# 2. PYTHONPATH до импорта app
sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.models import Base  # noqa: E402

target_metadata = Base.metadata

# 3. URL из env
url = (
    os.getenv("DATABASE_URL")
    or os.getenv("DB_URL")
    or "sqlite:///./test.db"
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
        )
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
