"""add roi column to photos

Revision ID: 1b5e0e8c1a2e
Revises: 9c0f0b84676a
Create Date: 2025-08-?? now
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "1b5e0e8c1a2e"
down_revision = "9c0f0b84676a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("photos", sa.Column("roi", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("photos", "roi")

