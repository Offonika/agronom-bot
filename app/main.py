from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import Settings
from app.dependencies import close_redis
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
    await close_redis()

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

# Protect /metrics when a token is configured.
if settings.metrics_token:
    @app.middleware("http")
    async def metrics_guard(request: Request, call_next):
        if request.url.path == "/metrics":
            token = request.headers.get("X-Metrics-Token")
            if not token:
                auth = request.headers.get("Authorization", "")
                if auth.lower().startswith("bearer "):
                    token = auth.split(" ", 1)[1].strip()
            if token != settings.metrics_token:
                return JSONResponse(status_code=401, content={"error": "unauthorized"})
        return await call_next(request)

# 👇 Добавляем метрики
Instrumentator().instrument(app).expose(app)
