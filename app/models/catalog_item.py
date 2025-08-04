from sqlalchemy import Column, Integer, String, Numeric, Boolean, ForeignKey
from sqlalchemy.orm import relationship

from app.models.base import Base


class CatalogItem(Base):
    __tablename__ = "catalog_items"

    id = Column(Integer, primary_key=True)
    catalog_id = Column(Integer, ForeignKey("catalogs.id"), nullable=False)
    product = Column(String, nullable=False)
    dosage_value = Column(Numeric, nullable=False)
    dosage_unit = Column(String, nullable=False)
    phi = Column(Integer, nullable=False, default=0)
    is_current = Column(Boolean, nullable=False, default=True)

    catalog = relationship("Catalog", back_populates="items")
