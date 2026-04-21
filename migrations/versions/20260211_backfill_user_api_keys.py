"""backfill user api_key for null rows

Revision ID: 20260211_backfill_user_api_keys
Revises: 20260205_add_paywall_reminders
Create Date: 2026-02-11 19:40:00.000000
"""

from __future__ import annotations

import secrets

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260211_backfill_user_api_keys"
down_revision = "20260205_add_paywall_reminders"
branch_labels = None
depends_on = None


def _generate_key() -> str:
    return secrets.token_hex(24)


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id FROM users WHERE api_key IS NULL")).fetchall()
    for row in rows:
        bind.execute(
            sa.text(
                "UPDATE users "
                "SET api_key = :api_key "
                "WHERE id = :uid AND api_key IS NULL"
            ),
            {"api_key": _generate_key(), "uid": row[0]},
        )


def downgrade() -> None:
    # Data backfill is intentionally irreversible.
    pass
