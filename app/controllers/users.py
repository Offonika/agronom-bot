import asyncio
import hmac
import io
import json
import zipfile

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, compute_signature, rate_limit
from app.models import Event, Payment, Photo, User

settings = Settings()
HMAC_SECRET = settings.hmac_secret

router = APIRouter()


@router.get(
    "/users/{user_id}/export",
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)
async def export_user(
    user_id: int,
    x_sign: str = Header(..., alias="X-Sign"),
    auth_user: int = Depends(rate_limit),
):
    payload = {"user_id": user_id}
    expected_sign = compute_signature(HMAC_SECRET, payload)
    if not hmac.compare_digest(expected_sign, x_sign):
        err = ErrorResponse(code="UNAUTHORIZED", message="Invalid signature")
        raise HTTPException(status_code=401, detail=err.model_dump())
    if auth_user != user_id:
        err = ErrorResponse(code="FORBIDDEN", message="Cannot access other user")
        raise HTTPException(status_code=403, detail=err.model_dump())

    def _db_call() -> dict:
        with db_module.SessionLocal() as db:
            photos = db.query(Photo).filter_by(user_id=user_id).all()
            payments = db.query(Payment).filter_by(user_id=user_id).all()
            events = db.query(Event).filter_by(user_id=user_id).all()

            def serialize(items):
                return [
                    {k: v for k, v in vars(obj).items() if not k.startswith("_")}
                    for obj in items
                ]

            return {
                "photos": serialize(photos),
                "payments": serialize(payments),
                "events": serialize(events),
            }

    data = await asyncio.to_thread(_db_call)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("data.json", json.dumps(data, default=str))
    buffer.seek(0)

    headers = {
        "Content-Disposition": f'attachment; filename="user_{user_id}_export.zip"'
    }
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)


@router.post(
    "/dsr/delete_user",
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)
async def delete_user(
    request: Request,
    x_sign: str = Header(..., alias="X-Sign"),
    auth_user: int = Depends(rate_limit),
):
    try:
        payload = await request.json()
    except json.JSONDecodeError as err:
        err_resp = ErrorResponse(code="BAD_REQUEST", message="Invalid JSON")
        raise HTTPException(status_code=400, detail=err_resp.model_dump()) from err
    except Exception:  # noqa: BLE001
        raise

    user_id = payload.get("user_id")
    if user_id is None:
        err_resp = ErrorResponse(code="BAD_REQUEST", message="Missing user_id")
        raise HTTPException(status_code=400, detail=err_resp.model_dump())

    expected_sign = compute_signature(HMAC_SECRET, {"user_id": user_id})
    if not hmac.compare_digest(expected_sign, x_sign):
        err = ErrorResponse(code="UNAUTHORIZED", message="Invalid signature")
        raise HTTPException(status_code=401, detail=err.model_dump())

    if user_id != auth_user:
        err = ErrorResponse(code="FORBIDDEN", message="Cannot delete other user")
        raise HTTPException(status_code=403, detail=err.model_dump())

    def _db_delete() -> None:
        with db_module.SessionLocal() as db:
            db.query(Photo).filter_by(user_id=user_id).delete()
            db.query(Payment).filter_by(user_id=user_id).delete()
            db.query(Event).filter_by(user_id=user_id).delete()
            db.query(User).filter_by(id=user_id).delete()
            db.commit()

    await asyncio.to_thread(_db_delete)
    return {"status": "deleted"}
