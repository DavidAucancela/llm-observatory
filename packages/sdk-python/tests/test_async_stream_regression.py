"""Regression: Async*.create(stream=True) must return an awaited async generator.

`_create_stream` is `async def` with no `yield`, so returning it without `await`
handed callers an un-awaited coroutine (`async for` -> TypeError: 'coroutine'
object is not async iterable). Same bug fixed earlier for DeepInfra.
"""
import inspect
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def _chunks():
    out = []
    for _ in range(2):
        c = MagicMock()
        c.usage = None
        c.choices = []
        out.append(c)
    return out


async def _fake_stream():
    for c in _chunks():
        yield c


CASES = [
    ("openai", "AsyncMonitoredOpenAI", "_AsyncChatProxy", "chat"),
    ("grok", "AsyncMonitoredGrok", "_AsyncGrokChatProxy", "chat"),
    ("kimi", "AsyncMonitoredKimi", "_AsyncKimiChatProxy", "chat"),
]


@pytest.mark.parametrize("module,cls,proxy,attr", CASES)
async def test_openai_compatible_async_stream_is_awaited(module, cls, proxy, attr):
    mod = __import__(f"llm_observatory.{module}", fromlist=[cls])
    instance = object.__new__(getattr(mod, cls))
    instance._observatory_url = "http://obs:3001"
    instance._observatory_token = "obs_sk_test"
    instance._tags = {}
    instance._api_key_hint = "sk-…1234"
    instance._client = MagicMock()
    instance._client.chat.completions.create = AsyncMock(return_value=_fake_stream())
    setattr(instance, attr, getattr(mod, proxy)(instance))

    with patch(f"llm_observatory.{module}.send_metric_background_async", new=AsyncMock()):
        stream = await instance.chat.completions.create(
            model="m", messages=[{"role": "user", "content": "hi"}], stream=True
        )
        assert not inspect.iscoroutine(stream)
        result = [c async for c in stream]

    assert len(result) == 2


async def test_anthropic_async_stream_is_awaited():
    from llm_observatory import anthropic as mod

    instance = object.__new__(mod.AsyncMonitoredAnthropic)
    instance._observatory_url = "http://obs:3001"
    instance._observatory_token = "obs_sk_test"
    instance._tags = {}
    instance._api_key_hint = "sk-ant-…1234"
    instance._client = MagicMock()
    instance._client.messages.create = AsyncMock(return_value=_fake_stream())
    instance.messages = mod._AsyncMessagesProxy(instance)

    with patch("llm_observatory.anthropic.send_metric_background_async", new=AsyncMock()):
        stream = await instance.messages.create(
            model="m", max_tokens=10, messages=[{"role": "user", "content": "hi"}], stream=True
        )
        assert not inspect.iscoroutine(stream)
        result = [c async for c in stream]

    assert len(result) == 2
