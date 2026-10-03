"""Create and restore verifiable local-MVP backups without storing secrets."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


INCLUDED_DIRS = ("artifacts",)
PROJECT_DIRS = ("skills", "files", "cache")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _within(path: Path, root: Path) -> Path:
    resolved, root = path.resolve(), root.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"路径越界: {resolved}")
    return resolved


def backup(project_root: Path, destination: Path) -> Path:
    project_root = project_root.resolve()
    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hybridrag-backup-") as temporary:
        staging = Path(temporary)
        database = project_root / "data" / "app.db"
        if not database.exists():
            raise FileNotFoundError(f"SQLite 不存在: {database}")
        target_db = staging / "data" / "app.db"
        target_db.parent.mkdir(parents=True)
        source_connection = sqlite3.connect(database)
        target_connection = sqlite3.connect(target_db)
        try:
            source_connection.backup(target_connection)
        finally:
            target_connection.close()
            source_connection.close()
        for name in INCLUDED_DIRS:
            source = project_root / "data" / name
            if source.exists():
                shutil.copytree(source, staging / "data" / name)
        for name in PROJECT_DIRS:
            source = project_root / name
            if source.exists():
                shutil.copytree(source, staging / name)
        neo4j_dump = project_root / "data" / "neo4j.dump"
        if neo4j_dump.exists():
            shutil.copy2(neo4j_dump, staging / "data" / "neo4j.dump")
        files = sorted(path for path in staging.rglob("*") if path.is_file())
        manifest = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "schema": 1,
            "files": {path.relative_to(staging).as_posix(): {"sha256": sha256(path), "size": path.stat().st_size} for path in files},
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(staging.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(staging).as_posix())
    return destination


def restore(project_root: Path, archive_path: Path, *, confirm: bool) -> None:
    if not confirm:
        raise ValueError("恢复会覆盖同名本地数据；必须显式传入 --confirm")
    project_root, archive_path = project_root.resolve(), archive_path.resolve()
    if not archive_path.is_file():
        raise FileNotFoundError(archive_path)
    with tempfile.TemporaryDirectory(prefix="hybridrag-restore-") as temporary:
        staging = Path(temporary)
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                _within(staging / member.filename, staging)
            archive.extractall(staging)
        manifest = json.loads((staging / "manifest.json").read_text(encoding="utf-8"))
        for relative, expected in manifest["files"].items():
            source = _within(staging / relative, staging)
            if sha256(source) != expected["sha256"]:
                raise ValueError(f"备份 hash 校验失败: {relative}")
        current_db = project_root / "data" / "app.db"
        if current_db.exists():
            previous = current_db.with_name(f"app.pre-restore-{datetime.now().strftime('%Y%m%d%H%M%S')}.db")
            shutil.copy2(current_db, previous)
        for relative in manifest["files"]:
            if relative == "manifest.json":
                continue
            source = _within(staging / relative, staging)
            target = _within(project_root / relative, project_root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("backup", "restore"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    if args.action == "backup":
        print(backup(args.project_root, args.archive))
    else:
        restore(args.project_root, args.archive, confirm=args.confirm)
        print("restore completed")


if __name__ == "__main__":
    main()
