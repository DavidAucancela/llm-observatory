from __future__ import annotations

import math
import os
import time
from typing import Any, AsyncIterator, Iterator

from ._pricing import calculate_deepinfra_cost
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
)
from .openai import _accumulate_stream_delta, _finalize_stream_response

# DeepInfra exposes an OpenAI-compatible chat.completions API — same
# request/response shape, streamed the same way — so this module reuses the
# OpenAI SDK itself (pointed at DeepInfra's baseURL) plus the stream-
# accumulation helpers from openai.py. See kimi.py / grok.py for the siblings.

DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai"


def _reported_cost(usage: Any) -> float | None:
    """The billed cost DeepInfra reports in USD as ``usage.estimated_cost``
    (verified against a live response 2026-09-23; not in their public docs).
    ``estimated_cost_usd`` is kept as a defensive alternate spelling. Only
    trust a finite, non-negative number — anything else (missing, a string, a
    mock) returns None and the caller falls back to the pricing table."""
    if usage is None:
        return None
    raw = getattr(usage, "estimated_cost", None)
    if raw is None:
        raw = getattr(usage, "estimated_cost_usd", None)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    return float(raw) if math.isfinite(raw) and raw >= 0 else None


def _resolve_cost(usage: Any, model: str, input_t: int, output_t: int) -> float:
    reported = _reported_cost(usage)
    return reported if reported is not None else calculate_deepinfra_cost(model, input_t, output_t)


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------

class _DeepInfraCompletionsProxy:
    def __init__(self, wrapper: "MonitoredDeepInfra") -> None:
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
        response_details = extract_openai_response_details(response) if response else {
            "response_full": None, "tool_calls": [], "stop_reason": None,
        }

        metric = {
            "provider":       "deepinfra",
            "model":          params["model"],
            "input_tokens":   input_t,
            "output_tokens":  output_t,
            "total_tokens":   input_t + output_t,
            "cost_usd":       _resolve_cost(usage, params["model"], input_t, output_t),
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
        stream_params = {
            **params,
            "stream_options": {"include_usage": True, **params.get("stream_options", {})},
        }

        try:
            raw_stream = self._w._client.chat.completions.create(**stream_params)
        except Exception as err:
            metric = {
                "provider": "deepinfra", "model": params["model"],
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
        input_t = output_t = 0
        last_usage: Any = None
        text_parts: list[str] = []
        tool_calls_map: dict[int, dict[str, str]] = {}
        stop_reason = None
        try:
            for chunk in raw_stream:
                usage = getattr(chunk, "usage", None)
                if usage:
                    last_usage = usage
                    input_t  = getattr(usage, "prompt_tokens",     input_t)
                    output_t = getattr(usage, "completion_tokens", output_t)
                finish_reason = _accumulate_stream_delta(chunk, text_parts, tool_calls_map)
                stop_reason = finish_reason or stop_reason
                yield chunk
        finally:
            response_details = {**_finalize_stream_response(text_parts, tool_calls_map), "stop_reason": stop_reason}
            send_metric_background(self._w._observatory_url, {
                "provider":       "deepinfra",
                "model":          params["model"],
                "input_tokens":   input_t,
                "output_tokens":  output_t,
                "total_tokens":   input_t + output_t,
                "cost_usd":       _resolve_cost(last_usage, params["model"], input_t, output_t),
                "latency_ms":     int((time.perf_counter() - start) * 1000),
                "status_code":    200,
                "tools_used":     tools,
                "prompt_preview": prompt_preview,
                "tags":           self._w._tags,
                "api_key_hint":   self._w._api_key_hint,
                **request_details,
                **response_details,
            }, token=self._w._observatory_token)


class _DeepInfraChatProxy:
    def __init__(self, wrapper: "MonitoredDeepInfra") -> None:
        self.completions = _DeepInfraCompletionsProxy(wrapper)


class MonitoredDeepInfra:
    """Drop-in DeepInfra client with Observatory metrics. DeepInfra's API is
    OpenAI-compatible, so this wraps openai.OpenAI pointed at
    api.deepinfra.com/v1/openai."""

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
                "openai package is required for MonitoredDeepInfra (DeepInfra's API is OpenAI-compatible). "
                'Install it with: pip install "llm-observatory[deepinfra]"'
            ) from e

        resolved_key = api_key or os.environ.get("DEEPINFRA_API_KEY") or os.environ.get("DEEPINFRA_TOKEN", "")
        self._observatory_url   = observatory_url
        self._observatory_token = observatory_token
        self._tags              = tags or {}
        self._api_key_hint      = mask_key(resolved_key)
        kwargs.setdefault("base_url", DEEPINFRA_BASE_URL)
        self._client             = _OpenAI(api_key=resolved_key, **kwargs)
        self.chat                = _DeepInfraChatProxy(self)


# ---------------------------------------------------------------------------
# Async
# ---------------------------------------------------------------------------

class _AsyncDeepInfraCompletionsProxy:
    def __init__(self, wrapper: "AsyncMonitoredDeepInfra") -> None:
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
            # _create_stream is `async def` but has no `yield` of its own — it just
            # awaits the API call and returns the real async generator from
            # _stream_generator(). Without this await, callers get back an
            # un-awaited coroutine instead of an async-iterable stream.
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
        response_details = extract_openai_response_details(response) if response else {
            "response_full": None, "tool_calls": [], "stop_reason": None,
        }

        metric = {
            "provider":       "deepinfra",
            "model":          params["model"],
            "input_tokens":   input_t,
            "output_tokens":  output_t,
            "total_tokens":   input_t + output_t,
            "cost_usd":       _resolve_cost(usage, params["model"], input_t, output_t),
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
                "provider": "deepinfra", "model": params["model"],
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
        input_t = output_t = 0
        last_usage: Any = None
        text_parts: list[str] = []
        tool_calls_map: dict[int, dict[str, str]] = {}
        stop_reason = None
        try:
            async for chunk in raw_stream:
                usage = getattr(chunk, "usage", None)
                if usage:
                    last_usage = usage
                    input_t  = getattr(usage, "prompt_tokens",     input_t)
                    output_t = getattr(usage, "completion_tokens", output_t)
                finish_reason = _accumulate_stream_delta(chunk, text_parts, tool_calls_map)
                stop_reason = finish_reason or stop_reason
                yield chunk
        finally:
            response_details = {**_finalize_stream_response(text_parts, tool_calls_map), "stop_reason": stop_reason}
            await send_metric_background_async(self._w._observatory_url, {
                "provider":       "deepinfra",
                "model":          params["model"],
                "input_tokens":   input_t,
                "output_tokens":  output_t,
                "total_tokens":   input_t + output_t,
                "cost_usd":       _resolve_cost(last_usage, params["model"], input_t, output_t),
                "latency_ms":     int((time.perf_counter() - start) * 1000),
                "status_code":    200,
                "tools_used":     tools,
                "prompt_preview": prompt_preview,
                "tags":           self._w._tags,
                "api_key_hint":   self._w._api_key_hint,
                **request_details,
                **response_details,
            }, token=self._w._observatory_token)


class _AsyncDeepInfraChatProxy:
    def __init__(self, wrapper: "AsyncMonitoredDeepInfra") -> None:
        self.completions = _AsyncDeepInfraCompletionsProxy(wrapper)


class AsyncMonitoredDeepInfra:
    """Drop-in DeepInfra client with Observatory metrics — async variant."""

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
                "openai package is required for AsyncMonitoredDeepInfra (DeepInfra's API is OpenAI-compatible). "
                'Install it with: pip install "llm-observatory[deepinfra]"'
            ) from e

        resolved_key = api_key or os.environ.get("DEEPINFRA_API_KEY") or os.environ.get("DEEPINFRA_TOKEN", "")
        self._observatory_url   = observatory_url
        self._observatory_token = observatory_token
        self._tags              = tags or {}
        self._api_key_hint      = mask_key(resolved_key)
        kwargs.setdefault("base_url", DEEPINFRA_BASE_URL)
        self._client             = _AsyncOpenAI(api_key=resolved_key, **kwargs)
        self.chat                = _AsyncDeepInfraChatProxy(self)
