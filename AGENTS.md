AGENTS.md — Contributor Guide для Codex/AI‑агентов

Version 1.1 — 5 August 2025(v1.0 → v1.1: добавлены Autopay endpoints, Tinkoff creds, новые docs URLs, Python 3.12 / Node 20, Spectral + openapi‑diff gate)

Quick English Overview

This repo relies on Codex automation. Use Python 3.11+ (3.12 experimental) for the API and Node.js 20+ for the bot.

# Backend
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload

# Frontend / Bot
npm ci --prefix bot
npm test --prefix bot

# Linting / Tests
ruff check app tests
pytest

Avoid blocking DB calls inside async FastAPI handlers — use SQLAlchemy async sessions or asyncio.to_thread.

All PRs target develop, must pass tests + linters and update docs when behaviour changes.

📦 Проект: «Карманный агроном» — Telegram Bot (MVP)

Репозиторий рассчитан на автоматизированные коммиты Codex‑агента. Соблюдайте правила, чтобы CI/CD проходил без вмешательства.

🛠️ Базовые команды

# Установка зависимостей
pip install -r requirements.txt

# Миграции
alembic upgrade head

# API (hot‑reload)
uvicorn app.main:app --reload

# Тесты
pytest

# Telegram‑бот
npm ci --prefix bot
node bot/index.js

# Линтинг
ruff check app/

🔑 Переменные окружения

Скопируйте .env.template → .env и укажите значения.

Var

Purpose

POSTGRES_*

подключение к БД

DATABASE_URL

строка соединения Alembic

S3_*

доступ к бакету

BOT_TOKEN_DEV

Telegram Bot Token (dev)

OPENAI_API_KEY

GPT‑Vision (sandbox, required)

TINKOFF_TERMINAL_KEY / TINKOFF_SECRET_KEY

SBP Invoice + Autopay

HMAC_SECRET_PARTNER

подпись AgroStore

Never commit real tokens! Use GitHub Secrets for CI.

📋 Правила PR

Ветвление: feature/… → PR → develop.

Каждый PR ➜ ruff, pytest, Alembic migration check, Spectral lint (spectral lint openapi/openapi.yaml), openapi-diff.

При изменениях схемы ➜ Alembic migration + обновить:

docs/data_contract.md

docs/srs.md

docs/payment_flow.md

Обновите CHANGELOG.md (semver).

🚦 CI/CD

GitHub Actions workflow: lint → tests → build docker → openapi-diff.

ArgoCD auto‑deploy on main tag.

🧪 Тесты

Папка tests/ — PyTest (backend) + Jest (bot).

Все багфиксы → unit‑тест.

Новый эндпойнт → Postman collection + contract‑тест в CI.

🗂️ Архитектура каталога

app/
  controllers/   # FastAPI routers
  models/        # SQLAlchemy + Pydantic
  services/      # GPT, S3, payments, quotas
  worker/        # BullMQ jobs (retry_diagnosis.js)
openapi/
  openapi.yaml   # synced with FastAPI schema
bot/
  src/           # Telegram bot commands
  tests/

💡 Workflow для Codex‑агента

Before coding: checkout develop, pip install, pull latest migrations.

During coding: small atomic commits, follow PEP8 + TS ESLint.

After coding: run pytest, ruff, ensure migrations apply.

PR description:

Type: [feature] / [fix] / [refactor] / [docs].

What changed + steps to test.

Linked issues.

🕹️ Специальные указания

Ошибка? — Лог + предложить 2+ пути решения.

Большая задача? — Разбей на сабзадачи в PR.

Всегда обновляйте docs, если меняется API/логика.

Никогда не публикуйте реальные секреты.

🔗 Внешние сервисы

GPT‑Vision — sandbox key.

S3/Minio — local Minio for dev.

Tinkoff SBP — sandbox env.

AgroStore — mock server with make start-partner-mock.

📢 Контакты

Role

Handle

Product Owner

@gromov_agro

Tech Lead

@your_techlead

QA Lead

@qa_agro