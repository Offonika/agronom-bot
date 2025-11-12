from __future__ import annotations

import logging
import os
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.models import Base

logger = logging.getLogger(__name__)


engine: Engine | None = None
_session_factory: sessionmaker | None = None


class _SessionWrapper:
    """Callable proxy returning sessions from the current factory."""

    def __call__(self, *args: Any, **kwargs: Any):
        if _session_factory is None:
            raise RuntimeError("Database not initialized")
        return _session_factory(*args, **kwargs)


SessionLocal = _SessionWrapper()


def init_db(cfg: Settings) -> None:
    """Create engine and session factory using SQLAlchemy's ``create_engine``."""
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

    _maybe_refresh_collation(engine)


def _maybe_refresh_collation(db_engine: Engine) -> None:
    flag = os.getenv("REFRESH_COLLATION_ON_START", "1").lower()
    if flag not in {"1", "true"}:
        return
    if db_engine.dialect.name != "postgresql":
        return
    db_name = db_engine.url.database
    if not db_name:
        return
    try:
        with db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(f'ALTER DATABASE "{db_name}" REFRESH COLLATION VERSION'))
    except Exception as exc:  # pragma: no cover - depends on privileges
        logger.warning("Collation refresh skipped: %s", exc)
