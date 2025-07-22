from sqlalchemy import Column, Integer, String, Numeric
from app.models.base import Base


class Protocol(Base):
    __tablename__ = "protocols"

    id = Column(Integer, primary_key=True)
    crop = Column(String)
    disease = Column(String)
    product = Column(String)
    dosage_value = Column(Numeric)
    dosage_unit = Column(String)
    phi = Column(Integer)
