from __future__ import annotations

import json
import os
import time
from typing import Any, AsyncIterator, Iterator

from ._pricing import calculate_openai_cost
from ._utils import (
    classify_error,
    extract_full_prompt,
    extract_openai_response_details,
    extract_prompt_preview,
    extract_request_params,
    extract_system_prompt_openai,
    mask_key,
    send_metric_background,
    send_metric_background_async,
    truncate,
)


def _as_count(value: Any) -> int:
    """Coerce a usage field to a non-negative int; anything else (missing, None,
    a string, a mock) becomes 0 so a malformed response can't break the metric."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _cached_tokens_nested(usage: Any) -> int:
    """Cached prompt tokens at ``usage.prompt_tokens_details.cached_tokens``
    (OpenAI, Grok, DeepInfra). Mirrors Node's extractCachedTokensNested."""
    return _as_count(getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0))


def _cached_tokens_flat(usage: Any) -> int:
    """Cached prompt tokens at ``usage.cached_tokens`` (Kimi/Moonshot).
    Mirrors Node's extractCachedTokensFlat."""
    return _as_count(getattr(usage, "cached_tokens", 0))


def _accumulate_stream_delta(chunk: Any, text_parts: list[str], tool_calls_map: dict[int, dict[str, str]]) -> str | None:
    """Feed one streaming chunk into the accumulators; returns finish_reason if present.
    OpenAI streams tool_calls as fragments (index + partial `arguments` string) across
    multiple chunks — must be concatenated per-index and JSON-parsed only at the end."""
    choices = getattr(chunk, "choices", None)
    choice = choices[0] if isinstance(choices, list) and choices else None
    if not choice:
        return None
    delta = getattr(choice, "delta", None)
    if delta is not None:
        content = getattr(delta, "content", None)
        if isinstance(content, str):
            text_parts.append(content)
        raw_tool_calls = getattr(delta, "tool_calls", None)
        for tc in (raw_tool_calls if isinstance(raw_tool_calls, list) else []):
            idx = getattr(tc, "index", 0)
            entry = tool_calls_map.setdefault(idx, {"name": "", "arguments": ""})
            fn = getattr(tc, "function", None)
            if fn is not None:
                name = getattr(fn, "name", None)
                if isinstance(name, str):
                    entry["name"] = name
                args_fragment = getattr(fn, "arguments", None)
                if isinstance(args_fragment, str):
                    entry["arguments"] += args_fragment
    finish_reason = getattr(choice, "finish_reason", None)
    return finish_reason if isinstance(finish_reason, str) else None


def _finalize_stream_response(text_parts: list[str], tool_calls_map: dict[int, dict[str, str]]) -> dict[str, Any]:
    tool_calls = []
    for entry in tool_calls_map.values():
        try:
            args = json.loads(entry["arguments"]) if entry["arguments"] else None
        except (TypeError, ValueError):
            args = entry["arguments"]
        tool_calls.append({"name": entry["name"], "arguments": args})
    return {"response_full": truncate("".join(text_parts), 20000), "tool_calls": tool_calls}


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------

class _CompletionsProxy:
    def __init__(self, wrapper: "MonitoredOpenAI") -> None:
        self._w = wrapper

    def create(self, **params: Any) -> Any:
        start = time.perf_counter()
        prompt_preview = extract_prompt_preview(params.get("messages", []))
        tools = [
            t.get("function", {}).get("name") or t.get("name", "")
            for t in params.get("tools", [])
        ]
        request_details = {
            "prompt_full":    extract_full_prompt(params.get("messages", [])),
            "system_prompt":  extract_system_prompt_openai(params.get("messages", [])),
            "request_params": extract_request_params(params),
        }

        if params.get("stream"):
            return self._create_stream(params, start, prompt_preview, tools, request_details)

        response = None
        status_code = 200
        error = None

        try:
            response = self._w._client.chat.completions.create(**params)
        except Exception as err:
            status_code = getattr(err, "status_code", 500) or 500
            error = err

        usage = getattr(response, "usage", None) if response else None
        input_t  = getattr(usage, "prompt_tokens",     0) if usage else 0
        output_t = getattr(usage, "completion_tokens", 0) if usage else 0
        cache_t  = _cached_tokens_nested(usage) if usage else 0
        response_details = extract_openai_response_details(response) if response else {
            "response_full": None, "tool_calls": [], "stop_reason": None,
        }

        metric = {
            "provider":       "openai",
            "model":          params["model"],
            "input_tokens":   input_t,
            "output_tokens":  output_t,
            "total_tokens":   input_t + output_t,
            "cache_read_tokens":  cache_t,
            "cache_write_tokens": 0,
            "cost_usd":       calculate_openai_cost(params["model"], input_t, output_t),
            "latency_ms":     int((time.perf_counter() - start) * 1000),
            "status_code":    status_code,
            "tools_used":     tools,
            "prompt_preview": prompt_preview,
            "tags":           self._w._tags,
            "api_key_hint":   self._w._api_key_hint,
            **request_details,
            **response_details,
        }
        if error:
            metric.update(classify_error(error))

        send_metric_background(self._w._observatory_url, metric, token=self._w._observatory_token)

        if error:
            raise error
        return response

    def _create_stream(
        self,
        params: dict[str, Any],
        start: float,
        prompt_preview: str,
        tools: list[str],
        request_details: dict[str, Any],
    ) -> Iterator[Any]:
        # include_usage ensures the final chunk carries token counts
        stream_params = {
            **params,
            "stream_options": {"include_usage": True, **params.get("stream_options", {})},
        }

        try:
            raw_stream = self._w._client.chat.completions.create(**stream_params)
        except Exception as err:
            metric = {
                "provider": "openai", "model": params["model"],
                "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0,
                "latency_ms": int((time.perf_counter() - start) * 1000),
                "status_code": getattr(err, "status_code", 500) or 500,
                "tools_used": tools, "prompt_preview": prompt_preview,
                "tags": self._w._tags, "api_key_hint": self._w._api_key_hint,
                **request_details,
                **classify_error(err),
            }
            send_metric_background(self._w._observatory_url, metric, token=self._w._observatory_token)
            raise

        return self._stream_generator(raw_stream, params, start, prompt_preview, tools, request_details)

    def _stream_generator(
        self,
        raw_stream: Any,
        params: dict[str, Any],
        start: float,
        prompt_preview: str,
        tools: list[str],
        request_details: dict[str, Any],
    ) -> Iterator[Any]:
        input_t = output_t = cache_t = 0
        text_parts: list[str] = []
        tool_calls_map: dict[int, dict[str, str]] = {}
        stop_reason = None
        try:
            for chunk in raw_stream:
                usage = getattr(chunk, "usage", None)
                if usage:
                    input_t  = getattr(usage, "prompt_tokens",     input_t)
                    output_t = getattr(usage, "completion_tokens", output_t)
                    cache_t  = _cached_tokens_nested(usage)
                finish_reason = _accumulate_stream_delta(chunk, text_parts, tool_calls_map)
                stop_reason = finish_reason or stop_reason
                yield chunk
        finally:
            response_details = {**_finalize_stream_response(text_parts, tool_calls_map), "stop_reason": stop_reason}
            send_metric_background(self._w._observatory_url, {
                "provider":       "openai",
                "model":          params["model"],
                "input_tokens":   input_t,
                "output_tokens":  output_t,
                "total_tokens":   input_t + output_t,
                "cache_read_tokens":  cache_t,
                "cache_write_tokens": 0,
                "cost_usd":       calculate_openai_cost(params["model"], input_t, output_t),
                "latency_ms":     int((time.perf_counter() - start) * 1000),
                "status_code":    200,
                "tools_used":     tools,
                "prompt_preview": prompt_preview,
                "tags":           self._w._tags,
                "api_key_hint":   self._w._api_key_hint,
                **request_details,
                **response_details,
            }, token=self._w._observatory_token)


class _ChatProxy:
    def __init__(self, wrapper: "MonitoredOpenAI") -> None:
        self.completions = _CompletionsProxy(wrapper)


class MonitoredOpenAI:
    """Drop-in replacement for openai.OpenAI with Observatory metrics."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        observatory_url: str = "http://localhost:3001",
        observatory_token: str | None = None,
        tags: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            from openai import OpenAI as _OpenAI
        except ImportError as e:
            raise ImportError(
                "openai package is required for MonitoredOpenAI. "
                'Install it with: pip install "llm-observatory[openai]"'
            ) from e

        resolved_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self._observatory_url   = observatory_url
        self._observatory_token = observatory_token
        self._tags              = tags or {}
        self._api_key_hint      = mask_key(resolved_key)
        self._client            = _OpenAI(api_key=api_key, **kwargs)
        self.chat               = _ChatProxy(self)


# ---------------------------------------------------------------------------
# Async
# ---------------------------------------------------------------------------

class _AsyncCompletionsProxy:
    def __init__(self, wrapper: "AsyncMonitoredOpenAI") -> None:
        self._w = wrapper

    async def create(self, **params: Any) -> Any:
        start = time.perf_counter()
        prompt_preview = extract_prompt_preview(params.get("messages", []))
        tools = [
            t.get("function", {}).get("name") or t.get("name", "")
            for t in params.get("tools", [])
        ]
        request_details = {
            "prompt_full":    extract_full_prompt(params.get("messages", [])),
            "system_prompt":  extract_system_prompt_openai(params.get("messages", [])),
            "request_params": extract_request_params(params),
        }

        if params.get("stream"):
            return await self._create_stream(params, start, prompt_preview, tools, request_details)

        response = None
        status_code = 200
        error = None

        try:
            response = await self._w._client.chat.completions.create(**params)
        except Exception as err:
            status_code = getattr(err, "status_code", 500) or 500
            error = err

        usage = getattr(response, "usage", None) if response else None
        input_t  = getattr(usage, "prompt_tokens",     0) if usage else 0
        output_t = getattr(usage, "completion_tokens", 0) if usage else 0
        cache_t  = _cached_tokens_nested(usage) if usage else 0
        response_details = extract_openai_response_details(response) if response else {
            "response_full": None, "tool_calls": [], "stop_reason": None,
        }

        metric = {
            "provider":       "openai",
            "model":          params["model"],
            "input_tokens":   input_t,
            "output_tokens":  output_t,
            "total_tokens":   input_t + output_t,
            "cache_read_tokens":  cache_t,
            "cache_write_tokens": 0,
            "cost_usd":       calculate_openai_cost(params["model"], input_t, output_t),
            "latency_ms":     int((time.perf_counter() - start) * 1000),
            "status_code":    status_code,
            "tools_used":     tools,
            "prompt_preview": prompt_preview,
            "tags":           self._w._tags,
            "api_key_hint":   self._w._api_key_hint,
            **request_details,
            **response_details,
        }
        if error:
            metric.update(classify_error(error))

        await send_metric_background_async(self._w._observatory_url, metric, token=self._w._observatory_token)

        if error:
            raise error
        return response

    async def _create_stream(
        self,
        params: dict[str, Any],
        start: float,
        prompt_preview: str,
        tools: list[str],
        request_details: dict[str, Any],
    ) -> AsyncIterator[Any]:
        stream_params = {
            **params,
            "stream_options": {"include_usage": True, **params.get("stream_options", {})},
        }

        try:
            raw_stream = await self._w._client.chat.completions.create(**stream_params)
        except Exception as err:
            metric = {
                "provider": "openai", "model": params["model"],
                "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0,
                "latency_ms": int((time.perf_counter() - start) * 1000),
                "status_code": getattr(err, "status_code", 500) or 500,
                "tools_used": tools, "prompt_preview": prompt_preview,
                "tags": self._w._tags, "api_key_hint": self._w._api_key_hint,
                **request_details,
                **classify_error(err),
            }
            await send_metric_background_async(self._w._observatory_url, metric, token=self._w._observatory_token)
            raise

        return self._stream_generator(raw_stream, params, start, prompt_preview, tools, request_details)

    async def _stream_generator(
        self,
        raw_stream: Any,
        params: dict[str, Any],
        start: float,
        prompt_preview: str,
        tools: list[str],
        request_details: dict[str, Any],
    ) -> AsyncIterator[Any]:
        input_t = output_t = cache_t = 0
        text_parts: list[str] = []
        tool_calls_map: dict[int, dict[str, str]] = {}
        stop_reason = None
        try:
            async for chunk in raw_stream:
                usage = getattr(chunk, "usage", None)
                if usage:
                    input_t  = getattr(usage, "prompt_tokens",     input_t)
                    output_t = getattr(usage, "completion_tokens", output_t)
                    cache_t  = _cached_tokens_nested(usage)
                finish_reason = _accumulate_stream_delta(chunk, text_parts, tool_calls_map)
                stop_reason = finish_reason or stop_reason
                yield chunk
        finally:
            response_details = {**_finalize_stream_response(text_parts, tool_calls_map), "stop_reason": stop_reason}
            await send_metric_background_async(self._w._observatory_url, {
                "provider":       "openai",
                "model":          params["model"],
                "input_tokens":   input_t,
                "output_tokens":  output_t,
                "total_tokens":   input_t + output_t,
                "cache_read_tokens":  cache_t,
                "cache_write_tokens": 0,
                "cost_usd":       calculate_openai_cost(params["model"], input_t, output_t),
                "latency_ms":     int((time.perf_counter() - start) * 1000),
                "status_code":    200,
                "tools_used":     tools,
                "prompt_preview": prompt_preview,
                "tags":           self._w._tags,
                "api_key_hint":   self._w._api_key_hint,
                **request_details,
                **response_details,
            }, token=self._w._observatory_token)


class _AsyncChatProxy:
    def __init__(self, wrapper: "AsyncMonitoredOpenAI") -> None:
        self.completions = _AsyncCompletionsProxy(wrapper)


class AsyncMonitoredOpenAI:
    """Drop-in replacement for openai.AsyncOpenAI with Observatory metrics."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        observatory_url: str = "http://localhost:3001",
        observatory_token: str | None = None,
        tags: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            from openai import AsyncOpenAI as _AsyncOpenAI
        except ImportError as e:
            raise ImportError(
                "openai package is required for AsyncMonitoredOpenAI. "
                'Install it with: pip install "llm-observatory[openai]"'
            ) from e

        resolved_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self._observatory_url   = observatory_url
        self._observatory_token = observatory_token
        self._tags              = tags or {}
        self._api_key_hint      = mask_key(resolved_key)
        self._client            = _AsyncOpenAI(api_key=api_key, **kwargs)
        self.chat               = _AsyncChatProxy(self)
