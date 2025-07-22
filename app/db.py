import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

# Optionally create tables automatically when DB_CREATE_ALL is set
if os.getenv("DB_CREATE_ALL"):
    Base.metadata.create_all(engine)
