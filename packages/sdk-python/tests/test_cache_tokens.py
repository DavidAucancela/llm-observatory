"""cache_read_tokens is reported by the OpenAI-compatible Python wrappers.

Parity with Node's extractCachedTokensNested/Flat: OpenAI, Grok and DeepInfra
read ``usage.prompt_tokens_details.cached_tokens``; Kimi reads the flat
``usage.cached_tokens``. Covers sync/async x plain/stream for each provider.
"""
import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

MSGS = [{"role": "user", "content": "hi"}]

# module, sync class, sync proxy, async class, async proxy, flat?
PROVIDERS = [
    ("openai", "MonitoredOpenAI", "_ChatProxy", "AsyncMonitoredOpenAI", "_AsyncChatProxy", False),
    ("grok", "MonitoredGrok", "_GrokChatProxy", "AsyncMonitoredGrok", "_AsyncGrokChatProxy", False),
    ("kimi", "MonitoredKimi", "_KimiChatProxy", "AsyncMonitoredKimi", "_AsyncKimiChatProxy", True),
    ("deepinfra", "MonitoredDeepInfra", "_DeepInfraChatProxy", "AsyncMonitoredDeepInfra", "_AsyncDeepInfraChatProxy", False),
]


def _usage(flat, cached):
    u = dict(prompt_tokens=100, completion_tokens=20)
    if flat:
        u["cached_tokens"] = cached
    else:
        u["prompt_tokens_details"] = SimpleNamespace(cached_tokens=cached)
    return SimpleNamespace(**u)


def _response(usage):
    return SimpleNamespace(usage=usage, choices=[])


def _chunk(usage=None):
    return SimpleNamespace(usage=usage, choices=[])


def _build(module, cls, proxy, client):
    mod = importlib.import_module(f"llm_observatory.{module}")
    inst = object.__new__(getattr(mod, cls))
    inst._observatory_url = "http://obs:3001"
    inst._observatory_token = "obs_sk_test"
    inst._tags = {}
    inst._api_key_hint = "sk-…1234"
    inst._client = client
    inst.chat = getattr(mod, proxy)(inst)
    return inst


@pytest.mark.parametrize("module,cls,proxy,acls,aproxy,flat", PROVIDERS)
class TestCacheTokens:
    def test_sync_plain(self, module, cls, proxy, acls, aproxy, flat):
        client = MagicMock()
        client.chat.completions.create.return_value = _response(_usage(flat, 64))
        inst = _build(module, cls, proxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background") as send:
            inst.chat.completions.create(model="m", messages=MSGS)
        metric = send.call_args[0][1]
        assert metric["cache_read_tokens"] == 64
        assert metric["cache_write_tokens"] == 0

    def test_sync_stream(self, module, cls, proxy, acls, aproxy, flat):
        client = MagicMock()
        client.chat.completions.create.return_value = iter([_chunk(), _chunk(_usage(flat, 64))])
        inst = _build(module, cls, proxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background") as send:
            list(inst.chat.completions.create(model="m", messages=MSGS, stream=True))
        assert send.call_args[0][1]["cache_read_tokens"] == 64

    async def test_async_plain(self, module, cls, proxy, acls, aproxy, flat):
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=_response(_usage(flat, 64)))
        inst = _build(module, acls, aproxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background_async", new=AsyncMock()) as send:
            await inst.chat.completions.create(model="m", messages=MSGS)
        assert send.call_args[0][1]["cache_read_tokens"] == 64

    async def test_async_stream(self, module, cls, proxy, acls, aproxy, flat):
        async def gen():
            yield _chunk()
            yield _chunk(_usage(flat, 64))

        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=gen())
        inst = _build(module, acls, aproxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background_async", new=AsyncMock()) as send:
            stream = await inst.chat.completions.create(model="m", messages=MSGS, stream=True)
            [c async for c in stream]
        assert send.call_args[0][1]["cache_read_tokens"] == 64

    def test_missing_or_malformed_cache_field_is_zero(self, module, cls, proxy, acls, aproxy, flat):
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5, prompt_tokens_details=None, cached_tokens="n/a")
        client = MagicMock()
        client.chat.completions.create.return_value = _response(usage)
        inst = _build(module, cls, proxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background") as send:
            inst.chat.completions.create(model="m", messages=MSGS)
        assert send.call_args[0][1]["cache_read_tokens"] == 0

    def test_sync_plain_usage_none_is_zero(self, module, cls, proxy, acls, aproxy, flat):
        client = MagicMock()
        client.chat.completions.create.return_value = _response(None)
        inst = _build(module, cls, proxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background") as send:
            inst.chat.completions.create(model="m", messages=MSGS)
        metric = send.call_args[0][1]
        assert metric["cache_read_tokens"] == 0
        assert metric["input_tokens"] == 0

    def test_sync_stream_usage_none_is_zero(self, module, cls, proxy, acls, aproxy, flat):
        client = MagicMock()
        client.chat.completions.create.return_value = iter([_chunk(), _chunk()])
        inst = _build(module, cls, proxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background") as send:
            list(inst.chat.completions.create(model="m", messages=MSGS, stream=True))
        assert send.call_args[0][1]["cache_read_tokens"] == 0

    async def test_async_plain_usage_none_is_zero(self, module, cls, proxy, acls, aproxy, flat):
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=_response(None))
        inst = _build(module, acls, aproxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background_async", new=AsyncMock()) as send:
            await inst.chat.completions.create(model="m", messages=MSGS)
        assert send.call_args[0][1]["cache_read_tokens"] == 0

    async def test_async_stream_usage_none_is_zero(self, module, cls, proxy, acls, aproxy, flat):
        async def gen():
            yield _chunk()

        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=gen())
        inst = _build(module, acls, aproxy, client)
        with patch(f"llm_observatory.{module}.send_metric_background_async", new=AsyncMock()) as send:
            stream = await inst.chat.completions.create(model="m", messages=MSGS, stream=True)
            [c async for c in stream]
        assert send.call_args[0][1]["cache_read_tokens"] == 0
