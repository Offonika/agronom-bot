"""drop photo_quota table

Revision ID: 8fb09167f4a9
Revises: 59e3b0f60693
Create Date: 2025-08-03 16:58:28.110714

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = '8fb09167f4a9'
down_revision = '59e3b0f60693'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS photo_quota")


def downgrade() -> None:
    op.create_table(
        "photo_quota",
        sa.Column("user_id", sa.Integer, primary_key=True),
        sa.Column("used_count", sa.Integer),
        sa.Column("month_year", sa.String(length=7)),
    )
