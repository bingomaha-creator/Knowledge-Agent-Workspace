"""Create the complete local MVP persistence schema.

Revision ID: 20260815_0001
Revises: None
"""

from alembic import op

from deepresearch_agent.persistence.fts import FTS_STATEMENTS
from deepresearch_agent.persistence.models import Base

revision = "20260815_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)
    for statement in FTS_STATEMENTS:
        bind.exec_driver_sql(statement)


def downgrade() -> None:
    bind = op.get_bind()
    for trigger in ("messages_fts_ai", "messages_fts_ad", "messages_fts_au", "sessions_fts_ai", "sessions_fts_ad", "sessions_fts_au", "memories_fts_ai", "memories_fts_ad", "memories_fts_au"):
        bind.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger}")
    for table in ("messages_fts", "sessions_fts", "memories_fts"):
        bind.exec_driver_sql(f"DROP TABLE IF EXISTS {table}")
    Base.metadata.drop_all(bind=bind)
