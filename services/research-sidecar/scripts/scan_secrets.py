"""Fail when configured secrets appear in persisted/runtime or frontend output files."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


SECRET_NAMES = {"OPENAI_API_KEY", "TAVILY_API_KEY", "NEO4J_PASSWORD", "LANGSMITH_API_KEY"}


def configured_secrets(env_path: Path) -> set[str]:
    secrets = set()
    if not env_path.exists():
        return secrets
    for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        name, value = line.split("=", 1)
        value = value.strip().strip("'\"")
        if name.strip() in SECRET_NAMES and len(value) >= 8:
            secrets.add(value)
    return secrets


def scan(root: Path, paths: list[Path], *, strict_patterns: bool = False) -> list[str]:
    secrets = configured_secrets(root / ".env")
    token_pattern = re.compile(rb"(?<![A-Za-z0-9_])(?:sk|tvly)-[A-Za-z0-9_-]{16,}")
    hits = []
    for relative in paths:
        target = (root / relative).resolve()
        if not target.exists():
            continue
        files = [target] if target.is_file() else [path for path in target.rglob("*") if path.is_file()]
        for path in files:
            if path.stat().st_size > 50 * 1024 * 1024:
                continue
            content = path.read_bytes()
            if (strict_patterns and token_pattern.search(content)) or any(secret.encode("utf-8") in content for secret in secrets):
                hits.append(path.relative_to(root).as_posix())
    return hits


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="*", type=Path, default=[Path("frontend/dist"), Path("data/acceptance")])
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--strict-patterns", action="store_true", help="also reject any token-shaped external/sample text")
    args = parser.parse_args()
    hits = scan(args.project_root.resolve(), args.paths, strict_patterns=args.strict_patterns)
    if hits:
        print("Secret scan failed in: " + ", ".join(hits))
        raise SystemExit(1)
    print(f"Secret scan passed ({len(args.paths)} targets, configured values never printed).")


if __name__ == "__main__":
    main()
