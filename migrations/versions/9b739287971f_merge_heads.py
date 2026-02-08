"""merge heads

Revision ID: 9b739287971f
Revises: 20260105_add_payment_idempotency, 2f3f2b9e0f35
Create Date: 2025-12-30 16:41:22.114195

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = '9b739287971f'
down_revision = ('20260105_add_payment_idempotency', '2f3f2b9e0f35')
branch_labels = None
depends_on = None

def upgrade() -> None:
    pass

def downgrade() -> None:
    pass
