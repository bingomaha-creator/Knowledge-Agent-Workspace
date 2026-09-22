FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src
WORKDIR /app

COPY requirements.txt alembic.ini ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY src/deepresearch_agent ./src/deepresearch_agent
COPY skills ./skills

EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --workers 1"]
