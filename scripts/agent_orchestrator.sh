#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-auto}"
BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"

log() {
  printf '[agent-orchestrator] %s\n' "$*"
}

run_cmd() {
  local title="$1"
  shift
  log "RUN: ${title}"
  "$@"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if [[ -z "${HEAD_SHA}" ]]; then
  HEAD_SHA="HEAD"
fi

if [[ "${MODE}" == "all" ]]; then
  CHANGED_FILES="app/ bot/ openapi/ docs/ load/ migrations/ tests/ locales/"
  log "MODE=${MODE}"
elif [[ -n "${BASE_SHA}" ]]; then
  CHANGED_FILES="$(git diff --name-only "${BASE_SHA}" "${HEAD_SHA}" || true)"
  log "MODE=${MODE} BASE_SHA=${BASE_SHA} HEAD_SHA=${HEAD_SHA}"
else
  TRACKED_CHANGES="$(git diff --name-only HEAD || true)"
  UNTRACKED_CHANGES="$(git ls-files --others --exclude-standard || true)"
  CHANGED_FILES="$(printf '%s\n%s\n' "${TRACKED_CHANGES}" "${UNTRACKED_CHANGES}" | sed '/^$/d' | sort -u)"
  log "MODE=${MODE} BASE_SHA=<working-tree> HEAD_SHA=${HEAD_SHA}"
fi
if [[ -z "${CHANGED_FILES}" ]]; then
  log "Изменений не обнаружено, завершаю."
  exit 0
fi

printf '%s\n' "${CHANGED_FILES}" > /tmp/changed_files.txt
log "Изменённые пути:" 
cat /tmp/changed_files.txt

NEED_BACKEND=0
NEED_BOT=0
NEED_OPENAPI=0
NEED_DOCS=0
NEED_RAG=0

if rg -q '^(app/|migrations/|tests/)' /tmp/changed_files.txt; then
  NEED_BACKEND=1
fi
if rg -q '^(bot/|locales/)' /tmp/changed_files.txt; then
  NEED_BOT=1
fi
if rg -q '^(openapi/|app/controllers/|app/models/)' /tmp/changed_files.txt; then
  NEED_OPENAPI=1
fi
if rg -q '^(docs/|app/|bot/|openapi/|migrations/|locales/)' /tmp/changed_files.txt; then
  NEED_DOCS=1
fi
if rg -q '^(load/|scripts/rag_|scripts/load_knowledge_chunks.py)' /tmp/changed_files.txt; then
  NEED_RAG=1
fi

log "skills: backend=${NEED_BACKEND} bot=${NEED_BOT} openapi=${NEED_OPENAPI} docs=${NEED_DOCS} rag=${NEED_RAG}"

if [[ "${NEED_BACKEND}" -eq 1 ]]; then
  if have_cmd ./venv/bin/ruff; then
    run_cmd "ruff check app tests" ./venv/bin/ruff check app tests
  else
    run_cmd "ruff check app tests" ruff check app tests
  fi

  if [[ -x ./venv/bin/python ]]; then
    run_cmd "pytest" ./venv/bin/python -m pytest -q
  else
    run_cmd "pytest" python -m pytest -q
  fi
fi

if [[ "${NEED_BOT}" -eq 1 ]]; then
  run_cmd "npm test --prefix bot" npm test --prefix bot
fi

if [[ "${NEED_OPENAPI}" -eq 1 ]]; then
  if have_cmd spectral; then
    run_cmd "spectral lint openapi/openapi.yaml" spectral lint openapi/openapi.yaml
  else
    log "SKIP: spectral не установлен"
  fi
fi

if [[ "${NEED_RAG}" -eq 1 ]]; then
  if [[ -x ./venv/bin/python ]]; then
    run_cmd "rag_preflight" ./venv/bin/python scripts/rag_preflight.py
    run_cmd "rag_smoke_check" ./venv/bin/python scripts/rag_smoke_check.py
  else
    run_cmd "rag_preflight" python scripts/rag_preflight.py
    run_cmd "rag_smoke_check" python scripts/rag_smoke_check.py
  fi
fi

if [[ "${NEED_DOCS}" -eq 1 ]]; then
  log "DOCS-CHECK: убедитесь, что обновлены docs/srs.md, docs/data_contract.md, профильные flow-доки и CHANGELOG.md при изменении поведения."
fi

log "Готово"
