"""Prefix-cache usage statistics endpoints."""

from fastapi import APIRouter

from deepresearch_agent.models.prefix_cache import tracker

router = APIRouter(tags=["cache"])


@router.get("/cache/stats")
async def cache_stats():
    """返回进程启动以来的前缀缓存命中统计（全局 + 按模型）。"""
    return tracker.global_snapshot()
