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
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = {c["name"] for c in inspector.get_columns("payments")}

    if conn.dialect.name == "sqlite":
        if "source" in cols:
            op.execute("UPDATE payments SET provider = source")
        with op.batch_alter_table("payments") as batch_op:
            if "provider" not in cols:
                batch_op.add_column(sa.Column("provider", sa.String))
            if "source" in cols:
                batch_op.drop_column("source")
            if "currency" not in cols:
                batch_op.add_column(sa.Column("currency", sa.String))
            if "updated_at" not in cols:
                batch_op.add_column(sa.Column("updated_at", sa.DateTime))
            if "external_id" not in cols:
                batch_op.add_column(sa.Column("external_id", sa.String))
            if "prolong_months" not in cols:
                batch_op.add_column(sa.Column("prolong_months", sa.Integer))
    else:
        if "provider" not in cols:
            op.add_column("payments", sa.Column("provider", sa.String))
        if "source" in cols:
            op.execute("UPDATE payments SET provider = source")
            op.drop_column("payments", "source")

        if "currency" not in cols:
            op.add_column("payments", sa.Column("currency", sa.String))
        if "updated_at" not in cols:
            op.add_column("payments", sa.Column("updated_at", sa.DateTime))
        if "external_id" not in cols:
            op.add_column("payments", sa.Column("external_id", sa.String))
        if "prolong_months" not in cols:
            op.add_column("payments", sa.Column("prolong_months", sa.Integer))

def downgrade() -> None:
    """Revert payments table changes."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = {c["name"] for c in inspector.get_columns("payments")}

    if conn.dialect.name == "sqlite":
        if "provider" in cols and "source" not in cols:
            op.execute("UPDATE payments SET source = provider")
        with op.batch_alter_table("payments") as batch_op:
            if "prolong_months" in cols:
                batch_op.drop_column("prolong_months")
            if "external_id" in cols:
                batch_op.drop_column("external_id")
            if "updated_at" in cols:
                batch_op.drop_column("updated_at")
            if "currency" in cols:
                batch_op.drop_column("currency")
            if "source" not in cols:
                batch_op.add_column(sa.Column("source", sa.String))
            if "provider" in cols:
                batch_op.drop_column("provider")
    else:
        if "prolong_months" in cols:
            op.drop_column("payments", "prolong_months")
        if "external_id" in cols:
            op.drop_column("payments", "external_id")
        if "updated_at" in cols:
            op.drop_column("payments", "updated_at")
        if "currency" in cols:
            op.drop_column("payments", "currency")

        if "source" not in cols:
            op.add_column("payments", sa.Column("source", sa.String))
        op.execute("UPDATE payments SET source = provider")
        if "provider" in cols:
            op.drop_column("payments", "provider")
