"""Validated DTOs for the stage 1 persistence boundary."""

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from deepresearch_agent.harness.contracts import RunStatus, SourceMode, WorkflowMode


class PersistenceDTO(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class SessionCreate(PersistenceDTO):
    title: str = Field(default="新对话", min_length=1, max_length=200)


class SessionRead(PersistenceDTO):
    session_id: str
    title: str
    status: str
    summary_json: Optional[str] = None
    memory_snapshot_version: Optional[int] = None
    memory_snapshot_created_at: Optional[str] = None
    created_at: str
    updated_at: str
    archived_at: Optional[str] = None


class MessageCreate(PersistenceDTO):
    session_id: str
    role: Literal["user", "assistant", "system"]
    content: str = Field(min_length=1)
    run_id: Optional[str] = None
    client_message_id: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class MessageRead(PersistenceDTO):
    message_id: str
    session_id: str
    run_id: Optional[str] = None
    client_message_id: Optional[str] = None
    role: str
    content: str
    metadata_json: str
    created_at: str


class RunCreate(PersistenceDTO):
    session_id: str
    trigger_message_id: str
    source_mode: SourceMode
    workflow_mode: WorkflowMode
    config_snapshot: Dict[str, Any] = Field(default_factory=dict)
    budget: Dict[str, Any] = Field(default_factory=dict)


class RunRead(PersistenceDTO):
    run_id: str
    session_id: str
    trigger_message_id: str
    source_mode: str
    workflow_mode: str
    status: str
    current_stage: Optional[str] = None
    created_at: str
    updated_at: str


class RunEventCreate(PersistenceDTO):
    run_id: str
    event_type: str
    stage: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)


class CheckpointRead(PersistenceDTO):
    checkpoint_id: str
    run_id: str
    version: int
    stage: str
    state_json: str
    state_hash: str
    created_at: str
