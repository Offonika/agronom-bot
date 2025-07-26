"""init schema

Revision ID: b41be693ec24
Revises: 
Create Date: 2025-07-20 21:56:49.376862

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql



# revision identifiers, used by Alembic.
revision = 'b41be693ec24'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:

    # Enums
    payment_status = postgresql.ENUM('success', 'fail', 'cancel', 'bank_error', name='payment_status')
    photo_status = postgresql.ENUM('pending', 'ok', 'retrying', name='photo_status')
    order_status = postgresql.ENUM('new', 'processed', 'cancelled', name='order_status')
    error_code = postgresql.ENUM('NO_LEAF', 'LIMIT_EXCEEDED', 'GPT_TIMEOUT', 'BAD_REQUEST', 'UNAUTHORIZED', name='error_code')

    payment_status.create(op.get_bind(), checkfirst=True)
    photo_status.create(op.get_bind(), checkfirst=True)
    order_status.create(op.get_bind(), checkfirst=True)
    error_code.create(op.get_bind(), checkfirst=True)

    op.create_table(
        'users',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('tg_id', sa.BigInteger, nullable=False),
        sa.Column('pro_expires_at', sa.DateTime),
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        'photos',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('user_id', sa.Integer, nullable=False),
        sa.Column('file_id', sa.Text, nullable=False),
        sa.Column('crop', sa.Text),
        sa.Column('disease', sa.Text),
        sa.Column('confidence', sa.Numeric),
        sa.Column('status', photo_status, nullable=False, server_default='pending'),
        sa.Column('ts', sa.DateTime, server_default=sa.func.now()),
        sa.Column('deleted', sa.Boolean, server_default='false'),
    )

    op.create_table(
        'protocols',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('crop', sa.Text),
        sa.Column('disease', sa.Text),
        sa.Column('product', sa.Text),
        sa.Column('dosage_value', sa.Numeric),
        sa.Column('dosage_unit', sa.Text),
        sa.Column('phi', sa.Integer),
    )

    op.create_table(
        'payments',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('user_id', sa.Integer, nullable=False),
        sa.Column('amount', sa.Integer),
        sa.Column('source', sa.Text),
        sa.Column('status', payment_status, nullable=False),
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        'partner_orders',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('user_id', sa.Integer, nullable=False),
        sa.Column('order_id', sa.Text),
        sa.Column('protocol_id', sa.Integer),
        sa.Column('price_kopeks', sa.Integer),
        sa.Column('signature', sa.Text),
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
        sa.Column('status', order_status, nullable=False, server_default='new'),
    )

    op.create_table(
        'photo_quota',
        sa.Column('user_id', sa.Integer, primary_key=True),
        sa.Column('used_count', sa.Integer),
        sa.Column('month_year', sa.String(length=7)),
    )

def downgrade() -> None:
    op.drop_table('photo_quota')
    op.drop_table('partner_orders')
    op.drop_table('payments')
    op.drop_table('protocols')
    op.drop_table('photos')
    op.drop_table('users')

    op.execute('DROP TYPE IF EXISTS error_code')
    op.execute('DROP TYPE IF EXISTS order_status')
    op.execute('DROP TYPE IF EXISTS photo_status')
    op.execute('DROP TYPE IF EXISTS payment_status')

