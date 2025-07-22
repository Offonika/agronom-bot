#!/bin/bash
set -e

pip install -r requirements.txt

# Optionally install testing tools if not present in requirements
if ! grep -qE '^pytest([=>< ]|$)' requirements.txt; then
    pip install pytest
fi

if ! grep -qE '^ruff([=>< ]|$)' requirements.txt; then
    pip install ruff
fi
