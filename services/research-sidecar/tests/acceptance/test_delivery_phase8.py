import re
import sqlite3
from pathlib import Path

import yaml

from scripts.backup_restore import backup, restore


ROOT = Path(__file__).resolve().parents[2]


def test_compose_packages_three_loopback_services_and_persistent_data():
    compose = yaml.safe_load((ROOT / "docker-compose.yaml").read_text(encoding="utf-8"))
    assert set(compose["services"]) == {"neo4j", "backend", "frontend"}
    for service in compose["services"].values():
        for port in service.get("ports", []):
            assert str(port).startswith("127.0.0.1:")
    backend_volumes = set(compose["services"]["backend"]["volumes"])
    assert {"./data:/app/data", "./skills:/app/skills", "./files:/app/files", "./cache:/app/cache"}.issubset(backend_volumes)
    assert compose["services"]["backend"]["environment"]["FASTAPI_WORKERS"] == "1"
    assert compose["services"]["frontend"]["ports"] == ["127.0.0.1:${FRONTEND_PORT:-5173}:80"]
    assert "${FRONTEND_PORT:-5173}" in compose["services"]["backend"]["environment"]["FRONTEND_ORIGINS"]


def test_delivery_files_and_configuration_are_complete():
    required = [
        "backend/Dockerfile", "frontend/Dockerfile", "frontend/nginx.conf",
        "scripts/start-local.ps1", "scripts/stop-local.ps1", "scripts/backup-local.ps1",
        "scripts/restore-local.ps1", "scripts/backup_restore.py",
        "docs/acceptance/acceptance-matrix.md", "docs/acceptance/scenario-template.md",
    ]
    assert all((ROOT / item).is_file() for item in required)
    env = (ROOT / ".env.example").read_text(encoding="utf-8")
    for name in ("APP_DATABASE_URL", "ARTIFACT_ROOT", "SKILLS_ROOT", "TAVILY_API_KEY", "FASTAPI_WORKERS", "FRONTEND_PORT", "CONTEXT_MAX_CHARS", "RUN_MAX_TOOL_CALLS"):
        assert re.search(rf"(?m)^{name}\s*=", env)
    assert not re.search(r"(?m)^(?:OPENAI_API_KEY|TAVILY_API_KEY)[ \t]*=[ \t]*\S+", env)


def test_acceptance_matrix_contains_every_design_must_id_once():
    text = (ROOT / "docs" / "acceptance" / "acceptance-matrix.md").read_text(encoding="utf-8")
    expected = {
        *(f"HAR-{i:02d}" for i in range(1, 13)), *(f"LOOP-{i:02d}" for i in range(1, 9)),
        *(f"SES-{i:02d}" for i in range(1, 10)), *(f"MEM-{i:02d}" for i in range(1, 11)),
        *(f"EVO-{i:02d}" for i in range(1, 11)), *(f"SRC-{i:02d}" for i in range(1, 12)),
        *(f"WEB-{i:02d}" for i in range(1, 11)), *(f"QLT-{i:02d}" for i in range(1, 10)),
        *(f"LOC-{i:02d}" for i in range(1, 9)),
    }
    found = re.findall(r"\b(?:HAR|LOOP|SES|MEM|EVO|SRC|WEB|QLT|LOC)-\d{2}\b", text)
    assert len(expected) == 87
    assert set(found) == expected
    assert len(found) == 87


def test_backup_restore_verifies_hashes_and_recovers_local_state(tmp_path):
    project = tmp_path / "project"
    (project / "data" / "artifacts" / "run_1").mkdir(parents=True)
    (project / "skills" / "research" / "demo").mkdir(parents=True)
    (project / "files").mkdir()
    (project / "cache").mkdir()
    database = project / "data" / "app.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT)")
    connection.execute("INSERT INTO sessions VALUES('s1', 'original')")
    connection.commit()
    connection.close()
    (project / "data" / "artifacts" / "run_1" / "report.md").write_text("verified report", encoding="utf-8")
    (project / "skills" / "research" / "demo" / "SKILL.md").write_text("skill v1", encoding="utf-8")
    archive = backup(project, tmp_path / "backup.zip")
    connection = sqlite3.connect(database)
    connection.execute("UPDATE sessions SET title='changed'")
    connection.commit()
    connection.close()
    (project / "data" / "artifacts" / "run_1" / "report.md").write_text("changed", encoding="utf-8")
    restore(project, archive, confirm=True)
    connection = sqlite3.connect(database)
    assert connection.execute("SELECT title FROM sessions WHERE id='s1'").fetchone()[0] == "original"
    connection.close()
    assert (project / "data" / "artifacts" / "run_1" / "report.md").read_text(encoding="utf-8") == "verified report"
    assert list((project / "data").glob("app.pre-restore-*.db"))


def test_frontend_and_checked_in_delivery_files_do_not_embed_keys():
    paths = list((ROOT / "frontend" / "src").rglob("*")) + [ROOT / "docker-compose.yaml", ROOT / "README.md"]
    content = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in paths if path.is_file())
    assert not re.search(r"(?<![A-Za-z0-9_])(?:sk|tvly)-[A-Za-z0-9_-]{16,}\b", content)
