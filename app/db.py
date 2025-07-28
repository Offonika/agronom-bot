import os
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from app.models import Base
from app.config import Settings


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

# Engine and session factory are created lazily via ``init_db``.
engine: Engine | None = None
SessionLocal: sessionmaker | None = None


def init_db(cfg: Settings) -> None:
    """Create engine and session factory using provided settings."""
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

