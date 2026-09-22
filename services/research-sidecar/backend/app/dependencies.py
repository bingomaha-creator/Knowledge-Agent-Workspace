"""FastAPI dependency accessors."""

from fastapi import Request


def get_database(request: Request):
    return request.app.state.database


def get_run_service(request: Request):
    return request.app.state.run_service


def get_chat_service(request: Request):
    return request.app.state.chat_service


def get_event_stream(request: Request):
    return request.app.state.event_stream


def get_memory_service(request: Request):
    return request.app.state.memory_service


def get_skill_services(request: Request):
    return request.app.state.skill_services
