from __future__ import annotations

from deepresearch_agent.models.bailian_embeddings import (
    BailianOpenAIEmbeddings,
    is_bailian_compatible_url,
)


class _FakeEmbeddingsClient:
    def __init__(self) -> None:
        self.inputs = []

    def create(self, *, input, **kwargs):
        self.inputs.append(input)
        return {
            "data": [
                {"embedding": [float(index), 1.0]}
                for index, _ in enumerate(input)
            ]
        }


class _FakeAsyncEmbeddingsClient:
    async def create(self, *, input, **kwargs):
        return {
            "data": [
                {"embedding": [float(index), 1.0]}
                for index, _ in enumerate(input)
            ]
        }


def test_bailian_url_detection() -> None:
    assert is_bailian_compatible_url(
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    )
    assert is_bailian_compatible_url(
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    assert not is_bailian_compatible_url("https://api.openai.com/v1")


def test_bailian_adapter_preserves_string_inputs() -> None:
    client = _FakeEmbeddingsClient()
    embeddings = BailianOpenAIEmbeddings(
        model="text-embedding-v4",
        api_key="test-key",
        base_url="https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        client=client,
        async_client=_FakeAsyncEmbeddingsClient(),
    )

    vectors = embeddings.embed_documents(["alpha", "beta"])

    assert vectors == [[0.0, 1.0], [1.0, 1.0]]
    assert client.inputs == [["alpha", "beta"]]
    assert all(isinstance(item, str) for item in client.inputs[0])


def test_bailian_adapter_splits_requests_at_ten_texts() -> None:
    client = _FakeEmbeddingsClient()
    embeddings = BailianOpenAIEmbeddings(
        model="text-embedding-v4",
        api_key="test-key",
        base_url="https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        client=client,
        async_client=_FakeAsyncEmbeddingsClient(),
    )
    texts = [f"text-{index}" for index in range(23)]

    vectors = embeddings.embed_documents(texts)

    assert len(vectors) == 23
    assert [len(batch) for batch in client.inputs] == [10, 10, 3]
    assert [item for batch in client.inputs for item in batch] == texts


def test_bailian_adapter_honors_configured_dimensions_and_batch_size() -> None:
    client = _FakeEmbeddingsClient()
    embeddings = BailianOpenAIEmbeddings(
        model="text-embedding-v2",
        dimensions=1536,
        chunk_size=25,
        api_key="test-key",
        base_url="https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        client=client,
        async_client=_FakeAsyncEmbeddingsClient(),
    )
    texts = [f"text-{index}" for index in range(26)]

    embeddings.embed_documents(texts)

    assert embeddings.dimensions == 1536
    assert embeddings.chunk_size == 25
    assert [len(batch) for batch in client.inputs] == [25, 1]
