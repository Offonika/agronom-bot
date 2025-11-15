"""Import or update product catalog rules from CSV/JSON files."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
from pathlib import Path
from typing import Any, Iterable

from dotenv import load_dotenv
from sqlalchemy import JSON, Column, Float, Integer, MetaData, String, Table, and_, create_engine, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.sql import Insert

logger = logging.getLogger("import_catalog")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

metadata = MetaData()

products_table = Table(
    "products",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("product", String, nullable=False),
    Column("ai", String),
    Column("form", String),
    Column("constraints", JSON),
)

product_rules_table = Table(
    "product_rules",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("crop", String, nullable=False),
    Column("disease", String, nullable=False),
    Column("region", String),
    Column("product_id", Integer, nullable=False),
    Column("dose_value", Float),
    Column("dose_unit", String),
    Column("phi_days", Integer),
    Column("safety", JSON),
    Column("meta", JSON),
)

REQUIRED_FIELDS = ("product_name", "crop", "disease")


def load_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(path)
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open("r", encoding="utf-8") as fp:
            reader = csv.DictReader(fp)
            return [dict(row) for row in reader]
    if suffix in {".json", ".ndjson"}:
        with path.open("r", encoding="utf-8") as fp:
            data = json.load(fp)
            if isinstance(data, list):
                return data
            raise ValueError("JSON catalog must be an array of entries")
    raise ValueError(f"Unsupported catalog format for file {path}")


def normalize_entry(raw: dict[str, Any]) -> dict[str, Any]:
    lowered = {str(key).lower(): value for key, value in raw.items()}

    def get(name: str) -> Any:
        return lowered.get(name.lower())

    def clean(value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            trimmed = value.strip()
            return trimmed or None
        if isinstance(value, (int, float)):
            return str(value)
        return None

    def to_float(value: Any) -> float | None:
        try:
            if value is None or value == "":
                return None
            return float(str(value).replace(",", "."))
        except (TypeError, ValueError):
            return None

    def to_int(value: Any) -> int | None:
        try:
            if value is None or value == "":
                return None
            return int(float(value))
        except (TypeError, ValueError):
            return None

    def to_bool(value: Any) -> bool | None:
        if value is None or value == "":
            return None
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in {"1", "true", "yes", "y"}:
            return True
        if text in {"0", "false", "no", "n"}:
            return False
        return None

    combined_notes: list[str] = []
    for key in ("notes", "comment", "comments"):
        val = clean(get(key))
        if val:
            combined_notes.append(val)

    entry = {
        "product_name": clean(get("product_name") or get("product")),
        "product_code": clean(get("product_code") or get("code")),
        "ai": clean(get("ai") or get("active_ingredient")),
        "form": clean(get("form") or get("form_factor")),
        "usage_class": clean(get("usage_class")),
        "crop": clean(get("crop")),
        "disease": clean(get("disease")),
        "region": clean(get("region")),
        "dose_value": to_float(get("dose_value")),
        "dose_unit": clean(get("dose_unit")),
        "phi_days": to_int(get("phi_days") or get("phi")),
        "safe_phase": clean(get("safe_phase")),
        "notes": "; ".join(combined_notes) if combined_notes else None,
        "priority": to_int(get("priority")),
        "is_allowed": to_bool(get("is_allowed")),
    }
    combined_dose = clean(get("dose"))
    if entry["dose_value"] is None and combined_dose:
        parts = combined_dose.split()
        try:
            entry["dose_value"] = float(parts[0].replace(",", "."))
            entry["dose_unit"] = " ".join(parts[1:]).strip() or entry["dose_unit"]
        except (ValueError, IndexError):
            entry["dose_unit"] = combined_dose
    return entry


def sync_catalog(entries: Iterable[dict[str, Any]], engine: Engine) -> dict[str, int]:
    stats = {
        "products_inserted": 0,
        "products_updated": 0,
        "rules_inserted": 0,
        "rules_updated": 0,
        "skipped": 0,
    }
    with engine.begin() as conn:
        for entry in entries:
            if not all(entry.get(field) for field in REQUIRED_FIELDS):
                stats["skipped"] += 1
                logger.warning("Skipping entry without mandatory fields: %s", entry)
                continue
            product_id, product_action = _upsert_product(conn, entry)
            if product_action == "inserted":
                stats["products_inserted"] += 1
            elif product_action == "updated":
                stats["products_updated"] += 1
            rule_action = _upsert_rule(conn, product_id, entry)
            if rule_action == "inserted":
                stats["rules_inserted"] += 1
            elif rule_action == "updated":
                stats["rules_updated"] += 1
    return stats


def _upsert_product(conn: Connection, entry: dict[str, Any]) -> tuple[int, str]:
    product_name = entry["product_name"]
    stmt = select(products_table.c.id, products_table.c.ai, products_table.c.form, products_table.c.constraints).where(
        products_table.c.product == product_name
    )
    row = conn.execute(stmt).first()

    constraints: dict[str, Any] = {}
    if entry.get("usage_class"):
        constraints["usage_class"] = entry["usage_class"]
    if entry.get("product_code"):
        constraints["code"] = entry["product_code"]

    if row:
        updates: dict[str, Any] = {}
        if row.ai != entry.get("ai"):
            updates["ai"] = entry.get("ai")
        if row.form != entry.get("form"):
            updates["form"] = entry.get("form")
        if constraints and row.constraints != constraints:
            updates["constraints"] = constraints
        if updates:
            conn.execute(
                products_table.update()
                .where(products_table.c.id == row.id)
                .values(**updates)
            )
            action = "updated"
        else:
            action = "noop"
        return row.id, action

    insert_stmt: Insert = products_table.insert().values(
        product=product_name,
        ai=entry.get("ai"),
        form=entry.get("form"),
        constraints=constraints or None,
    )
    result = conn.execute(insert_stmt)
    product_id = int(result.inserted_primary_key[0])
    return product_id, "inserted"


def _upsert_rule(conn: Connection, product_id: int, entry: dict[str, Any]) -> str:
    region = entry.get("region")
    conditions = [
        product_rules_table.c.crop == entry["crop"],
        product_rules_table.c.disease == entry["disease"],
        product_rules_table.c.product_id == product_id,
    ]
    if region:
        conditions.append(product_rules_table.c.region == region)
    else:
        conditions.append(product_rules_table.c.region.is_(None))
    stmt = select(product_rules_table.c.id).where(and_(*conditions))
    row = conn.execute(stmt).first()

    safety = {}
    if entry.get("safe_phase"):
        safety["safe_phase"] = entry["safe_phase"]
    meta = {}
    if entry.get("notes"):
        meta["notes"] = entry["notes"]
    if entry.get("priority") is not None:
        meta["priority"] = entry["priority"]
    if entry.get("is_allowed") is not None:
        meta["is_allowed"] = entry["is_allowed"]
    if entry.get("product_code"):
        meta["product_code"] = entry["product_code"]

    values = {
        "crop": entry["crop"],
        "disease": entry["disease"],
        "region": region,
        "product_id": product_id,
        "dose_value": entry.get("dose_value"),
        "dose_unit": entry.get("dose_unit"),
        "phi_days": entry.get("phi_days"),
        "safety": safety or None,
        "meta": meta or None,
    }

    if row:
        conn.execute(
            product_rules_table.update().where(product_rules_table.c.id == row.id).values(**values)
        )
        return "updated"

    conn.execute(product_rules_table.insert().values(**values))
    return "inserted"


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Import product rules into the database")
    parser.add_argument("path", type=Path, help="Path to CSV or JSON file with catalog data")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"), help="Override DATABASE_URL env value")
    args = parser.parse_args()

    if not args.database_url:
        parser.error("DATABASE_URL is not set. Use --database-url or export the variable.")

    raw_rows = load_rows(args.path)
    entries = [normalize_entry(row) for row in raw_rows]
    engine = create_engine(args.database_url)
    stats = sync_catalog(entries, engine)
    logger.info(
        "Import complete: %s (file=%s)",
        stats,
        args.path,
    )


if __name__ == "__main__":
    main()
