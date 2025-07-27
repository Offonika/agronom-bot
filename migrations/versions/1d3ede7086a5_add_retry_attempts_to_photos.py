"""add retry_attempts to photos

Revision ID: 1d3ede7086a5
Revises: f72b70304116
Create Date: 2025-07-27 13:08:00
"""

from alembic import op
import sqlalchemy as sa

revision = '1d3ede7086a5'
down_revision = 'f72b70304116'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add retry_attempts column."""
    op.add_column('photos', sa.Column('retry_attempts', sa.Integer, server_default='0', nullable=False))


def downgrade() -> None:
    """Drop retry_attempts column."""
    op.drop_column('photos', 'retry_attempts')
