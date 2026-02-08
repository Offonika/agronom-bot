"""Rotate or revoke per-user API keys.

Usage:
  python scripts/rotate_user_api_key.py --user-id 123
  python scripts/rotate_user_api_key.py --user-id 123 --revoke
"""

from __future__ import annotations

import argparse
import secrets

from sqlalchemy import text

from app.config import Settings
from app.db import SessionLocal, init_db


def _generate_key() -> str:
    return secrets.token_hex(24)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-id", type=int, required=True)
    parser.add_argument("--revoke", action="store_true")
    args = parser.parse_args()

    init_db(Settings())

    with SessionLocal() as session:
        row = session.execute(
            text("SELECT id, api_key FROM users WHERE id = :uid"),
            {"uid": args.user_id},
        ).first()
        if not row:
            raise SystemExit("User not found")
        if args.revoke:
            session.execute(
                text("UPDATE users SET api_key = NULL WHERE id = :uid"),
                {"uid": args.user_id},
            )
            session.commit()
            print("revoked")
            return
        new_key = _generate_key()
        session.execute(
            text("UPDATE users SET api_key = :api_key WHERE id = :uid"),
            {"uid": args.user_id, "api_key": new_key},
        )
        session.commit()
        print(new_key)


if __name__ == "__main__":
    main()
