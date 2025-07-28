"""add photos ts desc index

Revision ID: 83d28733f0ba
Revises: f72b70304116
Create Date: 2025-07-27 16:51:16.746157

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = '83d28733f0ba'
down_revision = 'f72b70304116'
branch_labels = None
depends_on = None

def upgrade() -> None:
    """Create index on photos.user_id and ts DESC."""

    op.create_index(
        "photos_user_ts_idx", "photos", ["user_id", sa.text("ts DESC")]
    )

def downgrade() -> None:
    """Drop photos_user_ts_idx index."""

    op.drop_index("photos_user_ts_idx", table_name="photos")
