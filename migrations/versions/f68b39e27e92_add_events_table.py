"""add events table

Revision ID: f68b39e27e92
Revises: 799a9ae59498
Create Date: 2025-07-26 18:44:12.508280
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'f68b39e27e92'
down_revision = '799a9ae59498'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create events table."""
    op.create_table(
        'events',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('user_id', sa.Integer, nullable=False),
        sa.Column('event', sa.String, nullable=False),
        sa.Column('ts', sa.DateTime, server_default=sa.func.now()),
    )


def downgrade() -> None:
    """Drop events table."""
    op.drop_table('events')
