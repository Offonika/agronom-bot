"""add paywall_reminders table

Revision ID: 20260205_add_paywall_reminders
Revises: 20260111_update_analytics_views
Create Date: 2026-02-05
"""

from alembic import op
import sqlalchemy as sa


revision = "20260205_add_paywall_reminders"
down_revision = "20260111_update_analytics_views"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "paywall_reminders",
        sa.Column("user_id", sa.BigInteger, primary_key=True),
        sa.Column("fire_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_paywall_reminders_fire_at",
        "paywall_reminders",
        ["fire_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_paywall_reminders_fire_at", table_name="paywall_reminders")
    op.drop_table("paywall_reminders")
