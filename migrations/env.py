#env.py
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.models import Base  # мы создадим Base позже
from alembic import context
from sqlalchemy import engine_from_config, pool
target_metadata = Base.metadata
