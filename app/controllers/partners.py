import asyncio
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from app import db as db_module
from app.dependencies import ErrorResponse, require_api_headers, verify_hmac as verify_partner_hmac
from app.models import PartnerOrder

router = APIRouter(prefix="/partner")


class PartnerOrderRequest(BaseModel):
    order_id: str
    user_tg_id: int
    protocol_id: int
    price_kopeks: int
    signature: str


@router.post(
    "/orders",
    status_code=202,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def partner_orders(
    request: Request,
    _: None = Depends(require_api_headers),
    x_sign: str = Header(..., alias="X-Sign"),
):
    data, sign, provided_sign = await verify_partner_hmac(request, x_sign)
    try:
        body = PartnerOrderRequest(**data, signature=provided_sign)
    except ValidationError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            order = PartnerOrder(
                user_id=body.user_tg_id,
                order_id=body.order_id,
                protocol_id=body.protocol_id,
                price_kopeks=body.price_kopeks,
                signature=sign,
                status="new",
            )
            db.add(order)
            db.commit()

    await asyncio.to_thread(_db_call)
    return JSONResponse(status_code=202, content={"status": "queued"})
