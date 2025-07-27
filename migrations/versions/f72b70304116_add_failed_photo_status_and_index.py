"""add failed photo status and index

Revision ID: f72b70304116
Revises: 48faa6fea9c8
Create Date: 2025-07-27 10:07:49.392139

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = 'f72b70304116'
down_revision = '48faa6fea9c8'
branch_labels = None
depends_on = None

def upgrade() -> None:
    """Add 'failed' value to photo_status enum and index photos.status."""
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute(
            "ALTER TYPE photo_status ADD VALUE IF NOT EXISTS 'failed'"
        )
    op.create_index("ix_photos_status", "photos", ["status"], unique=False)

def downgrade() -> None:
    """Remove index and 'failed' value from photo_status enum."""
    op.drop_index("ix_photos_status", table_name="photos")
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute(
            "DELETE FROM pg_enum WHERE enumlabel='failed' AND enumtypid = "
            "(SELECT oid FROM pg_type WHERE typname='photo_status')"
        )

