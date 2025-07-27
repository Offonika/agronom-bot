"""add failed photo status and index

Revision ID: b3077f721ed4
Revises: 48faa6fea9c8
Create Date: 2025-07-27 09:20:55.388403

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = 'b3077f721ed4'
down_revision = '48faa6fea9c8'
branch_labels = None
depends_on = None

def upgrade() -> None:
    """Add 'failed' state to photo_status enum and index on photos.status."""

    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute("ALTER TYPE photo_status ADD VALUE IF NOT EXISTS 'failed'")

    op.create_index("idx_photo_status", "photos", ["status"], unique=False)

def downgrade() -> None:
    conn = op.get_bind()
    op.drop_index("idx_photo_status", table_name="photos")

    if conn.dialect.name == "postgresql":
        op.execute(
            "DELETE FROM pg_enum WHERE enumlabel='failed' AND enumtypid = (SELECT oid FROM pg_type WHERE typname='photo_status')"
        )
