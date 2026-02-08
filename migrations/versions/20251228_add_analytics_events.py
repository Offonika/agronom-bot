"""add analytics_events table

Revision ID: 20251228_add_analytics_events
Revises: 20251123_add_beta_feedback_tables
Create Date: 2025-12-28 18:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251228_add_analytics_events"
down_revision = "20251123_add_beta_feedback_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "analytics_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("event", sa.String(), nullable=False),
        sa.Column("ts", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_analytics_events_user", "analytics_events", ["user_id"])
    op.create_index("ix_analytics_events_event", "analytics_events", ["event"])


def downgrade() -> None:
    op.drop_index("ix_analytics_events_event", table_name="analytics_events")
    op.drop_index("ix_analytics_events_user", table_name="analytics_events")
    op.drop_table("analytics_events")
