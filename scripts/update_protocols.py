from pathlib import Path
import csv
import argparse

import requests

# Default public dataset (same CSV format)
DEFAULT_URL = (
    "https://raw.githubusercontent.com/agronomist-mvp/data/main/protocols.csv"
)

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "protocols.csv"


def download_csv(url: str) -> list[dict]:
    """Download CSV from the given URL and return list of rows."""
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    text = response.text
    reader = csv.DictReader(text.splitlines())
    return list(reader)


def write_csv(rows: list[dict], path: Path) -> None:
    """Write rows to CSV in standard format."""
    fieldnames = [
        "crop",
        "disease",
        "product",
        "dosage_value",
        "dosage_unit",
        "phi",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})


def update_protocols_csv(url: str = DEFAULT_URL, output: Path = CSV_PATH) -> Path:
    """Fetch protocols from URL and write to output CSV."""
    rows = download_csv(url)
    write_csv(rows, output)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Update protocols.csv from URL")
    parser.add_argument(
        "--url",
        default=DEFAULT_URL,
        help="CSV file URL (defaults to open dataset)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=CSV_PATH,
        help="Destination CSV path",
    )
    args = parser.parse_args()
    path = update_protocols_csv(args.url, args.output)
    print(f"Protocols saved to {path}")


if __name__ == "__main__":
    main()
