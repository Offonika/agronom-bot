"""Normalization helpers for machine-readable treatment plans."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any

PLAN_KINDS = {"PLAN_NEW", "PLAN_UPDATE", "QNA", "FAQ"}
MAX_STAGES = 5
MAX_OPTIONS_PER_STAGE = 3


class PlanPayloadError(ValueError):
    """Raised when the machine plan payload is missing required fields."""


@dataclass
class PlanOption:
    product_code: str | None
    product_name: str
    ai: str | None
    dose_value: float | None
    dose_unit: str | None
    method: str | None
    phi_days: int | None
    notes: str | None
    needs_review: bool = False


@dataclass
class PlanStage:
    name: str
    trigger: str | None
    notes: str | None
    options: list[PlanOption] = field(default_factory=list)


@dataclass
class PlanDocument:
    kind: str
    object_hint: str | None
    diagnosis: dict[str, Any] | None
    stages: list[PlanStage]


@dataclass
class PlanNormalizationResult:
    plan: PlanDocument
    plan_hash: str
    data: dict[str, Any]
    errors: list[str]


def normalize_plan_payload(payload: dict[str, Any]) -> PlanNormalizationResult:
    """Validate and normalize the plan payload returned by the model."""

    if not isinstance(payload, dict):
        raise PlanPayloadError("plan_payload must be an object")

    raw_kind = str(payload.get("kind") or "PLAN_NEW").upper()
    kind = raw_kind if raw_kind in PLAN_KINDS else "PLAN_NEW"

    raw_object_hint = _clean_str(payload.get("object_hint"))
    diagnosis = _normalize_diagnosis(payload.get("diagnosis"))

    raw_stages = payload.get("stages")
    if not isinstance(raw_stages, list) or not raw_stages:
        raise PlanPayloadError("plan_payload.stages must contain at least one stage")

    normalized_stages: list[PlanStage] = []
    errors: list[str] = []
    for index, raw_stage in enumerate(raw_stages[:MAX_STAGES]):
        stage = _normalize_stage(raw_stage, index)
        if not stage.options:
            errors.append(f"Stage '{stage.name}' has no valid options")
            continue
        normalized_stages.append(stage)

    if not normalized_stages:
        raise PlanPayloadError("no valid stages with options in plan_payload")

    # Canonical ordering: first explicit "order"/"idx" if provided, then name.
    normalized_stages.sort(key=lambda s: s.name.lower())

    plan = PlanDocument(
        kind=kind,
        object_hint=raw_object_hint,
        diagnosis=diagnosis,
        stages=normalized_stages,
    )

    plan_dict = asdict(plan)
    plan_hash = _hash_plan(plan_dict)
    return PlanNormalizationResult(
        plan=plan,
        plan_hash=plan_hash,
        data=plan_dict,
        errors=errors,
    )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _normalize_diagnosis(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    result: dict[str, Any] = {}
    for key in ("crop", "disease", "confidence"):
        if key in raw:
            value = raw[key]
            if isinstance(value, (str, float, int)):
                result[key] = value
    return result or None


def _normalize_stage(raw_stage: Any, index: int) -> PlanStage:
    if not isinstance(raw_stage, dict):
        raise PlanPayloadError(f"stage #{index + 1} must be an object")
    name = _clean_str(raw_stage.get("name")) or f"Этап #{index + 1}"
    trigger = _clean_str(raw_stage.get("trigger"))
    notes = _clean_str(raw_stage.get("notes"))
    raw_options = raw_stage.get("options")

    normalized_options: list[PlanOption] = []
    if isinstance(raw_options, list):
        for opt in raw_options:
            option = _normalize_option(opt)
            if option:
                normalized_options.append(option)
            if len(normalized_options) >= MAX_OPTIONS_PER_STAGE:
                break

    return PlanStage(name=name, trigger=trigger, notes=notes, options=normalized_options)


def _normalize_option(raw_option: Any) -> PlanOption | None:
    if not isinstance(raw_option, dict):
        return None
    product_name = _clean_str(
        raw_option.get("product_name") or raw_option.get("product")
    )
    if not product_name:
        return None

    product_code = _clean_str(raw_option.get("product_code"))
    ai = _clean_str(raw_option.get("ai") or raw_option.get("active_ingredient"))
    method = _clean_str(raw_option.get("method"))
    notes = _clean_str(raw_option.get("notes"))

    dose_value, dose_unit = _extract_dose(
        raw_option.get("dose_value"),
        raw_option.get("dose_unit"),
        raw_option.get("dose"),
    )
    phi_days = _to_int(raw_option.get("phi_days"))
    needs_review = bool(raw_option.get("needs_review")) or not product_code

    return PlanOption(
        product_code=product_code,
        product_name=product_name,
        ai=ai,
        dose_value=dose_value,
        dose_unit=dose_unit,
        method=method,
        phi_days=phi_days,
        notes=notes,
        needs_review=needs_review,
    )


def _extract_dose(value: Any, unit: Any, combined: Any) -> tuple[float | None, str | None]:
    dose_value = _to_float(value)
    dose_unit = _clean_str(unit)

    if dose_value is not None:
        return dose_value, dose_unit

    combined_text = _clean_str(combined)
    if not combined_text:
        return None, dose_unit

    parts = combined_text.split()
    try:
        numeric = float(parts[0].replace(",", "."))
        remainder = " ".join(parts[1:]) if len(parts) > 1 else dose_unit
        return numeric, remainder or dose_unit
    except (ValueError, IndexError):
        return None, combined_text if not dose_unit else dose_unit


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _hash_plan(plan_dict: dict[str, Any]) -> str:
    canonical = json.dumps(plan_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()
