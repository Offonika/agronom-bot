"""add utm columns to analytics_events

Revision ID: 20260110_add_analytics_events_utm
Revises: 20260103_case_usage
Create Date: 2026-01-10 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260110_add_analytics_events_utm"
down_revision = "20260103_case_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("analytics_events", sa.Column("utm_source", sa.String(64), nullable=True))
    op.add_column("analytics_events", sa.Column("utm_medium", sa.String(64), nullable=True))
    op.add_column("analytics_events", sa.Column("utm_campaign", sa.String(128), nullable=True))


def downgrade() -> None:
    op.drop_column("analytics_events", "utm_campaign")
    op.drop_column("analytics_events", "utm_medium")
    op.drop_column("analytics_events", "utm_source")
