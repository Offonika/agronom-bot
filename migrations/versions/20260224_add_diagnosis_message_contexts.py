"""add diagnosis message contexts for persistent reply mapping

Revision ID: 20260224_add_diagnosis_message_contexts
Revises: 20260211_backfill_user_api_keys
Create Date: 2026-02-24 16:05:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260224_add_diagnosis_message_contexts"
down_revision = "20260211_backfill_user_api_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "diagnosis_message_contexts",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "diagnosis_id",
            sa.BigInteger(),
            sa.ForeignKey("recent_diagnoses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("message_id", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("NOW()"), nullable=False),
    )
    op.create_index(
        "ix_diagnosis_message_contexts_user_created",
        "diagnosis_message_contexts",
        ["user_id", "created_at"],
    )
    op.create_unique_constraint(
        "uq_diagnosis_message_contexts_chat_message",
        "diagnosis_message_contexts",
        ["chat_id", "message_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_diagnosis_message_contexts_chat_message",
        "diagnosis_message_contexts",
        type_="unique",
    )
    op.drop_index("ix_diagnosis_message_contexts_user_created", table_name="diagnosis_message_contexts")
    op.drop_table("diagnosis_message_contexts")

