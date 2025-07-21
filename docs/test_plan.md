QA Test Plan – «Карманный агроном» (Telegram‑бот)
Версия 1.3 — 20 июля 2025 г.
(v1.2 → v1.3: добавлены лимиты Free-плана, валидация HMAC-подписи, проверка заголовка X-API-Ver, диагностика multipart/base64, новые коды ошибок)
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
7. Нагрузочное тестирование
k6 load_diag.js — 90 RPS, 5 мин; PASS: error < 1 %, latency P95 < 8 c.
8. API integration tests
Postman collection v1.3 + CI:• Проверка кодов 200/400/401/429/502• Ajv‑валидация схем OpenAPI• Проверка quota: /limits → 5/5 → diagnose = 429
9. Security checks
• SSL Labs grade: A• SQL-injection• Проверка HMAC: signature в теле + заголовке• Rate-limiting (30 rps), бизнес-лимит (5/мес)
10. Schedule & Roles
(QA-инженер, DevOps, Security, Product Owner — см. Notion / JIRA)
11. Risk & Mitigation
(см. Risk Register v1.1)
12. Sign‑off
QA Lead / Security Officer / PO — согласовано
