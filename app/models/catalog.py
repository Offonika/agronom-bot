from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import relationship

from app.models.base import Base


class Catalog(Base):
    __tablename__ = "catalogs"

    id = Column(Integer, primary_key=True)
    crop = Column(String, nullable=False)
    disease = Column(String, nullable=False)

    items = relationship("CatalogItem", back_populates="catalog", cascade="all, delete-orphan")
