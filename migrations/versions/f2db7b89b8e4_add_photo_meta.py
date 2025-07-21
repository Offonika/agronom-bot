"""add photo metadata columns

Revision ID: f2db7b89b8e4
Revises: b41be693ec24
Create Date: 2025-07-21 00:00:00
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'f2db7b89b8e4'
down_revision = 'b41be693ec24'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('photos', sa.Column('file_unique_id', sa.Text))
    op.add_column('photos', sa.Column('width', sa.Integer))
    op.add_column('photos', sa.Column('height', sa.Integer))
    op.add_column('photos', sa.Column('file_size', sa.Integer))


def downgrade() -> None:
    op.drop_column('photos', 'file_size')
    op.drop_column('photos', 'height')
    op.drop_column('photos', 'width')
    op.drop_column('photos', 'file_unique_id')

