"""add opt in to users

Revision ID: 5ef33145d14c
Revises: 9c0f0b84676a
Create Date: 2025-08-05 05:55:02.786205

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = "5ef33145d14c"
down_revision = "9c0f0b84676a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("opt_in", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("users", "opt_in")
