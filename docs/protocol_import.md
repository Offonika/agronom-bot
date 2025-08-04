Protocol Import – «Карманный агроном»

Версия 1.0 — 5 августа 2025 г.

1 · Workflow

Утилита `app.services.protocol_importer`:
1. скачивает HTML-страницу каталога по категории;
2. находит последнюю ссылку на архив `.zip`;
3. загружает архив и извлекает PDF;
4. конвертирует PDF → CSV;
5. вставляет строки в таблицы `catalogs` и `catalog_items` (без `--force` повторный импорт пропускается).

2 · Manual run

```bash
python -m app.services.protocol_importer --category main
```

Флаг `--force` перезаписывает существующие данные. Доступны категории `main`, `pesticide`, `agrochem`.

3 · Cron setup

Ежемесячный запуск в Kubernetes CronJob (`0 9 1 * *`, МСК): см. `k8s/cron_catalog_import.yaml`.

4 · Rollback

1. При ошибках удалите данные:
   ```sql
   DELETE FROM catalog_items; DELETE FROM catalogs;
   ```
2. Запустите импорт с предыдущим архивом:
   ```bash
   python -m app.services.protocol_importer <prev_zip_url> --force
   ```
3. Проверьте восстановление (`SELECT COUNT(*) FROM catalog_items`).

Документ `docs/protocol_import.md` (v1.0).
