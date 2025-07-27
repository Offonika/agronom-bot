"""add retry attempts

Revision ID: 632d4e7bf880
Revises: f72b70304116
Create Date: 2025-07-27 15:28:41.128510

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = '632d4e7bf880'
down_revision = 'f72b70304116'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.add_column(
        "photos",
        sa.Column("retry_attempts", sa.Integer(), nullable=False, server_default="0"),
    )

def downgrade() -> None:
    op.drop_column("photos", "retry_attempts")
