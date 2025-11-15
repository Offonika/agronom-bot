"""add recent_diagnoses table to store latest diagnosis payloads

Revision ID: 20251115_add_recent_diagnoses
Revises: 20251114_apply_core_plan_schema
Create Date: 2025-11-15 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251115_add_recent_diagnoses"
down_revision = "20251114_apply_core_plan_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recent_diagnoses",
        sa.Column("id", sa.BigInteger(), primary_key=True),
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
            "case_id",
            sa.BigInteger(),
            sa.ForeignKey("cases.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "plan_id",
            sa.BigInteger(),
            sa.ForeignKey("plans.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("diagnosis_payload", sa.JSON(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "idx_recent_diagnoses_user_created",
        "recent_diagnoses",
        ["user_id", "created_at"],
    )
    op.create_index(
        "idx_recent_diagnoses_expires",
        "recent_diagnoses",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_recent_diagnoses_expires",
        table_name="recent_diagnoses",
    )
    op.drop_index(
        "idx_recent_diagnoses_user_created",
        table_name="recent_diagnoses",
    )
    op.drop_table("recent_diagnoses")
