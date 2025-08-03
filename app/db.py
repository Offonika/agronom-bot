from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.models import Base

# Engine and session factory are created lazily via ``init_db``.
engine: Engine | None = None
_session_factory: sessionmaker | None = None


class _SessionWrapper:
    """Callable proxy returning sessions from the current factory."""

    def __call__(self, *args, **kwargs):
        if _session_factory is None:
            raise RuntimeError("Database not initialized")
        return _session_factory(*args, **kwargs)


SessionLocal = _SessionWrapper()


def init_db(cfg: Settings) -> None:
    """Create engine and session factory using provided settings."""
    global engine, _session_factory

    engine = create_engine(
        cfg.database_url,
        future=True,
        pool_size=50,
        max_overflow=0,
        pool_recycle=30,
        pool_pre_ping=True,
    )
    _session_factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        future=True,
    )

    if cfg.db_create_all:
        Base.metadata.create_all(engine)

