from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Iterable
import json

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from sqlalchemy import text as sa_text


@dataclass
class PlanOption:
    title: str
    dose: str | None = None
    method: str | None = None
    phi_days: int | None = None
    notes: str | None = None
    selected: bool = False


@dataclass
class PlanStage:
    title: str
    note: str | None = None
    kind: str | None = None
    phi_days: int | None = None
    options: list[PlanOption] = field(default_factory=list)


@dataclass
class PlanPdfData:
    plan_id: int
    title: str
    status: str
    version: int | None
    created_at: str | None
    object_name: str | None
    stages: list[PlanStage] = field(default_factory=list)


FONT_FAMILY_REGULAR = "DejaVuSans"
FONT_FAMILY_BOLD = "DejaVuSans-Bold"
_FONTS_REGISTERED = False


def _register_fonts() -> None:
    global _FONTS_REGISTERED
    if _FONTS_REGISTERED:
        return
    fonts_dir = Path(__file__).resolve().parents[1] / "assets" / "fonts"
    regular = fonts_dir / "DejaVuSans.ttf"
    bold = fonts_dir / "DejaVuSans-Bold.ttf"
    if regular.exists():
        pdfmetrics.registerFont(TTFont(FONT_FAMILY_REGULAR, str(regular)))
    if bold.exists():
        pdfmetrics.registerFont(TTFont(FONT_FAMILY_BOLD, str(bold)))
    _FONTS_REGISTERED = True


def _resolve_font(name: str, fallback: str) -> str:
    try:
        pdfmetrics.getFont(name)
        return name
    except Exception:
        return fallback


def fetch_plan_pdf_data(session, plan_id: int, user_id: int) -> PlanPdfData | None:
    plan_row = session.execute(
        sa_text(
            """
            SELECT p.id, p.title, p.status, p.version, p.created_at, o.name AS object_name
            FROM plans p
            LEFT JOIN objects o ON o.id = p.object_id
            WHERE p.id = :pid AND p.user_id = :uid
            """
        ),
        {"pid": plan_id, "uid": user_id},
    ).mappings().first()
    if not plan_row:
        return None
    stage_rows = session.execute(
        sa_text(
            """
            SELECT ps.id AS stage_id,
                   ps.title AS stage_title,
                   ps.note AS stage_note,
                   ps.kind AS stage_kind,
                   ps.phi_days AS stage_phi_days,
                   so.id AS option_id,
                   so.product AS option_product,
           so.ai AS option_ai,
           so.dose_value AS option_dose_value,
           so.dose_unit AS option_dose_unit,
           so.method AS option_method,
           so.meta AS option_meta,
           so.is_selected AS option_selected
            FROM plan_stages ps
            LEFT JOIN stage_options so ON so.stage_id = ps.id
            WHERE ps.plan_id = :pid
            ORDER BY ps.id ASC, so.id ASC
            """
        ),
        {"pid": plan_id},
    ).mappings().all()
    stages = _build_stage_list(stage_rows)
    created_at = plan_row["created_at"]
    created_text = created_at.astimezone().strftime("%d.%m.%Y %H:%M") if created_at else None
    return PlanPdfData(
        plan_id=plan_row["id"],
        title=plan_row["title"] or f"План #{plan_row['id']}",
        status=plan_row["status"] or "",
        version=plan_row["version"],
        created_at=created_text,
        object_name=plan_row["object_name"],
        stages=stages,
    )


def build_plan_pdf_bytes(plan: PlanPdfData) -> bytes:
    _register_fonts()
    regular_font = _resolve_font(FONT_FAMILY_REGULAR, "Helvetica")
    bold_font = _resolve_font(FONT_FAMILY_BOLD, "Helvetica-Bold")

    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    page_width, page_height = A4
    margin_x = 40
    margin_y = 40
    y = page_height - margin_y

    y = _draw_paragraph(
        pdf,
        f"План обработки #{plan.plan_id}",
        margin_x,
        y,
        page_width - margin_x * 2,
        bold_font,
        16,
        20,
        page_height,
        margin_y,
    )
    y -= 6
    summary_lines = [
        f"Название: {plan.title}",
        f"Статус: {plan.status}",
    ]
    if plan.object_name:
        summary_lines.insert(1, f"Объект: {plan.object_name}")
    if plan.version is not None:
        summary_lines.append(f"Версия: {plan.version}")
    if plan.created_at:
        summary_lines.append(f"Создан: {plan.created_at}")
    for line in summary_lines:
        y = _draw_paragraph(
            pdf,
            line,
            margin_x,
            y,
            page_width - margin_x * 2,
            regular_font,
            11,
            14,
            page_height,
            margin_y,
        )
    y -= 10

    for idx, stage in enumerate(plan.stages, start=1):
        y = _draw_paragraph(
            pdf,
            f"{idx}. {stage.title}",
            margin_x,
            y,
            page_width - margin_x * 2,
            bold_font,
            12,
            16,
            page_height,
            margin_y,
        )
        if stage.note:
            y = _draw_paragraph(
                pdf,
                stage.note,
                margin_x + 12,
                y,
                page_width - margin_x * 2 - 12,
                regular_font,
                10,
                14,
                page_height,
                margin_y,
            )
        if stage.phi_days:
            y = _draw_paragraph(
                pdf,
                f"PHI: {stage.phi_days} дн.",
                margin_x + 12,
                y,
                page_width - margin_x * 2 - 12,
                regular_font,
                10,
                14,
                page_height,
                margin_y,
            )
        options = _pick_options(stage.options)
        for opt in options:
            label = f"- {opt.title}"
            y = _draw_paragraph(
                pdf,
                label,
                margin_x + 12,
                y,
                page_width - margin_x * 2 - 12,
                regular_font,
                10,
                14,
                page_height,
                margin_y,
            )
            if opt.dose:
                y = _draw_paragraph(
                    pdf,
                    f"  Доза: {opt.dose}",
                    margin_x + 24,
                    y,
                    page_width - margin_x * 2 - 24,
                    regular_font,
                    9,
                    12,
                    page_height,
                    margin_y,
                )
            if opt.method:
                y = _draw_paragraph(
                    pdf,
                    f"  Способ: {opt.method}",
                    margin_x + 24,
                    y,
                    page_width - margin_x * 2 - 24,
                    regular_font,
                    9,
                    12,
                    page_height,
                    margin_y,
                )
            if opt.phi_days is not None:
                y = _draw_paragraph(
                    pdf,
                    f"  PHI: {opt.phi_days} дн.",
                    margin_x + 24,
                    y,
                    page_width - margin_x * 2 - 24,
                    regular_font,
                    9,
                    12,
                    page_height,
                    margin_y,
                )
            if opt.notes:
                y = _draw_paragraph(
                    pdf,
                    f"  {opt.notes}",
                    margin_x + 24,
                    y,
                    page_width - margin_x * 2 - 24,
                    regular_font,
                    9,
                    12,
                    page_height,
                    margin_y,
                )
        y -= 6

    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _build_stage_list(rows) -> list[PlanStage]:
    stages: list[PlanStage] = []
    stage_map: dict[int, PlanStage] = {}
    for row in rows:
        stage_id = row["stage_id"]
        stage = stage_map.get(stage_id)
        if stage is None:
            stage = PlanStage(
                title=row["stage_title"] or "Этап",
                note=row["stage_note"],
                kind=row["stage_kind"],
                phi_days=row["stage_phi_days"],
            )
            stage_map[stage_id] = stage
            stages.append(stage)
        option_id = row["option_id"]
        if option_id is None:
            continue
        meta = row.get("option_meta")
        meta_dict = {}
        if isinstance(meta, str):
            try:
                meta_dict = json.loads(meta)
            except json.JSONDecodeError:
                meta_dict = {}
        elif isinstance(meta, dict):
            meta_dict = meta
        phi_days = _coerce_int(meta_dict.get("phi_days"))
        if phi_days is None:
            phi_days = row.get("stage_phi_days")
        notes = meta_dict.get("notes") or meta_dict.get("note")
        title = row["option_product"] or row["option_ai"] or "Вариант"
        dose = None
        if row["option_dose_value"] is not None or row["option_dose_unit"]:
            val = row["option_dose_value"] if row["option_dose_value"] is not None else ""
            unit = row["option_dose_unit"] or ""
            dose = f"{val} {unit}".strip()
        option = PlanOption(
            title=title,
            dose=dose,
            method=row["option_method"],
            phi_days=phi_days,
            notes=notes,
            selected=bool(row["option_selected"]),
        )
        stage.options.append(option)
    return stages


def _coerce_int(value) -> int | None:
    try:
        if value is None:
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _pick_options(options: list[PlanOption]) -> Iterable[PlanOption]:
    selected = [opt for opt in options if opt.selected]
    if selected:
        return selected
    return options[:3]


def _wrap_text(text: str, font_name: str, font_size: int, max_width: float) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        width = pdfmetrics.stringWidth(candidate, font_name, font_size)
        if width <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def _draw_paragraph(
    pdf,
    text: str,
    x: float,
    y: float,
    max_width: float,
    font_name: str,
    font_size: int,
    leading: int,
    page_height: float,
    margin_y: float,
) -> float:
    pdf.setFont(font_name, font_size)
    lines = _wrap_text(text, font_name, font_size, max_width)
    for line in lines:
        if y < margin_y:
            pdf.showPage()
            pdf.setFont(font_name, font_size)
            y = page_height - margin_y
        pdf.drawString(x, y, line)
        y -= leading
    return y
