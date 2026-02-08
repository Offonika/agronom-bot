"""add case_usage table and trial_ends_at

Revision ID: 20260103_case_usage
Revises: c7d3a10d7a2f
Create Date: 2026-01-03

Marketing plan requirements:
- Case-based limits (1 case/week) instead of photo-based (5 photos/month)
- 24h trial period for new users
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = '20260103_case_usage'
down_revision = 'c7d3a10d7a2f'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add case_usage table and trial_ends_at column."""

    # Create case_usage table for week-based case tracking
    op.create_table(
        "case_usage",
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("week", sa.String(length=8), nullable=False),  # YYYY-Www (ISO week)
        sa.Column("cases_used", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_case_id", sa.BigInteger, nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("user_id", "week"),
    )
    op.create_index(
        "ix_case_usage_user_id", "case_usage", ["user_id"], unique=False
    )

    # Add trial_ends_at to users for 24h trial period
    bind = op.get_bind()
    inspector = inspect(bind)
    existing_cols = [c.get("name") for c in inspector.get_columns("users")]

    if "trial_ends_at" not in existing_cols:
        op.add_column(
            "users",
            sa.Column("trial_ends_at", sa.DateTime(timezone=True), nullable=True)
        )

    # Add utm_source for tracking acquisition
    if "utm_source" not in existing_cols:
        op.add_column(
            "users",
            sa.Column("utm_source", sa.String(64), nullable=True)
        )

    if "utm_medium" not in existing_cols:
        op.add_column(
            "users",
            sa.Column("utm_medium", sa.String(64), nullable=True)
        )

    if "utm_campaign" not in existing_cols:
        op.add_column(
            "users",
            sa.Column("utm_campaign", sa.String(128), nullable=True)
        )


def downgrade() -> None:
    """Drop case_usage table and new columns."""

    op.drop_index("ix_case_usage_user_id", table_name="case_usage")
    op.drop_table("case_usage")

    bind = op.get_bind()
    inspector = inspect(bind)
    existing_cols = [c.get("name") for c in inspector.get_columns("users")]

    for col in ["trial_ends_at", "utm_source", "utm_medium", "utm_campaign"]:
        if col in existing_cols:
            op.drop_column("users", col)


