"""add pending payment status

Revision ID: 48faa6fea9c8
Revises: 1848f456e8dd
Create Date: 2025-07-27 06:13:06.999836

"""
from alembic import op



# revision identifiers, used by Alembic.
revision = '48faa6fea9c8'
down_revision = '1848f456e8dd'
branch_labels = None
depends_on = None

def upgrade() -> None:
    """Add 'pending' state to payment_status enum."""
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute("ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'pending'")

def downgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute(
            "DELETE FROM pg_enum WHERE enumlabel='pending' AND enumtypid = (SELECT oid FROM pg_type WHERE typname='payment_status')"
        )
