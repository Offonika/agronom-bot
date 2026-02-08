"""add check constraints for object coordinates

Revision ID: 20251121_add_object_lat_lon_checks
Revises: ccb57d510742_expand_photos_user_id_to_bigint
Create Date: 2025-11-21 12:00:00.000000

"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "20251121_add_object_lat_lon_checks"
down_revision = "ccb57d510742"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_check_constraint(
        "objects_lat_range",
        "objects",
        "(NOT (meta ? 'lat') OR ((meta->>'lat')::numeric BETWEEN -90 AND 90))",
    )
    op.create_check_constraint(
        "objects_lon_range",
        "objects",
        "(NOT (meta ? 'lon') OR ((meta->>'lon')::numeric BETWEEN -180 AND 180))",
    )


def downgrade() -> None:
    op.drop_constraint("objects_lat_range", "objects", type_="check")
    op.drop_constraint("objects_lon_range", "objects", type_="check")
