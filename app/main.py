from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import Settings
from app.db import init_db
from app.services.storage import init_storage, close_client
from app.logger import setup_logging
from app.controllers import v1

# 👇 Prometheus инструментатор
try:  # pragma: no cover - optional dependency for metrics
    from prometheus_fastapi_instrumentator import Instrumentator
except Exception:  # pragma: no cover
    class Instrumentator:  # type: ignore
        """Fallback instrumentator used when dependency is unavailable."""

        def instrument(self, _app, **_kwargs):
            return self

        def expose(self, _app, **_kwargs):
            return self

settings = Settings()
setup_logging()
logger = logging.getLogger(__name__)


async def _to_thread(func, *args, **kwargs):
    """Compatibility wrapper for asyncio.to_thread (Py < 3.9)."""
    if hasattr(asyncio, "to_thread"):
        return await asyncio.to_thread(func, *args, **kwargs)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: func(*args, **kwargs))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Only initialize storage and DB connections; catalog data is pre-loaded
    await init_storage(settings)
    await _to_thread(init_db, settings)
    yield
    await close_client()

if sys.version_info[:2] < (3, 11):
    if os.getenv("ALLOW_OLD_PYTHON", "0") != "1":
        raise RuntimeError("Python 3.11+ is required (run tests on 3.12)")
    logger.warning("Running on older Python %s.%s (recommended 3.12+)", *sys.version_info[:2])

app = FastAPI(
    title="Agronom Bot Internal API",
    version="1.10.0",
    lifespan=lifespan,
)

app.include_router(v1.router)

# 👇 Добавляем метрики
Instrumentator().instrument(app).expose(app)
