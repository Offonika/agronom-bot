FROM python:3.11-slim
ARG APP_UID=10001
RUN useradd --uid "${APP_UID}" --create-home --shell /usr/sbin/nologin appuser
WORKDIR /app
RUN apt-get update && apt-get install -y ghostscript python3-tk && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . ./
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 8010
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010"]
