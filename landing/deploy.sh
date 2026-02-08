#!/bin/bash
# Деплой лендинга на сервер
# Использование:
#   ./deploy.sh                 # локальный деплой (если вы на сервере)
#   ./deploy.sh user@host       # деплой по SSH на удалённый сервер

set -e

# Настройки по умолчанию
DEFAULT_TARGET="root@agronom.offonika.ru"
REMOTE_PATH="/var/www/agronom"

TARGET="${1:-$DEFAULT_TARGET}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -z "${1:-}" ]]; then
  echo "🚀 Локальный деплой лендинга в $REMOTE_PATH"
else
  echo "🚀 Деплой лендинга на $TARGET:$REMOTE_PATH"
fi

# Проверяем наличие rsync
if ! command -v rsync &> /dev/null; then
    echo "❌ rsync не найден. Установите: apt install rsync"
    exit 1
fi

# Синхронизация файлов (без --delete чтобы не удалять серверные файлы)
if [[ -z "${1:-}" ]]; then
  rsync -av \
      --exclude='.git' \
      --exclude='deploy.sh' \
      --exclude='README.md' \
      --exclude='.DS_Store' \
      --exclude='*.log' \
      "$SCRIPT_DIR/" "$REMOTE_PATH/"
else
  rsync -avz \
      --exclude='.git' \
      --exclude='deploy.sh' \
      --exclude='README.md' \
      --exclude='.DS_Store' \
      --exclude='*.log' \
      "$SCRIPT_DIR/" "$TARGET:$REMOTE_PATH/"
fi

echo "✅ Файлы синхронизированы"

# Установка прав
if [[ -z "${1:-}" ]]; then
  chown -R www-data:www-data "$REMOTE_PATH" && chmod -R 755 "$REMOTE_PATH"
else
  ssh "$TARGET" "chown -R www-data:www-data $REMOTE_PATH && chmod -R 755 $REMOTE_PATH"
fi

echo "✅ Права установлены"
echo ""
echo "🌐 Сайт доступен: https://agronom.offonika.ru"
echo ""
echo "Не забудьте:"
echo "  1. Заменить METRIKA_ID в index.html на реальный ID счётчика"
echo "  2. Проверить og-image.png (1200x630)"
