import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from llm_observatory import calculate_openai_image_cost


def _build(cls_name, proxies):
    import llm_observatory.openai as mod
    inst = object.__new__(getattr(mod, cls_name))
    inst._observatory_url = "http://obs:3001"
    inst._observatory_token = "obs_sk_test"
    inst._tags = {}
    inst._api_key_hint = "sk-proj-…5678"
    inst._client = MagicMock()
    inst.images = getattr(mod, proxies[0])(inst)
    inst.responses = getattr(mod, proxies[1])(inst)
    return inst


@pytest.fixture()
def mock_send():
    with patch("llm_observatory.openai.send_metric_background") as m:
        yield m


@pytest.fixture()
def client(mock_send):
    return _build("MonitoredOpenAI", ("_ImagesProxy", "_ResponsesProxy"))


def _metric(mock_send):
    return mock_send.call_args[0][1]


def test_image_cost_splits_input_kinds():
    usage = {"input_tokens": 150, "output_tokens": 4000, "input_tokens_details": {"text_tokens": 50, "image_tokens": 100}}
    assert calculate_openai_image_cost("gpt-image-1", usage) == pytest.approx((50 * 5 + 100 * 10 + 4000 * 40) / 1e6)


def test_image_cost_unpriced_is_none():
    assert calculate_openai_image_cost("gpt-image-2", {"input_tokens": 1, "output_tokens": 1}) is None
    assert calculate_openai_image_cost("gpt-image-1", None) is None


def test_generate_priced(client, mock_send):
    resp = NS(data=[NS()], usage=NS(input_tokens=20, output_tokens=1000, input_tokens_details=NS(text_tokens=20, image_tokens=0)))
    client._client.images.generate.return_value = resp
    assert client.images.generate(model="gpt-image-1", prompt="a cat") is resp
    m = _metric(mock_send)
    assert m["tools_used"] == ["images.generate"]
    assert m["cost_usd"] > 0
    assert "cost_confidence" not in m
    assert "a cat" in m["prompt_preview"]


def test_generate_unpriced_is_unknown(client, mock_send):
    client._client.images.generate.return_value = NS(data=[NS(), NS()], usage=NS(input_tokens=5, output_tokens=50, input_tokens_details=None))
    client.images.generate(model="gpt-image-2", prompt="p", n=2)
    m = _metric(mock_send)
    assert m["cost_usd"] == 0
    assert m["cost_confidence"] == "unknown"
    assert "×2" in m["prompt_preview"]


def test_dalle_default_model_unknown(client, mock_send):
    client._client.images.generate.return_value = NS(data=[NS()], usage=None)
    client.images.generate(prompt="p")
    m = _metric(mock_send)
    assert m["model"] == "dall-e-2"
    assert m["cost_confidence"] == "unknown"


def test_edit_error_recorded_and_raised(client, mock_send):
    err = Exception("bad")
    err.status_code = 400
    client._client.images.edit.side_effect = err
    with pytest.raises(Exception, match="bad"):
        client.images.edit(model="gpt-image-1", prompt="p")
    m = _metric(mock_send)
    assert m["status_code"] == 400
    assert m["tools_used"] == ["images.edit"]


def test_image_stream_single_metric(client, mock_send):
    events = [NS(type="image_generation.partial_image"),
              NS(type="image_generation.completed", usage=NS(input_tokens=10, output_tokens=100, input_tokens_details=NS(text_tokens=10, image_tokens=0)))]
    client._client.images.generate.return_value = iter(events)
    seen = list(client.images.generate(model="gpt-image-1", prompt="p", stream=True))
    assert len(seen) == 2
    mock_send.assert_called_once()
    assert _metric(mock_send)["output_tokens"] == 100


def test_responses_image_tool_unknown(client, mock_send):
    client._client.responses.create.return_value = NS(
        usage=NS(input_tokens=100, output_tokens=20),
        output=[NS(type="image_generation_call"), NS(type="message")],
    )
    client.responses.create(model="gpt-5.5", input="draw", tools=[{"type": "image_generation"}, {"type": "function", "name": "lookup"}])
    m = _metric(mock_send)
    assert m["tools_used"] == ["image_generation", "lookup"]
    assert m["cost_confidence"] == "unknown"
    assert m["prompt_preview"].startswith("[1 image(s)]")


def test_responses_without_image_known(client, mock_send):
    client._client.responses.create.return_value = NS(usage=NS(input_tokens=100, output_tokens=20), output=[NS(type="message")])
    client.responses.create(model="gpt-5.5", input="hi")
    m = _metric(mock_send)
    assert "cost_confidence" not in m
    assert m["cost_usd"] > 0


def test_responses_stream(client, mock_send):
    events = [NS(type="response.output_text.delta"),
              NS(type="response.completed", response=NS(usage=NS(input_tokens=10, output_tokens=5), output=[NS(type="image_generation_call")]))]
    client._client.responses.create.return_value = iter(events)
    list(client.responses.create(model="gpt-5.5", input="x", stream=True))
    m = _metric(mock_send)
    assert m["input_tokens"] == 10
    assert m["cost_confidence"] == "unknown"


def test_async_images_and_responses():
    with patch("llm_observatory.openai.send_metric_background_async", new=AsyncMock()) as send:
        c = _build("AsyncMonitoredOpenAI", ("_AsyncImagesProxy", "_AsyncResponsesProxy"))
        c._client.images.generate = AsyncMock(return_value=NS(data=[NS()], usage=None))
        c._client.responses.create = AsyncMock(return_value=NS(usage=NS(input_tokens=1, output_tokens=1), output=[NS(type="image_generation_call")]))

        async def run():
            await c.images.generate(model="gpt-image-2", prompt="p")
            await c.responses.create(model="gpt-5.5", input="x", tools=[{"type": "image_generation"}])
        asyncio.run(run())
        metrics = [call.args[1] for call in send.call_args_list]
        assert metrics[0]["cost_confidence"] == "unknown"
        assert metrics[1]["tools_used"] == ["image_generation"]
        assert metrics[1]["cost_confidence"] == "unknown"
