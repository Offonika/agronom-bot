"""add api_key to users

Revision ID: 20251229_add_user_api_key
Revises: 20251228_add_analytics_events
Create Date: 2025-12-29 10:00:00.000000
"""

from __future__ import annotations

import secrets

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251229_add_user_api_key"
down_revision = "20251228_add_analytics_events"
branch_labels = None
depends_on = None


def _generate_key() -> str:
    return secrets.token_hex(24)


def upgrade() -> None:
    op.add_column("users", sa.Column("api_key", sa.String(length=64)))

    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id FROM users WHERE api_key IS NULL")).fetchall()
    for row in rows:
        bind.execute(
            sa.text("UPDATE users SET api_key = :api_key WHERE id = :uid"),
            {"api_key": _generate_key(), "uid": row[0]},
        )


def downgrade() -> None:
    op.drop_column("users", "api_key")
