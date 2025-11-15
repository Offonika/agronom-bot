"""add plan metadata columns

Revision ID: 20251113_add_plan_metadata
Revises: 0b29760ca9fa
Create Date: 2025-11-13 13:45:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision = "20251113_add_plan_metadata"
down_revision = "0b29760ca9fa"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect_name = getattr(bind.dialect, "name", "")
    if dialect_name != "postgresql":
        # Skip on SQLite and other dialects used in tests; table is created separately.
        return
    inspector = inspect(bind)
    if "plans" not in inspector.get_table_names():
        op.create_table(
            "plans",
            sa.Column("id", sa.BigInteger, primary_key=True),
            sa.Column("user_id", sa.BigInteger, nullable=False),
            sa.Column("object_id", sa.BigInteger, nullable=False),
            sa.Column("case_id", sa.BigInteger),
            sa.Column("title", sa.Text, nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("hash", sa.String(length=64)),
            sa.Column("source", sa.String(length=32)),
            sa.Column("payload", sa.JSON()),
            sa.Column("plan_kind", sa.String(length=32)),
            sa.Column("plan_errors", sa.JSON()),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.text("CURRENT_TIMESTAMP"),
                nullable=False,
            ),
        )
        return

    op.add_column(
        "plans",
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
    )
    op.add_column(
        "plans",
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column("plans", sa.Column("hash", sa.String(length=64), nullable=True))
    op.add_column("plans", sa.Column("source", sa.String(length=32), nullable=True))
    op.add_column("plans", sa.Column("payload", sa.JSON(), nullable=True))
    op.add_column("plans", sa.Column("plan_kind", sa.String(length=32), nullable=True))
    op.add_column("plans", sa.Column("plan_errors", sa.JSON(), nullable=True))

    # remove server defaults after data backfilled
    op.alter_column("plans", "status", server_default=None)
    op.alter_column("plans", "version", server_default=None)


def downgrade() -> None:
    op.drop_column("plans", "plan_errors")
    op.drop_column("plans", "plan_kind")
    op.drop_column("plans", "payload")
    op.drop_column("plans", "source")
    op.drop_column("plans", "hash")
    op.drop_column("plans", "version")
    op.drop_column("plans", "status")
