from __future__ import annotations
import re
import yaml
from app.main import app

def get_readme_version() -> str:
    with open("README.md", encoding="utf-8") as f:
        m = re.search(r"Версия API: \*\*v([0-9.]+)\*\*", f.read())
    assert m, "Version not found in README"
    return m.group(1)


def get_openapi_version() -> str:
    with open("openapi/openapi.yaml", encoding="utf-8") as f:
        spec = yaml.safe_load(f)
    return str(spec["info"]["version"])


def test_readme_matches_openapi():
    assert get_readme_version() == get_openapi_version()


def test_app_version_matches_openapi():
    assert app.version == get_openapi_version()
