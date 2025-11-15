"""add plan_sessions table for plan wizard state

Revision ID: 20251115_add_plan_sessions
Revises: 20251115_add_recent_diagnoses
Create Date: 2025-11-15 10:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251115_add_plan_sessions"
down_revision = "20251115_add_recent_diagnoses"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plan_sessions",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "user_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "recent_diagnosis_id",
            sa.BigInteger(),
            sa.ForeignKey("recent_diagnoses.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "diagnosis_payload",
            sa.JSON(),
            nullable=False,
        ),
        sa.Column(
            "token",
            sa.String(length=72),
            nullable=False,
            unique=True,
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
        sa.Column(
            "current_step",
            sa.String(length=64),
            nullable=False,
            server_default="choose_object",
        ),
        sa.Column(
            "state",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "idx_plan_sessions_user_created",
        "plan_sessions",
        ["user_id", "created_at"],
    )
    op.create_index(
        "idx_plan_sessions_expires",
        "plan_sessions",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_plan_sessions_expires", table_name="plan_sessions")
    op.drop_index("idx_plan_sessions_user_created", table_name="plan_sessions")
    op.drop_table("plan_sessions")
