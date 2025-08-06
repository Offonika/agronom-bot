"""introduce catalogs and protocols_current"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "9c0f0b84676a"
down_revision = "8fb09167f4a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "catalogs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("crop", sa.String(), nullable=False),
        sa.Column("disease", sa.String(), nullable=False),
    )
    op.create_table(
        "catalog_items",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("catalog_id", sa.Integer, sa.ForeignKey("catalogs.id"), nullable=False),
        sa.Column("product", sa.String(), nullable=False),
        sa.Column("dosage_value", sa.Numeric(), nullable=False),
        sa.Column("dosage_unit", sa.String(), nullable=False),
        sa.Column("phi", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.execute(
        """
        CREATE VIEW protocols_current AS
        SELECT ci.id AS id,
               c.crop AS crop,
               c.disease AS disease,
               ci.product AS product,
               ci.dosage_value AS dosage_value,
               ci.dosage_unit AS dosage_unit,
               ci.phi AS phi
        FROM catalog_items ci
        JOIN catalogs c ON c.id = ci.catalog_id
        WHERE ci.is_current
        """
    )
    op.drop_table("protocols")


def downgrade() -> None:
    op.create_table(
        "protocols",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("crop", sa.String(), nullable=False),
        sa.Column("disease", sa.String(), nullable=False),
        sa.Column("product", sa.String(), nullable=False),
        sa.Column("dosage_value", sa.Numeric(), nullable=False),
        sa.Column("dosage_unit", sa.String(), nullable=False),
        sa.Column("phi", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.execute("DROP VIEW IF EXISTS protocols_current")
    op.drop_table("catalog_items")
    op.drop_table("catalogs")
