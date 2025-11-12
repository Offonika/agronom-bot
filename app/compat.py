from __future__ import annotations

import asyncio
from typing import Any, Callable


if not hasattr(asyncio, "to_thread"):
    async def _to_thread(func: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: func(*args, **kwargs))

    asyncio.to_thread = _to_thread  # type: ignore[attr-defined]
