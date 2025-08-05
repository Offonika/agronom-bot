"""add error_code column to photos

Revision ID: 1f3d1a8bb6d5
Revises: 1b5e0e8c1a2e, 5ef33145d14c
Create Date: 2025-08-??

"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '1f3d1a8bb6d5'
down_revision = ('1b5e0e8c1a2e', '5ef33145d14c')
branch_labels = None
depends_on = None

ERROR_CODES = [
    'NO_LEAF',
    'LIMIT_EXCEEDED',
    'GPT_TIMEOUT',
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'UPGRADE_REQUIRED',
    'TOO_MANY_REQUESTS',
    'SERVICE_UNAVAILABLE',
    'FORBIDDEN',
]


def upgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == 'postgresql':
        for code in ERROR_CODES[5:]:
            op.execute(
                f"ALTER TYPE error_code ADD VALUE IF NOT EXISTS '{code}'"
            )
        enum_type = postgresql.ENUM(name='error_code', create_type=False)
    else:
        enum_type = sa.Enum(*ERROR_CODES, name='error_code')
    op.add_column('photos', sa.Column('error_code', enum_type, nullable=True))


def downgrade() -> None:
    op.drop_column('photos', 'error_code')
    # Enum values are left in place
