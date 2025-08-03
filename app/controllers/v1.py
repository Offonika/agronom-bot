from fastapi import APIRouter

from . import photos, payments, partners

router = APIRouter(prefix="/v1")
router.include_router(photos.router)
# payments router also exposes SBP Autopay endpoints
router.include_router(payments.router)
router.include_router(partners.router)
