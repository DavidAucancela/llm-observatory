from __future__ import annotations

import json
import os
import time
from typing import Any, AsyncIterator, Iterator

from ._pricing import _field, calculate_openai_cost, calculate_openai_image_cost
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


# ---------------------------------------------------------------------------
# Images and Responses — shared metric builders (sync and async proxies below)
# ---------------------------------------------------------------------------

def _image_metric(w: Any, method: str, params: dict[str, Any], usage: Any, count: int,
                  start: float, status_code: int, error: Exception | None) -> dict[str, Any]:
    model = params.get("model") or "dall-e-2"  # OpenAI's default when omitted
    input_t = _as_count(_field(usage, "input_tokens", 0))
    output_t = _as_count(_field(usage, "output_tokens", 0))
    cost = None if error else calculate_openai_image_cost(model, usage)
    preview = f"[image {method}] {str(params.get('prompt') or '')[:180]}"
    if count > 1:
        preview = f"{preview[:170]} (×{count})"
    metric = {
        "provider": "openai", "model": model,
        "input_tokens": input_t, "output_tokens": output_t, "total_tokens": input_t + output_t,
        "cost_usd": cost or 0.0,
        "latency_ms": int((time.perf_counter() - start) * 1000),
        "status_code": status_code,
        "tools_used": [f"images.{method}"],
        "prompt_preview": preview,
        "tags": w._tags, "api_key_hint": w._api_key_hint,
    }
    if cost is None and not error:
        metric["cost_confidence"] = "unknown"
    if error:
        metric.update(classify_error(error))
    return metric


def _responses_tools(params: dict[str, Any]) -> list[str]:
    """Built-in tools have only a ``type`` (image_generation, web_search…),
    function tools a ``name``."""
    return [n for n in (_field(t, "name") or _field(t, "type") for t in params.get("tools") or []) if n]


def _responses_preview(params: dict[str, Any]) -> str:
    inp = params.get("input")
    if isinstance(inp, str):
        return inp[:200]
    first = inp[0] if isinstance(inp, list) and inp else ""
    return json.dumps(first, default=str)[:200]


def _responses_metric(w: Any, params: dict[str, Any], response: Any, start: float,
                      status_code: int, error: Exception | None) -> dict[str, Any]:
    usage = _field(response, "usage")
    input_t = _as_count(_field(usage, "input_tokens", 0))
    output_t = _as_count(_field(usage, "output_tokens", 0))
    output = _field(response, "output") or []
    image_calls = sum(1 for o in output if _field(o, "type") == "image_generation_call") if isinstance(output, list) else 0
    preview = _responses_preview(params)
    metric = {
        "provider": "openai", "model": params.get("model"),
        "input_tokens": input_t, "output_tokens": output_t, "total_tokens": input_t + output_t,
        "cost_usd": calculate_openai_cost(params.get("model"), input_t, output_t) if not error else 0.0,
        "latency_ms": int((time.perf_counter() - start) * 1000),
        "status_code": status_code,
        "tools_used": _responses_tools(params),
        "prompt_preview": f"[{image_calls} image(s)] {preview}"[:200] if image_calls else preview,
        "tags": w._tags, "api_key_hint": w._api_key_hint,
    }
    # The image tool is billed on top of usage and not reported, so the cost
    # above only covers text tokens — don't let it pass as exact.
    if image_calls:
        metric["cost_confidence"] = "unknown"
    if error:
        metric.update(classify_error(error))
    return metric


def _status_of(err: Exception) -> int:
    return getattr(err, "status_code", 500) or 500


class _ImagesProxy:
    def __init__(self, wrapper: "MonitoredOpenAI") -> None:
        self._w = wrapper

    def generate(self, **params: Any) -> Any:
        return self._call("generate", params)

    def edit(self, **params: Any) -> Any:
        return self._call("edit", params)

    def create_variation(self, **params: Any) -> Any:
        return self._call("create_variation", params)

    def _send(self, metric: dict[str, Any]) -> None:
        send_metric_background(self._w._observatory_url, metric, token=self._w._observatory_token)

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        start = time.perf_counter()
        try:
            response = getattr(self._w._client.images, method)(**params)
        except Exception as err:
            self._send(_image_metric(self._w, method, params, None, 0, start, _status_of(err), err))
            raise
        if params.get("stream"):
            return self._stream(response, method, params, start)
        data = _field(response, "data") or []
        self._send(_image_metric(self._w, method, params, _field(response, "usage"),
                                 len(data) if isinstance(data, list) else 0, start, 200, None))
        return response

    def _stream(self, raw: Any, method: str, params: dict[str, Any], start: float) -> Iterator[Any]:
        usage, count = None, 0
        try:
            for event in raw:
                etype = _field(event, "type")
                if isinstance(etype, str) and etype.endswith(".completed"):
                    count += 1
                    usage = _field(event, "usage") or usage
                yield event
        finally:
            self._send(_image_metric(self._w, method, params, usage, count, start, 200, None))


class _ResponsesProxy:
    def __init__(self, wrapper: "MonitoredOpenAI") -> None:
        self._w = wrapper

    def _send(self, metric: dict[str, Any]) -> None:
        send_metric_background(self._w._observatory_url, metric, token=self._w._observatory_token)

    def create(self, **params: Any) -> Any:
        start = time.perf_counter()
        try:
            response = self._w._client.responses.create(**params)
        except Exception as err:
            self._send(_responses_metric(self._w, params, None, start, _status_of(err), err))
            raise
        if params.get("stream"):
            return self._stream(response, params, start)
        self._send(_responses_metric(self._w, params, response, start, 200, None))
        return response

    def _stream(self, raw: Any, params: dict[str, Any], start: float) -> Iterator[Any]:
        final = None
        try:
            for event in raw:
                if _field(event, "type") == "response.completed":
                    final = _field(event, "response")
                yield event
        finally:
            self._send(_responses_metric(self._w, params, final, start, 200, None))


class _AsyncImagesProxy:
    def __init__(self, wrapper: "AsyncMonitoredOpenAI") -> None:
        self._w = wrapper

    async def generate(self, **params: Any) -> Any:
        return await self._call("generate", params)

    async def edit(self, **params: Any) -> Any:
        return await self._call("edit", params)

    async def create_variation(self, **params: Any) -> Any:
        return await self._call("create_variation", params)

    async def _send(self, metric: dict[str, Any]) -> None:
        await send_metric_background_async(self._w._observatory_url, metric, token=self._w._observatory_token)

    async def _call(self, method: str, params: dict[str, Any]) -> Any:
        start = time.perf_counter()
        try:
            response = await getattr(self._w._client.images, method)(**params)
        except Exception as err:
            await self._send(_image_metric(self._w, method, params, None, 0, start, _status_of(err), err))
            raise
        if params.get("stream"):
            return self._stream(response, method, params, start)
        data = _field(response, "data") or []
        await self._send(_image_metric(self._w, method, params, _field(response, "usage"),
                                       len(data) if isinstance(data, list) else 0, start, 200, None))
        return response

    async def _stream(self, raw: Any, method: str, params: dict[str, Any], start: float) -> AsyncIterator[Any]:
        usage, count = None, 0
        try:
            async for event in raw:
                etype = _field(event, "type")
                if isinstance(etype, str) and etype.endswith(".completed"):
                    count += 1
                    usage = _field(event, "usage") or usage
                yield event
        finally:
            await self._send(_image_metric(self._w, method, params, usage, count, start, 200, None))


class _AsyncResponsesProxy:
    def __init__(self, wrapper: "AsyncMonitoredOpenAI") -> None:
        self._w = wrapper

    async def _send(self, metric: dict[str, Any]) -> None:
        await send_metric_background_async(self._w._observatory_url, metric, token=self._w._observatory_token)

    async def create(self, **params: Any) -> Any:
        start = time.perf_counter()
        try:
            response = await self._w._client.responses.create(**params)
        except Exception as err:
            await self._send(_responses_metric(self._w, params, None, start, _status_of(err), err))
            raise
        if params.get("stream"):
            return self._stream(response, params, start)
        await self._send(_responses_metric(self._w, params, response, start, 200, None))
        return response

    async def _stream(self, raw: Any, params: dict[str, Any], start: float) -> AsyncIterator[Any]:
        final = None
        try:
            async for event in raw:
                if _field(event, "type") == "response.completed":
                    final = _field(event, "response")
                yield event
        finally:
            await self._send(_responses_metric(self._w, params, final, start, 200, None))


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
        self.images             = _ImagesProxy(self)
        self.responses          = _ResponsesProxy(self)


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
        self.images             = _AsyncImagesProxy(self)
        self.responses          = _AsyncResponsesProxy(self)
