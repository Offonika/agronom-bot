# Tools for importing plant protection protocols (Агроном).
#
# Downloads the latest catalog ZIP from mcx.gov.ru, extracts PDF(s),
# picks the most "protocol-like" PDF, parses ONLY protocol tables
# (Crop/Target/Rate/PHI) and inserts normalized rows into DB.
#
# Версия с анти-OOM ограничителями, облегчёнными стратегиями для больших PDF,
# минимальными дампами и выбором нужного PDF из нескольких в архиве.

from __future__ import annotations

import argparse
import logging
import tempfile
import zipfile
from datetime import datetime, date
from pathlib import Path
from typing import Iterable, Tuple, Optional, Dict, List
from urllib.parse import urljoin
import re
import sys
import json
from collections import Counter

import requests
from bs4 import BeautifulSoup
from sqlalchemy import text

# --- bootstrap for direct execution from app/services ---
if __name__ == "__main__" and __package__ is None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "app.services"
# --- end bootstrap ---

from app import db
from app.models.catalog import Catalog
from app.models.catalog_item import CatalogItem
from app.config import Settings
from app.db import init_db
import pandas as pd

# ===== Meta =====
__VERSION__ = "protocol_importer/2025-08-28-r10"

cfg = Settings()
init_db(cfg)

# Ensure console logs are visible even if root has no handlers
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

EXPECTED_PROTOCOL_COLUMNS = [
    "crop",
    "disease",
    "product",
    "dosage_value",
    "dosage_unit",
    "phi",
]

# ===== Runtime limits / anti-OOM switches =====
MAX_PAGES_DEFAULT = 120        # обрабатываем только первые N страниц
STOP_AFTER_ROWS   = 2000       # останавливаемся, как только набрано столько строк
DEBUG_DUMP_PAGES  = 10         # дампим ТОЛЬКО текст первых N страниц (без tables.json)

# Для очень больших PDF (категория pesticide) используем ещё более щадящие настройки
LIGHT_MAX_PAGES   = 80
LIGHT_STOP_ROWS   = 1200


def pdf_to_csv(pdf_path: Path, csv_path: Path, *, pages: str = "all", flavor: str = "lattice") -> Path:
    """Extract protocol tables from PDF and dump to CSV with normalized headers."""
    try:
        import camelot
    except Exception as exc:  # pragma: no cover - depends on optional dep
        raise RuntimeError("camelot dependency is required for pdf_to_csv") from exc

    tables = camelot.read_pdf(
        str(pdf_path),
        pages=pages,
        flavor=flavor,
        strip_text="\n",
    )
    if not tables:
        raise ValueError("protocol PDF does not contain tables")

    frames = []
    for table in tables:
        df = getattr(table, "df", None)
        if df is None or df.empty:
            continue
        if df.shape[1] != len(EXPECTED_PROTOCOL_COLUMNS):
            raise ValueError(
                f"protocol table has {df.shape[1]} columns, expected {len(EXPECTED_PROTOCOL_COLUMNS)}"
            )
        frames.append(df)

    if not frames:
        raise ValueError("protocol PDF does not contain compatible tables")

    combined = pd.concat(frames, ignore_index=True)
    combined.columns = EXPECTED_PROTOCOL_COLUMNS
    combined.to_csv(csv_path, index=False)
    return csv_path

# ===== Heuristics: PDF scoring tokens =====
# Положительные маркеры "протокольных" регламентов
PROTOCOL_POSITIVE_TOKENS = [
    "регламент", "норма примен", "нормы примен", "норма расход",
    "расход препарата", "расход рабочей жидкости", "расход рабочего раствора",
    "доза", "срок ожидания", "культура", "вредный объект",
    "кратность обработок", "рабочего раствора", "таблица",
]
# Частые единицы измерения
UNIT_TOKENS = ["л/га", "кг/га", "мл/л", "г/л", "мл/10 л", "г/10 л", "мл/10л", "г/10л"]

# Негативные маркеры (для скоринга можно учитывать и «ОГРН», но для СКИПА страниц — нет!)
REGISTRY_NEGATIVE_TOKENS = [
    "реестр", "государственной регистрации", "госреестр",
    "номер государственной регистрации", "свидетельство",
    "дата выдачи", "срок действия регистрации", "дата окончания срока",
    "огрн", "огрнип", "регистрации пестицидов", "агрохимикатов",
]
# ТОЛЬКО сильные признаки «реестра» для пропуска страницы
REGISTRY_PAGE_SKIP_TOKENS = [
    "номер государственной регистрации", "свидетельство",
    "государственной регистрации", "госреестр", "реестр",
]

# Категорийные подсказки (добавляются поверх общего скоринга)
CATEGORY_HINTS = {
    # Для пестицидов понижаем всё, что похоже на агрохимию (удобрения)
    "pesticide": {
        "bonus": [
            "пестицид", "гербицид", "инсектицид", "фунгицид", "протравител",
            "вредный объект", "срок ожидания", "культура", "регламент",
            "часть i", "часть 1",
        ],
        "penalty": [
            "агрохимикат", "удобрени", "npk", "микроэлемент", "гуминов",
            "мелиорант", "почвенн", "торфян", "часть ii", "часть 2", "агрохимикаты",
        ],
        "filename_bonus": ["pest", "пестиц", "part_i", "часть_i", "часть-1", "chast_i"],
        "filename_penalty": ["agro", "агрохим", "part_ii", "часть_ii", "часть-2", "chast_ii"],
    },
    # Для агрохимикатов наоборот
    "agrochem": {
        "bonus": [
            "агрохимикат", "удобрени", "npk", "микроэлемент", "гуминов",
            "мелиорант", "почвенн", "торфян", "часть ii", "часть 2", "агрохимикаты",
        ],
        "penalty": [
            "пестицид", "гербицид", "инсектицид", "фунгицид", "протравител",
            "вредный объект", "срок ожидания", "культура", "часть i", "часть 1",
        ],
        "filename_bonus": ["agro", "агрохим", "part_ii", "часть_ii", "часть-2", "chast_ii"],
        "filename_penalty": ["pest", "пестиц", "part_i", "часть_i", "часть-1", "chast_i"],
    },
}

# UA / TLS
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}
VERIFY: bool | str = cfg.catalog_ca_bundle or cfg.catalog_ssl_verify

# Глушим warning, если verify=False
try:
    import urllib3  # type: ignore
    if not VERIFY:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

# Target schema
FIELDNAMES = ["crop", "disease", "product", "dosage_value", "dosage_unit", "phi"]
VALID_UNITS = {
    "ml_10l", "g_10l",     # мл/10 л, г/10 л
    "ml_l", "g_per_l",     # мл/л, г/л
    "l_ha", "kg_ha",       # л/га, кг/га
}
_UNIT_MAP = {
    "л/га": "l_ha",
    "кг/га": "kg_ha",
    "мл/л": "ml_l",
    "г/л": "g_per_l",
    "мл/10 л": "ml_10l",
    "мл/10л": "ml_10l",
    "г/10 л": "g_10l",
    "г/10л": "g_10l",
}

# Catalog pages (from .env via Settings)
CATALOG_PAGES = {
    "main": cfg.catalog_main_url,
    "pesticide": cfg.catalog_pesticide_url,
    "agrochem": cfg.catalog_agrochem_url,
}

# ===== Helpers: dates, network, page parsing =====
_RU_MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}

def parse_ru_date(text: str) -> Optional[date]:
    m = re.search(r"(\d{1,2})\s+([а-яА-ЯёЁ]+)\s+(20\d{2})", text)
    if not m:
        return None
    day = int(m.group(1))
    month = _RU_MONTHS.get(m.group(2).lower())
    year = int(m.group(3))
    if not month:
        return None
    try:
        return date(year, month, day)
    except ValueError:
        return None

def find_latest_zip_mcx(html: str, base_url: str) -> Tuple[str, Optional[date]]:
    soup = BeautifulSoup(html, "html.parser")
    latest_url: Optional[str] = None
    latest_dt: Optional[date] = None

    rows = soup.find_all("div", class_="b-table__row")
    if not rows:
        logger.warning("Не найдены .б-table__row — fallback по всем ссылкам.")
        for a in soup.find_all("a", href=True):
            if not a["href"].lower().endswith(".zip"):
                continue
            txt = a.get_text(" ", strip=True)
            m = re.search(r"(\d{2}\.\d{2}\.\d{4})", txt)
            dt = None
            if m:
                try:
                    dt = datetime.strptime(m.group(1), "%d.%m.%Y").date()
                except Exception:
                    dt = None
            url = urljoin(base_url, a["href"])
            if latest_dt is None or (dt and dt > latest_dt):
                latest_dt = dt
                latest_url = url
        if not latest_url:
            raise ValueError("No ZIP links found on page (fallback).")
        return latest_url, latest_dt

    for row in rows:
        a = row.find("a", href=lambda h: h and h.lower().endswith(".zip"))
        if not a:
            continue
        cells = row.find_all("div", class_="b-table__cell")
        desc = (cells[-1].get_text(" ", strip=True).lower() if cells else "").strip()
        if "каталог" not in desc:
            continue

        dt = parse_ru_date(desc)
        if not dt:
            txt = a.get_text(" ", strip=True)
            m = re.search(r"(\d{2}\.\d{2}\.\d{4})", txt)
            if m:
                try:
                    dt = datetime.strptime(m.group(1), "%d.%m.%Y").date()
                except Exception:
                    dt = None

        url = urljoin(base_url, a["href"])
        if latest_dt is None or (dt and dt > latest_dt):
            latest_dt = dt
            latest_url = url

    if not latest_url:
        raise ValueError("No suitable 'каталог' ZIP rows found.")
    return latest_url, latest_dt

def find_latest_zip(html: str, base_url: str) -> str:
    """
    Backward-compatible обёртка: прежние скрипты/тесты ждут только URL,
    поэтому возвращаем первый элемент из пары (url, date).
    """
    url, _ = find_latest_zip_mcx(html, base_url)
    return url

def download_zip(url: str, dest: Path) -> Path:
    try:
        with requests.get(
            url,
            timeout=60,
            stream=True,
            headers={**UA, "Referer": cfg.catalog_referer or CATALOG_PAGES.get("main") or ""},
            verify=VERIFY,
        ) as response:
            response.raise_for_status()
            with dest.open("wb") as fh:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        fh.write(chunk)
        return dest
    except requests.RequestException as exc:
        if dest.exists():
            dest.unlink(missing_ok=True)
        raise RuntimeError(f"Failed to download {url}") from exc

# ===== ZIP filename normalizer =====

def _decode_zip_name(info: zipfile.ZipInfo) -> str:
    """
    Если не выставлен UTF-8 flag, пробуем CP437->CP866 (часто так упаковывают на Windows/RU).
    Возвращаем «человеческое» имя.
    """
    if not (info.flag_bits & 0x800):
        try:
            return info.filename.encode("cp437").decode("cp866")
        except Exception:
            return info.filename
    return info.filename

# ===== PDF chooser =====

def _score_pdf_for_protocol(pdf_path: Path, pages_to_scan: int = 100, category: str = "pesticide") -> Tuple[int, Counter]:
    """
    Усиленный скоринг PDF:
      • +6 за каждый позитивный токен;
      • +10 за каждый юнит (л/га, кг/га, ...), плюс бонус за плотность юнитов;
      • −12 за каждый «реестровый» токен;
      • Категорийные бонусы/штрафы: ±18 за текстовые маркеры, ±25 за «жёсткие» маркеры;
      • Доп. бонус/штраф по имени файла.
    Сканируем первые pages_to_scan страниц ТОЛЬКО текстом (дёшево).
    Возвращает (score, counter) — counter содержит частоты токенов.
    """
    import pdfplumber

    hints = CATEGORY_HINTS.get(category, CATEGORY_HINTS.get("pesticide"))

    score = 0
    cnt: Counter = Counter()
    chars_total = 0

    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page in pdf.pages[:pages_to_scan]:
                try:
                    text = (page.extract_text() or "").lower()
                except Exception:
                    text = ""
                if not text:
                    continue
                chars_total += len(text)

                # базовые позитивные
                for t in PROTOCOL_POSITIVE_TOKENS:
                    c = text.count(t)
                    if c:
                        cnt[t] += c
                        score += c * 6

                # юниты (повышенный вес)
                unit_hits = 0
                for u in UNIT_TOKENS:
                    c = text.count(u)
                    if c:
                        cnt[u] += c
                        unit_hits += c
                score += unit_hits * 10

                # негативные (реестры)
                for t in REGISTRY_NEGATIVE_TOKENS:
                    c = text.count(t)
                    if c:
                        cnt[t] += c
                        score -= c * 12

                # категорийнные бонусы/штрафы
                for t in hints["bonus"]:
                    c = text.count(t)
                    if c:
                        cnt[f"+{t}"] += c
                        score += c * 18
                for t in hints["penalty"]:
                    c = text.count(t)
                    if c:
                        cnt[f"-{t}"] += c
                        hard = t in ("часть ii", "часть 2", "агрохимикаты") if category == "pesticide" else \
                               t in ("часть i", "часть 1", "пестицид")
                        score -= c * (25 if hard else 18)

        # Бонус за плотность юнитов относительно объёма текста
        unit_total = sum(cnt.get(u, 0) for u in UNIT_TOKENS)
        if chars_total > 0 and unit_total > 0:
            density = unit_total * 1000.0 / chars_total
            score += int(min(50, round(density * 8)))
    except Exception:
        return -10_000, Counter()

    # Имя файла: дополнительный сигнал
    name = pdf_path.name.lower()
    if name:
        for k in hints["filename_bonus"]:
            if k in name:
                score += 60
                cnt[f"+filename:{k}"] += 1
        for k in hints["filename_penalty"]:
            if k in name:
                score -= 60
                cnt[f"-filename:{k}"] += 1

    return score, cnt

def pick_best_pdf_from_zip(zip_path: Path, pages_to_scan: int = 100, category: str = "pesticide") -> Optional[Path]:
    """
    Извлекает все PDF из архива во временную папку рядом и возвращает путь к лучшему (по score).
    При равенстве score — выбирает более «толстый» файл (байты).
    Логирует всех кандидатов: имя (MB) -> score.
    """
    tmpdir = zip_path.parent
    pdf_candidates: List[Path] = []
    sizes: Dict[str, int] = {}

    with zipfile.ZipFile(zip_path) as zf:
        for zi in zf.infolist():
            name = _decode_zip_name(zi)
            if not name.lower().endswith(".pdf"):
                continue
            out = tmpdir / Path(name).name
            with out.open("wb") as f:
                f.write(zf.read(zi))
            pdf_candidates.append(out)
            sizes[out.name] = zi.file_size

    if not pdf_candidates:
        return None

    scored: List[Tuple[Path, int, Counter, int]] = []
    for p in pdf_candidates:
        sc, tokens = _score_pdf_for_protocol(p, pages_to_scan=pages_to_scan, category=category)
        size = sizes.get(p.name, p.stat().st_size)
        scored.append((p, sc, tokens, size))

    for p, sc, _t, sz in scored:
        logger.info("PDF candidate: %s (%.1f MB) -> score=%d [category=%s]", p.name, sz / 1e6, sc, category)

    chosen = max(scored, key=lambda x: (x[1], x[3]))
    p, sc, tokens, sz = chosen
    logger.info("Chosen PDF: %s (%.1f MB) -> score=%d", p.name, sz / 1e6, sc)
    common_tokens = [kv for kv in tokens.most_common(12)]
    if common_tokens:
        logger.info("Token snapshot (top-12): %s", json.dumps(common_tokens, ensure_ascii=False))
    return p

# ===== PDF protocol extractor =====
_DASH = r"(?:-|–|—)"
_UNIT_RX = r"(л\s*/\s*га|кг\s*/\s*га|мл\s*/\s*л|г\s*/\s*л|мл\s*/\s*10\s*л|г\s*/\s*10\s*л|мл\s*/\s*10л|г\s*/\s*10л)"

def _parse_dosage_expr(text: str) -> tuple[float | None, str | None]:
    if not text:
        return None, None
    s = re.sub(r"\s+", " ", str(text)).strip().lower()
    m = re.search(rf"(\d+(?:[.,]\d+)?)(?:\s*{_DASH}\s*(\d+(?:[.,]\d+)?))?\s*{_UNIT_RX}", s, re.I)
    if not m:
        return None, None
    lo = float(m.group(1).replace(",", "."))
    hi = m.group(2)
    val = float(hi.replace(",", ".")) if hi else lo
    unit_raw = re.sub(r"\s+", "", m.group(3))
    unit_key = (
        "л/га" if unit_raw == "л/га" else
        "кг/га" if unit_raw == "кг/га" else
        "мл/л" if unit_raw == "мл/л" else
        "г/л"  if unit_raw == "г/л"  else
        "мл/10 л" if unit_raw in {"мл/10л", "мл/10 л"} else
        "г/10 л"  if unit_raw in {"г/10л",  "г/10 л"}  else
        None
    )
    unit_code = _UNIT_MAP.get(unit_key or "", None)
    return (val, unit_code) if unit_code in VALID_UNITS else (None, None)

def _detect_unit_from_header(header_text: str) -> Optional[str]:
    if not header_text:
        return None
    s = header_text.lower()
    for raw, code in [
        ("л/га", "l_ha"), ("кг/га", "kg_ha"),
        ("мл/л", "ml_l"), ("г/л", "g_per_l"),
        ("мл/10 л", "ml_10l"), ("мл/10л", "ml_10l"),
        ("г/10 л", "g_10l"), ("г/10л", "g_10l"),
    ]:
        if raw in s:
            return code
    return None

def extract_protocol_rows(pdf_path: Path, debug_dir: Optional[Path] = None,
                          max_pages: int = MAX_PAGES_DEFAULT,
                          stop_after: int = STOP_AFTER_ROWS,
                          prefer_text: bool = True) -> list[dict]:
    """
    Лёгкий парсер регламентов:
    - обрабатывает только первые max_pages страниц;
    - прекращает работу, как только набрано stop_after строк;
    - по умолчанию использует стратегию 'text', к 'lines' переходит лишь если 'text' ничего не нашла;
    - дампит только TEXT (page-XXX-text.txt) и только для первых DEBUG_DUMP_PAGES страниц.
    """
    import pdfplumber

    rows: list[dict] = []

    # ===== regex / utils =====
    rx_crop    = re.compile(r"(культур|культура|культуры|с\.-?\s*х\.?\s*культур|сельскохозяйственн|обрабатываемые\s+культуры?)", re.I)
    rx_disease = re.compile(r"(вредн\w* организм\w*|вредн|вредител\w*|болезн\w*|сорняк\w*|объект\w*|патоген\w*|заболеван\w*)", re.I)
    rx_norm    = re.compile(
        r"(?:норм[аы]\s*примен(?:ени[яе])?(?:\s*препарат\w*)?|"
        r"нормы?\s+применени[яе](?:\s*препарат\w*)?|"
        r"норм[аы]\s*расход[а]?|"
        r"расход\s*(?:препарат[а]?|рабоч(?:ей|его)\s*жидкост[и]|рабоч(?:его)?\s*раствор[а]?)|"
        r"доз[аы])",
        re.I
    )
    rx_phi     = re.compile(r"(срок[и]?\s*ожидан|ожидания|ожид\.)", re.I)
    rx_phi_num = re.compile(r"\d+")
    rx_unit_tokens = re.compile(_UNIT_RX, re.I)

    def guess_product_name_from_cell(cell_text: str) -> str:
        if not cell_text:
            return ""
        line = next((ln.strip() for ln in cell_text.splitlines() if ln.strip()), "")
        line = re.sub(r"\s{2,}", " ", line)
        line = re.split(r"\s*\(+", line)[0].strip()
        return line

    def combine_header_rows(table: list[list[str | None]], max_rows: int = 10) -> list[str]:
        head = table[:max_rows]
        width = max(len(r) for r in head)
        cols = []
        for j in range(width):
            parts = []
            for i in range(len(head)):
                v = head[i][j] if j < len(head[i]) else ""
                v = (v or "").strip()
                if v:
                    parts.append(v)
            cols.append(" ".join(parts))
        return cols

    def find_cols(header_cells: list[str]) -> tuple[Optional[int], Optional[int], Optional[int], Optional[int]]:
        col_crop = col_disease = col_norm = col_phi = None
        for idx, name in enumerate(header_cells):
            n = (name or "").strip()
            if not n:
                continue
            if col_crop is None and rx_crop.search(n):
                col_crop = idx
            if col_disease is None and rx_disease.search(n):
                col_disease = idx
            if col_norm is None and rx_norm.search(n):
                col_norm = idx
            if col_phi is None and rx_phi.search(n):
                col_phi = idx
        return col_crop, col_disease, col_norm, col_phi

    rx_range = re.compile(r"(\d+(?:[.,]\d+)?)(?:\s*(?:-|–|—)\s*(\d+(?:[.,]\d+)?))?")
    def parse_number_or_range(text: str) -> float | None:
        if not text:
            return None
        m = rx_range.search(text.replace(" ", ""))
        if not m:
            return None
        hi = m.group(2) or m.group(1)
        try:
            return float(hi.replace(",", "."))
        except Exception:
            return None

    def try_norm_from_cells(cells: list[str], start: int) -> tuple[float | None, str | None, str]:
        pieces = []
        for k in range(0, 3):
            j = start + k
            if j < len(cells):
                txt = (cells[j] or "").strip()
                if txt:
                    pieces.append(txt)
        joined = " ".join(pieces).strip()
        val, unit = _parse_dosage_expr(joined)
        return val, unit, joined

    def sniff_norm_col_by_units_or_values(table: list[list[str | None]]) -> Optional[int]:
        # 1) ищем ячейку с явным юнитом в первых 10 строках
        for i in range(0, min(10, len(table))):
            row = [str(c or "") for c in table[i]]
            for j, cell in enumerate(row):
                if rx_unit_tokens.search(cell):
                    return j
        # 2) ищем первую «дозу» по регулярке в первых 15 строках
        for i in range(0, min(15, len(table))):
            row = [str(c or "") for c in table[i]]
            for j, cell in enumerate(row):
                v, u = _parse_dosage_expr(cell)
                if v is not None and (u in VALID_UNITS or rx_unit_tokens.search(cell)):
                    return j
        return None

    def guess_product_left_of_norm(cells: list[str], j_norm: int) -> str:
        # берём ближайшую непустую слева от колонки «норма»
        for j in range(j_norm - 1, -1, -1):
            cand = guess_product_name_from_cell(cells[j])
            if cand:
                return cand
        return ""

    strategies_text  = [dict(vertical_strategy="text",  horizontal_strategy="text",  text_x_tolerance=2)]
    strategies_lines = [dict(vertical_strategy="lines", horizontal_strategy="lines", text_x_tolerance=2,
                             snap_tolerance=3, join_tolerance=3, edge_min_length=60)]

    skipped_pages = 0
    used_fallback_tables = 0

    with pdfplumber.open(str(pdf_path)) as pdf:
        pages = pdf.pages[:max_pages]

        for strategies in ([*strategies_text] if prefer_text else []) + [*strategies_lines]:
            for page_index, page in enumerate(pages, start=1):
                # Пропускаем очевидные "реестровые" страницы — БЕЗ «ОГРН»
                try:
                    page_text = page.extract_text() or ""
                except Exception:
                    page_text = ""
                low = page_text.lower()
                if any(tok in low for tok in REGISTRY_PAGE_SKIP_TOKENS):
                    skipped_pages += 1
                    if debug_dir and page_index <= DEBUG_DUMP_PAGES:
                        (debug_dir / f"page-{page_index:03d}-skipped-registry.txt").write_text(page_text, encoding="utf-8")
                    continue

                # Ищем таблицы
                try:
                    tbls = page.extract_tables(strategies) or []
                except Exception:
                    tbls = []

                # Дампим ТОЛЬКО текст и только для первых страниц
                if debug_dir and page_index <= DEBUG_DUMP_PAGES:
                    (debug_dir / f"page-{page_index:03d}-text.txt").write_text(page_text or "", encoding="utf-8")

                for t in tbls:
                    if not t or all(not any(cell for cell in row) for row in t):
                        continue

                    # 1) по заголовкам
                    combined_header = combine_header_rows(t, max_rows=10)
                    col_crop, col_disease, col_norm, col_phi = find_cols(combined_header)
                    if col_crop is None or col_disease is None:
                        header = [str(c or "").strip() for c in (t[0] if t else [])]
                        cc2, cd2, cn2, cp2 = find_cols(header)
                        col_crop    = col_crop    if col_crop    is not None else cc2
                        col_disease = col_disease if col_disease is not None else cd2
                        col_norm    = col_norm    if col_norm    is not None else cn2
                        col_phi     = col_phi     if col_phi     is not None else cp2

                    # 2) если «норма» не найдена — нюхаем по юнитам/значениям
                    if col_norm is None:
                        sniff = sniff_norm_col_by_units_or_values(t)
                        if sniff is not None:
                            col_norm = sniff
                            used_fallback_tables += 1

                    if col_norm is None:
                        continue  # явно не наша таблица

                    hdr_norm = combined_header[col_norm] if col_norm < len(combined_header) else ""
                    default_unit = _detect_unit_from_header(hdr_norm)

                    # где заканчивается шапка
                    start_row = 1
                    for probe in range(1, min(10, len(t))):
                        rp = [str(x or "") for x in t[probe]]
                        if any(rx_crop.search(x) for x in rp) and any(rx_disease.search(x) for x in rp):
                            start_row = probe + 1
                    start_row = min(start_row, 10)

                    for row in t[start_row:]:
                        cells = [str(c or "").strip() for c in row]
                        if not cells:
                            continue

                        # «продукт»: ближайшая непустая слева от нормы, иначе 1-й столбец
                        product = ""
                        if 0 <= col_norm < len(cells):
                            product = guess_product_left_of_norm(cells, col_norm)
                        if not product and cells:
                            product = guess_product_name_from_cell(cells[0])

                        # «культура/вредный объект»
                        crop    = cells[col_crop]    if (col_crop is not None and col_crop < len(cells)) else (cells[0] if len(cells) > 0 else "")
                        disease = cells[col_disease] if (col_disease is not None and col_disease < len(cells)) else (cells[1] if len(cells) > 1 else "")
                        if not (product and crop and disease):
                            continue

                        # Норма — «число+юнит» или «только число» + юнит из заголовка/соседей
                        val = unit = None
                        if col_norm is not None and col_norm < len(cells):
                            val, unit = _parse_dosage_expr(cells[col_norm])

                        if (val is None or unit not in VALID_UNITS) and col_norm is not None:
                            neighbor = " ".join(cells[col_norm: min(col_norm + 3, len(cells))])
                            v2, u2 = _parse_dosage_expr(neighbor)
                            if v2 is not None and u2 in VALID_UNITS:
                                val, unit = v2, u2

                        if (val is None or unit not in VALID_UNITS) and default_unit:
                            joined = " ".join(cells[col_norm: min(col_norm + 3, len(cells))]) if col_norm is not None else ""
                            val_only = parse_number_or_range(joined)
                            if val_only is not None:
                                val, unit = val_only, default_unit

                        if val is None or unit not in VALID_UNITS:
                            continue

                        # PHI — из колонки или рядом справа
                        phi_val = 0
                        if (col_phi is not None) and (col_phi < len(cells)):
                            m = rx_phi_num.search(cells[col_phi])
                            phi_val = int(m.group(0)) if m else 0
                        else:
                            start_j = col_norm + 1 if col_norm is not None else 0
                            for j in range(start_j, min(start_j + 4, len(cells))):
                                m = rx_phi_num.search(cells[j])
                                if m:
                                    phi_val = int(m.group(0))
                                    break

                        rows.append({
                            "crop": crop,
                            "disease": disease,
                            "product": product,
                            "dosage_value": float(val),
                            "dosage_unit": unit,
                            "phi": int(phi_val),
                        })

                        if len(rows) >= stop_after:
                            logger.info("Reached stop_after=%d rows", stop_after)
                            logger.info("Pages skipped as registry-like: %d; tables parsed with fallback: %d", skipped_pages, used_fallback_tables)
                            return rows

            if rows:
                break  # текущая стратегия дала результат — достаточно

    logger.info("Pages skipped as registry-like: %d; tables parsed with fallback: %d", skipped_pages, used_fallback_tables)
    return rows

# ===== DB =====
def bulk_insert_items(rows: Iterable[dict], force: bool = False) -> None:
    """Insert ``rows`` into ``catalogs`` and ``catalog_items`` tables."""
    session = db.SessionLocal()
    try:
        if force:
            logger.info("Force flag set – truncating existing catalog tables")
            session.execute(text("DELETE FROM catalog_items"))
            session.execute(text("DELETE FROM catalogs"))
            session.commit()

        catalogs_cache: dict[tuple[str, str], int] = {}
        catalogs_to_insert: list[dict] = []
        for row in rows:
            key = (row.get("crop", ""), row.get("disease", ""))
            if key not in catalogs_cache:
                catalog_data = {"crop": key[0], "disease": key[1]}
                catalogs_cache[key] = 0
                catalogs_to_insert.append(catalog_data)

        if catalogs_to_insert:
            session.bulk_insert_mappings(Catalog, catalogs_to_insert, return_defaults=True)
            for catalog in catalogs_to_insert:
                key = (catalog["crop"], catalog["disease"])
                catalogs_cache[key] = catalog["id"]

        items_to_insert: list[dict] = []
        for row in rows:
            dv = row.get("dosage_value")
            du = row.get("dosage_unit")
            if not isinstance(dv, (int, float)) or du not in VALID_UNITS:
                logger.debug("Skip row with invalid dosage: %s", row)
                continue

            items_to_insert.append(
                {
                    "catalog_id": catalogs_cache[(row.get("crop", ""), row.get("disease", ""))],
                    "product": row.get("product", ""),
                    "dosage_value": float(dv),
                    "dosage_unit": du,
                    "phi": int(row.get("phi", 0) or 0),
                }
            )

        if items_to_insert:
            session.bulk_insert_mappings(CatalogItem, items_to_insert)

        session.commit()
    finally:
        session.close()

# ===== Orchestrator =====
def run_import(category: str, force: bool = False) -> None:
    """
    category: main|pesticide|agrochem|all
      - main     -> трактуем как pesticide (совместимость)
      - pesticide/agrochem -> парс одного тома
      - all      -> из одного ZIP-а парсим лучший PDF для обоих томов и заливаем вместе
    """
    if category == "all":
        target_categories = ["pesticide", "agrochem"]
        page_key = "pesticide"  # на этой странице обычно лежит ZIP с обоими томами
    elif category == "main":
        target_categories = ["pesticide"]
        page_key = "pesticide"
    else:
        target_categories = [category]
        page_key = category

    logger.info("== %s ==", __VERSION__)
    logger.info("Using module file: %s", __file__)
    logger.info("Starting catalog import for category '%s'", category)

    # Предохранитель от дублей: если данные уже есть и не force — выходим
    # (для режима all ожидается, что это первый прогон; иначе используйте --force)
    with db.SessionLocal() as session:
        already_imported = session.execute(text("SELECT 1 FROM catalog_items LIMIT 1")).first()
        if already_imported and not force:
            logger.info("Catalog already imported – exiting")
            return

    page_url = CATALOG_PAGES.get(page_key)
    if not page_url:
        raise ValueError(f"Unknown catalog category: {category}")

    try:
        resp = requests.get(
            page_url,
            timeout=30,
            headers={**UA, "Referer": cfg.catalog_referer or page_url},
            verify=VERIFY,
        )
    except requests.exceptions.SSLError:
        logger.error("SSL error fetching catalog page. Set CATALOG_CA_BUNDLE or CATALOG_SSL_VERIFY.")
        return
    resp.raise_for_status()

    try:
        Path("mcx_debug_page.html").write_text(resp.text, encoding="utf-8")
    except Exception:
        pass

    zip_url, zip_dt = find_latest_zip_mcx(resp.text, page_url)
    logger.info("Latest archive URL: %s (date: %s)", zip_url, zip_dt)

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        zip_path = download_zip(zip_url, tmpdir / "archive.zip")

        # Папка для отладочных дампов (только текст, и только первые страницы)
        dbg_root = Path("debug_protocols")
        dbg_root.mkdir(exist_ok=True)
        ts_dir = dbg_root / datetime.now().strftime("%Y%m%d-%H%M%S")
        ts_dir.mkdir(exist_ok=True)

        all_rows: List[dict] = []
        first_pdf_saved = False

        for cat in target_categories:
            best_pdf = pick_best_pdf_from_zip(zip_path, pages_to_scan=100, category=cat)
            if not best_pdf:
                logger.warning("No PDF found for category %s inside %s", cat, zip_url)
                continue

            # Сохраняем копии выбранных PDF
            try:
                if cat == "pesticide":
                    Path("last_protocol_pesticide.pdf").write_bytes(best_pdf.read_bytes())
                    # для совместимости — указываем на пестициды
                    if not first_pdf_saved:
                        Path("last_protocol.pdf").write_bytes(Path("last_protocol_pesticide.pdf").read_bytes())
                        first_pdf_saved = True
                else:
                    Path("last_protocol_agrochem.pdf").write_bytes(best_pdf.read_bytes())
                    if not first_pdf_saved:
                        Path("last_protocol.pdf").write_bytes(Path("last_protocol_agrochem.pdf").read_bytes())
                        first_pdf_saved = True
            except Exception:
                pass

            # Для «pesticide» включаем лёгкий режим (урезаем страницы и порог строк, без дампов)
            light = (cat == "pesticide")
            dbg_dir = None if light else (ts_dir / cat)
            if dbg_dir:
                dbg_dir.mkdir(exist_ok=True, parents=True)

            rows = extract_protocol_rows(
                best_pdf,
                debug_dir=dbg_dir,
                max_pages=LIGHT_MAX_PAGES if light else MAX_PAGES_DEFAULT,
                stop_after=LIGHT_STOP_ROWS if light else STOP_AFTER_ROWS,
                prefer_text=True,
            )
            logger.info("[%s] Protocol rows extracted: %d", cat, len(rows))
            all_rows.extend(rows)

        if not all_rows:
            logger.warning("No rows extracted for categories: %s", ",".join(target_categories))
            return

        bulk_insert_items(all_rows, force=force)
        logger.info("Imported %d rows (merged categories: %s)", len(all_rows), ",".join(target_categories))

def main() -> None:
    parser = argparse.ArgumentParser(description="Import protocols catalog")
    parser.add_argument(
        "--category",
        default="main",
        help="Catalog category (main|pesticide|agrochem|all)"
    )
    parser.add_argument("--force", action="store_true", help="Replace existing data")
    args = parser.parse_args()
    run_import(args.category, force=args.force)

if __name__ == "__main__":
    main()
