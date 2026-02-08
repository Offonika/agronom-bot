"""add consent tables

Revision ID: 20251231_add_consents
Revises: 20251230_add_provider_payment_id
Create Date: 2025-12-31 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "20251231_add_consents"
down_revision = "20251230_add_provider_payment_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "consent_events",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("doc_type", sa.String(), nullable=False),
        sa.Column("doc_version", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("meta", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
    )
    op.create_index("ix_consent_events_user", "consent_events", ["user_id"])
    op.create_index("ix_consent_events_doc_type", "consent_events", ["doc_type"])
    op.create_index("ix_consent_events_occurred_at", "consent_events", ["occurred_at"])

    op.create_table(
        "user_consents",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("doc_type", sa.String(), primary_key=True),
        sa.Column("doc_version", sa.String(), nullable=False),
        sa.Column("status", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_user_consents_doc_type", "user_consents", ["doc_type"])


def downgrade() -> None:
    op.drop_index("ix_user_consents_doc_type", table_name="user_consents")
    op.drop_table("user_consents")

    op.drop_index("ix_consent_events_occurred_at", table_name="consent_events")
    op.drop_index("ix_consent_events_doc_type", table_name="consent_events")
    op.drop_index("ix_consent_events_user", table_name="consent_events")
    op.drop_table("consent_events")
