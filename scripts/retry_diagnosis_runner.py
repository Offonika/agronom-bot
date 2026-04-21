from __future__ import annotations

import argparse
import asyncio
import logging
import os

from app.config import Settings
from app.db import init_db
from app.services.retry_diagnosis import run_retry_cycle
from app.services.storage import close_client, init_storage

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value >= minimum else default


async def _run_loop(*, batch_size: int, retry_limit: int, interval_seconds: int, once: bool) -> None:
    while True:
        await run_retry_cycle(batch_size=batch_size, retry_limit=retry_limit)
        if once:
            return
        await asyncio.sleep(interval_seconds)


async def _amain(args: argparse.Namespace) -> None:
    cfg = Settings()
    init_db(cfg)
    await init_storage(cfg)
    try:
        await _run_loop(
            batch_size=args.batch_size,
            retry_limit=args.retry_limit,
            interval_seconds=args.interval,
            once=args.once,
        )
    finally:
        await close_client()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Retry pending photo diagnoses")
    parser.add_argument(
        "--once",
        action="store_true",
        help="run one retry cycle and exit",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=_env_int("RETRY_RUN_INTERVAL_SECONDS", 60),
        help="delay between cycles in seconds",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=_env_int("RETRY_BATCH_SIZE", 20),
        help="max number of pending photos per cycle",
    )
    parser.add_argument(
        "--retry-limit",
        type=int,
        default=_env_int("RETRY_LIMIT", 3),
        help="max retry attempts before failed status",
    )
    return parser


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    args = _build_parser().parse_args()
    logger.info(
        "retry_diagnosis_runner.start once=%s interval=%ss batch_size=%s retry_limit=%s",
        args.once,
        args.interval,
        args.batch_size,
        args.retry_limit,
    )
    asyncio.run(_amain(args))


if __name__ == "__main__":
    main()

