"""CSRF validation utilities."""
from __future__ import annotations

import hmac
from fastapi import Request, HTTPException

from app.dependencies import ErrorResponse
from app.models import ErrorCode


async def validate_csrf(request: Request, header_token: str | None) -> None:
    """Validate double-submit CSRF token via header and cookie."""
    cookie_token = request.cookies.get("csrf_token")
    if (
        header_token is None
        or cookie_token is None
        or not hmac.compare_digest(header_token, cookie_token)
    ):
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Invalid CSRF token"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())
