from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import Settings
from app.db import init_db
from app.services.protocols import import_csv_to_db
from app.services.storage import init_storage, close_client
from app.logger import setup_logging
from app.controllers import v1

# 👇 Prometheus инструментатор
from prometheus_fastapi_instrumentator import Instrumentator

settings = Settings()
setup_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_storage(settings)
    init_db(settings)
    import_csv_to_db()
    yield
    await close_client()


app = FastAPI(
    title="Agronom Bot Internal API",
    version="1.7.1",
    lifespan=lifespan,
)

app.include_router(v1.router)

# 👇 Добавляем метрики
Instrumentator().instrument(app).expose(app)
