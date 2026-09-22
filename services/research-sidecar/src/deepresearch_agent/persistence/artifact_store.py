"""Content-addressed, path-confined artifact writes."""

import hashlib
import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

from deepresearch_agent.harness.errors import AppError, ErrorCode


@dataclass(frozen=True)
class StoredArtifact:
    artifact_id: str
    relative_path: str
    mime_type: str
    size_bytes: int
    sha256: str


class ArtifactStore:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, relative_path: str | Path) -> Path:
        candidate = (self.root / relative_path).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise AppError(ErrorCode.ARTIFACT_PATH_INVALID, "Artifact 路径超出允许根目录") from exc
        return candidate

    def write_bytes(self, relative_path: str | Path, content: bytes, *, mime_type: str = "application/octet-stream") -> StoredArtifact:
        target = self._resolve(relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        file_descriptor, temporary_name = tempfile.mkstemp(prefix=".artifact-", dir=str(target.parent))
        try:
            with os.fdopen(file_descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, target)
        except Exception:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
            raise
        digest = hashlib.sha256(content).hexdigest()
        return StoredArtifact(
            artifact_id=f"art_{uuid.uuid4().hex}",
            relative_path=target.relative_to(self.root).as_posix(),
            mime_type=mime_type,
            size_bytes=len(content),
            sha256=digest,
        )

    def write_text(self, relative_path: str | Path, content: str, *, mime_type: str = "text/plain; charset=utf-8") -> StoredArtifact:
        return self.write_bytes(relative_path, content.encode("utf-8"), mime_type=mime_type)

    def verify(self, relative_path: str | Path, expected_sha256: str) -> bool:
        target = self._resolve(relative_path)
        if not target.is_file():
            return False
        return hashlib.sha256(target.read_bytes()).hexdigest() == expected_sha256

    def read_bytes(self, relative_path: str | Path) -> bytes:
        return self._resolve(relative_path).read_bytes()
