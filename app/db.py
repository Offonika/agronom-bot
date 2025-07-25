import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base
from app.config import Settings


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")
engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    future=True,
)


def init_db(cfg: Settings) -> None:
    """Configure engine and session factory using provided settings."""
    global engine, SessionLocal

    engine = create_engine(cfg.database_url, future=True)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        future=True,
    )

    if cfg.db_create_all:
        Base.metadata.create_all(engine)


# Optionally create tables automatically when DB_CREATE_ALL is set
if os.getenv("DB_CREATE_ALL"):
    Base.metadata.create_all(engine)
