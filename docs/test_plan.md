QA Test Plan – «Карманный агроном» (Telegram‑бот)
Версия 1.7 — 27 июля 2025 г.
(v1.6 → v1.7: history endpoint, новые сценарии навигации)
1. Цели тестирования
Проверить соответствие SRS v1.5.Проверить соблюдение SLO (см. §3) для фаз β и GA.Проверить поведение при превышении лимита 5 фото/мес.Проверить валидацию HMAC-подписей от партнёра (X-Sign + signature).Проверить обязательность заголовка X-API-Ver: v1.
2. Область тестирования
• Диагностика: /diagnose (multipart + base64).• История снимков: /photos.• Платежи: /payments/sbp/webhook.• Партнёрский заказ: /partner/orders (подпись).• Ограничение Free-плана: /limits.• Хранение снимков (TTL = 90 дней).• Интернационализация (RU/EN fallback).
3. Критерии приёмки
β-релиз: P0-багов — 0; P1 — ≤3; все P0‑P1 кейсы — PASS.SLO: latency P95 < 8 с; ошибки ≤ 1 %.Тест кейсы: покрытие всех business-rule edge cases.
4. Тест‑среды
Staging API + Postman / pytest / k6; TG Sandbox Bot; CI (GitHub Actions).
5. Контрольный набор изображений
agro-testset-v1/ (S3): 1 000 JPG + CSV-метки + MD5, SHA‑256 манифест.
6. Тест‑кейсы
• P0: отсутствие подписи, превышение лимита, некорректный формат
• P1: отсутствие заголовка X-API-Ver, 6‑я заявка, base64 vs multipart
• P2: тексты сообщений, логирование
• TC‑030: Фото до mock‑ответа — пользователь отправляет фото боту, получает подтверждение, API выдаёт mock‑диагноз, снимок появляется в S3/Minio
• TC‑040: Пользователь отправляет фото боту — получает карточку с результатом и протоколом либо пометкой «Бета»
• TC‑041: Кнопка «Протокол» открывает deep‑link AgroStore
• TC‑050: При ошибке 402 бот показывает paywall и ссылки на оплату
• TC‑060: Воркер usage_reset сбрасывает счётчики в начале месяца
• TC‑070: Путь от paywall до подтверждения PRO — пользователь видит paywall, выбирает оплату, проходит банк и получает сообщение о PRO
• TC‑080: Просмотр истории через /history выводит список недавних снимков
• TC‑090: Команда /help показывает справку и доступные команды
• TC‑100: Пользователь перемещается по меню: старт → история → диагностика
7. Нагрузочное тестирование
k6 load_diag.js — ~5 000 RPS, 5 мин; PASS: error < 1 %, latency P95 < 8 c.
8. API integration tests
Postman collection v1.7 + CI:• Проверка кодов 200/400/401/402/502• Ajv‑валидация схем OpenAPI• Проверка paywall: /limits → 5/5 → diagnose = 402 → paywall
9. Security checks
• SSL Labs grade: A• SQL-injection• Проверка HMAC: signature в теле + заголовке• Rate-limiting (30 req/min per IP, 120 req/min per user (Pro unlimited)), бизнес-лимит (5/мес)
10. Schedule & Roles
(QA-инженер, DevOps, Security, Product Owner — см. Notion / JIRA)
11. Risk & Mitigation
(см. Risk Register v1.1)
12. Sign‑off
QA Lead / Security Officer / PO — согласовано
