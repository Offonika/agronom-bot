"""add unique constraint for users.tg_id

Revision ID: 20251114_add_users_tg_unique
Revises: 20251113_add_plan_metadata
Create Date: 2025-11-14 12:00:00.000000
"""

from alembic import op
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision = "20251114_add_users_tg_unique"
down_revision = "20251113_add_plan_metadata"
branch_labels = None
depends_on = None


def _has_constraint(inspector, table, constraint_name):
    if table not in inspector.get_table_names():
        return False
    uniques = {uc["name"] for uc in inspector.get_unique_constraints(table)}
    indexes = {idx["name"] for idx in inspector.get_indexes(table)}
    return constraint_name in uniques or constraint_name in indexes


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    constraint_name = "users_tg_id_key"
    if not _has_constraint(inspector, "users", constraint_name):
        op.create_unique_constraint(constraint_name, "users", ["tg_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    constraint_name = "users_tg_id_key"
    if _has_constraint(inspector, "users", constraint_name):
        op.drop_constraint(constraint_name, "users", type_="unique")
