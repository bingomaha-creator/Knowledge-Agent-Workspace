"""FTS5 tables and synchronization triggers shared by migration and test setup."""

from sqlalchemy import text


FTS_STATEMENTS = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, content, tokenize='trigram')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(session_id UNINDEXED, title, summary, tokenize='trigram')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, content, tokenize='trigram')",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(message_id,session_id,content) VALUES(new.message_id,new.session_id,new.content); END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE message_id=old.message_id; END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN DELETE FROM messages_fts WHERE message_id=old.message_id; INSERT INTO messages_fts(message_id,session_id,content) VALUES(new.message_id,new.session_id,new.content); END",
    "CREATE TRIGGER IF NOT EXISTS sessions_fts_ai AFTER INSERT ON sessions BEGIN INSERT INTO sessions_fts(session_id,title,summary) VALUES(new.session_id,new.title,coalesce(new.summary_json,'')); END",
    "CREATE TRIGGER IF NOT EXISTS sessions_fts_ad AFTER DELETE ON sessions BEGIN DELETE FROM sessions_fts WHERE session_id=old.session_id; END",
    "CREATE TRIGGER IF NOT EXISTS sessions_fts_au AFTER UPDATE ON sessions BEGIN DELETE FROM sessions_fts WHERE session_id=old.session_id; INSERT INTO sessions_fts(session_id,title,summary) VALUES(new.session_id,new.title,coalesce(new.summary_json,'')); END",
    "CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(memory_id,content) VALUES(new.memory_id,new.content); END",
    "CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE memory_id=old.memory_id; END",
    "CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN DELETE FROM memories_fts WHERE memory_id=old.memory_id; INSERT INTO memories_fts(memory_id,content) VALUES(new.memory_id,new.content); END",
)


async def install_fts(async_connection) -> None:
    for statement in FTS_STATEMENTS:
        await async_connection.execute(text(statement))
