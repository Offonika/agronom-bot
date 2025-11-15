"""apply core plan schema from SQL script

Revision ID: 20251114_apply_core_plan_schema
Revises: 20251114_add_users_tg_unique
Create Date: 2025-11-14 13:10:00.000000
"""

from pathlib import Path

from alembic import op
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision = "20251114_apply_core_plan_schema"
down_revision = "20251114_add_users_tg_unique"
branch_labels = None
depends_on = None

SQL_FILE = Path(__file__).resolve().parents[2] / "db" / "migrations" / "2025-11-12_core.sql"


def _load_core_sql() -> str:
    if not SQL_FILE.exists():
        raise FileNotFoundError(f"Core SQL file not found: {SQL_FILE}")
    return SQL_FILE.read_text(encoding="utf-8")


def _drop_legacy_events(bind) -> None:
    inspector = inspect(bind)
    if "events" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("events")}
    # Old schema had only id, user_id, event, ts columns.
    if {"plan_id", "type", "status"}.issubset(columns):
        return
    bind.exec_driver_sql("DROP TABLE IF EXISTS events CASCADE")


def upgrade() -> None:
    bind = op.get_bind()
    if getattr(bind.dialect, "name", "") != "postgresql":
        # SQLite (tests) will use simplified tables created in fixtures.
        return
    _drop_legacy_events(bind)
    bind.exec_driver_sql(_load_core_sql())


def downgrade() -> None:
    # The legacy SQL script is idempotent and provisions many inter-dependent tables.
    # We intentionally keep downgrade empty to avoid dropping user data.
    pass
