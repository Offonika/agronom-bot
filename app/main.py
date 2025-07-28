from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import Settings
from app.db import init_db
from app.services.protocols import import_csv_to_db
from app.services.storage import init_storage
from app.logger import setup_logging
from app.controllers import v1

settings = Settings()
init_storage(settings)
setup_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db(settings)
    import_csv_to_db()
    yield


app = FastAPI(
    title="Agronom Bot Internal API",
    version="1.7.0",
    lifespan=lifespan,
)

app.include_router(v1.router)
