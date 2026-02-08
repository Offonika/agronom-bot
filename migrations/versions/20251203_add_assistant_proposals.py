"""add assistant_proposals audit table

Revision ID: 20251203_add_assistant_proposals
Revises: 20251121_add_object_lat_lon_checks
Create Date: 2025-12-03 15:45:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251203_add_assistant_proposals"
down_revision = "20251121_add_object_lat_lon_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "assistant_proposals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("proposal_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("object_id", sa.BigInteger(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("plan_id", sa.Integer(), nullable=True),
        sa.Column("event_ids", sa.JSON(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("reminder_ids", sa.JSON(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_unique_constraint("uq_assistant_proposals_pid", "assistant_proposals", ["proposal_id"])
    op.create_index("ix_assistant_proposals_user_id", "assistant_proposals", ["user_id"])
    op.create_index("ix_assistant_proposals_status", "assistant_proposals", ["status"])


def downgrade() -> None:
    op.drop_index("ix_assistant_proposals_status", table_name="assistant_proposals")
    op.drop_index("ix_assistant_proposals_user_id", table_name="assistant_proposals")
    op.drop_constraint("uq_assistant_proposals_pid", "assistant_proposals", type_="unique")
    op.drop_table("assistant_proposals")
