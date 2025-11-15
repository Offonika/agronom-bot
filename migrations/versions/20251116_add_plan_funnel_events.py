"""add plan_funnel_events table for UX analytics

Revision ID: 20251116_add_plan_funnel_events
Revises: 20251115_add_plan_sessions
Create Date: 2025-11-16 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251116_add_plan_funnel_events"
down_revision = "20251115_add_plan_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plan_funnel_events",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "event",
            sa.String(length=64),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "object_id",
            sa.BigInteger(),
            sa.ForeignKey("objects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "plan_id",
            sa.BigInteger(),
            sa.ForeignKey("plans.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("data", sa.JSON(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "idx_plan_funnel_event_created",
        "plan_funnel_events",
        ["event", "created_at"],
    )
    op.create_index(
        "idx_plan_funnel_plan",
        "plan_funnel_events",
        ["plan_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_plan_funnel_plan", table_name="plan_funnel_events")
    op.drop_index("idx_plan_funnel_event_created", table_name="plan_funnel_events")
    op.drop_table("plan_funnel_events")

