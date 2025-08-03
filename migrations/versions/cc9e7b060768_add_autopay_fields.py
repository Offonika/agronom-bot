"""add autopay fields

Revision ID: cc9e7b060768
Revises: d6342bc83ba4
Create Date: 2025-08-03 15:48:24.464090

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = 'cc9e7b060768'
down_revision = 'd6342bc83ba4'
branch_labels = None
depends_on = None

def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = {c["name"] for c in inspector.get_columns("payments")}
    with op.batch_alter_table("payments") as batch_op:
        if "autopay" not in cols:
            batch_op.add_column(sa.Column("autopay", sa.Boolean(), server_default=sa.text("0")))
        if "autopay_binding_id" not in cols:
            batch_op.add_column(sa.Column("autopay_binding_id", sa.String()))

def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = {c["name"] for c in inspector.get_columns("payments")}
    with op.batch_alter_table("payments") as batch_op:
        if "autopay_binding_id" in cols:
            batch_op.drop_column("autopay_binding_id")
        if "autopay" in cols:
            batch_op.drop_column("autopay")
