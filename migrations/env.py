#env.py
import os
import sys
from dotenv import load_dotenv
load_dotenv()

# Добавляем путь к app
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Импорт модели
from app.models import Base  # ← убедись, что models.Base определён
from alembic import context
from sqlalchemy import engine_from_config, pool

# Настройка метаданных
target_metadata = Base.metadata

# Получаем конфиг Alembic
config = context.config

# Получаем URL из переменной окружения
url = os.getenv("DATABASE_URL")
if url is None:
    raise ValueError("DATABASE_URL environment variable not set")

config.set_main_option("sqlalchemy.url", url)
