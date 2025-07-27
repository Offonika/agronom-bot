"""update payments table

Revision ID: 1848f456e8dd
Revises: f68b39e27e92
Create Date: 2025-07-27 05:34:15.363485

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = '1848f456e8dd'
down_revision = 'f68b39e27e92'
branch_labels = None
depends_on = None

def upgrade() -> None:
    """Add new fields to payments table and rename source to provider."""
    op.add_column("payments", sa.Column("provider", sa.String))
    op.execute("UPDATE payments SET provider = source")
    op.drop_column("payments", "source")

    op.add_column("payments", sa.Column("currency", sa.String))
    op.add_column("payments", sa.Column("updated_at", sa.DateTime))
    op.add_column("payments", sa.Column("external_id", sa.String))
    op.add_column("payments", sa.Column("prolong_months", sa.Integer))

def downgrade() -> None:
    """Revert payments table changes."""
    op.drop_column("payments", "prolong_months")
    op.drop_column("payments", "external_id")
    op.drop_column("payments", "updated_at")
    op.drop_column("payments", "currency")

    op.add_column("payments", sa.Column("source", sa.String))
    op.execute("UPDATE payments SET source = provider")
    op.drop_column("payments", "provider")
