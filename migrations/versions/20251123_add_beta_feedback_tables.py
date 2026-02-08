"""add beta flags and feedback tables

Revision ID: 20251123_add_beta_feedback_tables
Revises: 20251203_add_assistant_proposals
Create Date: 2025-11-23 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251123_add_beta_feedback_tables"
down_revision = "20251203_add_assistant_proposals"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS is_beta BOOLEAN NOT NULL DEFAULT FALSE"
    )
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS beta_onboarded_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS beta_survey_completed_at TIMESTAMPTZ"
    )
    op.execute("ALTER TABLE users ALTER COLUMN is_beta DROP DEFAULT")

    op.create_table(
        "diagnosis_feedback",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "user_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "case_id",
            sa.BigInteger(),
            sa.ForeignKey("cases.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("q1_confidence_score", sa.Integer(), nullable=False),
        sa.Column("q2_clarity_score", sa.Integer()),
        sa.Column("q3_comment", sa.Text()),
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
            nullable=False,
        ),
    )
    op.create_index(
        "idx_diagnosis_feedback_user_case",
        "diagnosis_feedback",
        ["user_id", "case_id"],
    )

    op.create_table(
        "followup_feedback",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "user_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "case_id",
            sa.BigInteger(),
            sa.ForeignKey("cases.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("due_at", sa.DateTime(timezone=True)),
        sa.Column("retry_at", sa.DateTime(timezone=True)),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("answered_at", sa.DateTime(timezone=True)),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("action_choice", sa.String()),
        sa.Column("result_choice", sa.String()),
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
            nullable=False,
        ),
    )
    op.create_index(
        "idx_followup_feedback_status_due",
        "followup_feedback",
        ["status", "due_at", "retry_at", "attempts"],
    )

    op.create_table(
        "beta_events",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "user_id",
            sa.BigInteger(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column(
            "payload",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::json"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "idx_beta_events_type_created",
        "beta_events",
        ["event_type", "created_at"],
    )
    op.create_index("idx_beta_events_user", "beta_events", ["user_id"])


def downgrade() -> None:
    op.drop_index("idx_beta_events_user", table_name="beta_events")
    op.drop_index("idx_beta_events_type_created", table_name="beta_events")
    op.drop_table("beta_events")

    op.drop_index("idx_followup_feedback_status_due", table_name="followup_feedback")
    op.drop_table("followup_feedback")

    op.drop_index("idx_diagnosis_feedback_user_case", table_name="diagnosis_feedback")
    op.drop_table("diagnosis_feedback")

    op.drop_column("users", "beta_survey_completed_at")
    op.drop_column("users", "beta_onboarded_at")
    op.drop_column("users", "is_beta")
