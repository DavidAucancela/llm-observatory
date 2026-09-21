import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def _make_response(prompt_tokens=100, completion_tokens=50, cost=None):
    response = MagicMock()
    response.usage.prompt_tokens = prompt_tokens
    response.usage.completion_tokens = completion_tokens
    # A bare MagicMock attribute is not a number, so leaving these unset must
    # fall back to the pricing table — that is part of what's under test.
    if cost is not None:
        response.usage.estimated_cost = cost
    return response


@pytest.fixture()
def mock_send():
    with patch("llm_observatory.deepinfra.send_metric_background") as m:
        yield m


@pytest.fixture()
def di_client(mock_send):
    """Build a MonitoredDeepInfra instance with a mocked underlying client."""
    from llm_observatory.deepinfra import MonitoredDeepInfra, _DeepInfraChatProxy

    instance = object.__new__(MonitoredDeepInfra)
    instance._observatory_url = "http://obs:3001"
    instance._observatory_token = "obs_sk_test"
    instance._tags = {}
    instance._api_key_hint = "di-…5678"
    instance._client = MagicMock()
    instance.chat = _DeepInfraChatProxy(instance)
    return instance


MODEL = "deepseek-ai/DeepSeek-V4-Pro"
MSGS = [{"role": "user", "content": "Hello"}]


class TestMonitoredDeepInfraNonStreaming:
    def test_returns_response(self, di_client, mock_send):
        di_client._client.chat.completions.create.return_value = _make_response()
        assert di_client.chat.completions.create(model=MODEL, messages=MSGS) is not None

    def test_sends_metric_with_correct_tokens_and_provider(self, di_client, mock_send):
        di_client._client.chat.completions.create.return_value = _make_response(100, 50)

        di_client.chat.completions.create(model=MODEL, messages=MSGS)

        mock_send.assert_called_once()
        metric = mock_send.call_args[0][1]
        assert metric["input_tokens"] == 100
        assert metric["output_tokens"] == 50
        assert metric["total_tokens"] == 150
        assert metric["provider"] == "deepinfra"
        assert metric["model"] == MODEL
        assert metric["status_code"] == 200

    def test_prices_from_table_when_no_cost_reported(self, di_client, mock_send):
        # 1M input + 1M output for DeepSeek-V4-Pro = $1.30 + $2.60 = $3.90
        di_client._client.chat.completions.create.return_value = _make_response(1_000_000, 1_000_000)

        di_client.chat.completions.create(model=MODEL, messages=MSGS)

        assert mock_send.call_args[0][1]["cost_usd"] == pytest.approx(3.9)

    def test_prefers_cost_reported_in_usage(self, di_client, mock_send):
        di_client._client.chat.completions.create.return_value = _make_response(
            1_000_000, 1_000_000, cost=0.1234
        )

        di_client.chat.completions.create(model=MODEL, messages=MSGS)

        assert mock_send.call_args[0][1]["cost_usd"] == pytest.approx(0.1234)

    def test_accepts_estimated_cost_usd_spelling(self, di_client, mock_send):
        response = _make_response(100, 50)
        response.usage.estimated_cost = None
        response.usage.estimated_cost_usd = 0.5
        di_client._client.chat.completions.create.return_value = response

        di_client.chat.completions.create(model=MODEL, messages=MSGS)

        assert mock_send.call_args[0][1]["cost_usd"] == pytest.approx(0.5)

    @pytest.mark.parametrize("bad", ["free", -1.0, float("nan"), True])
    def test_ignores_malformed_reported_cost(self, di_client, mock_send, bad):
        response = _make_response(1_000_000, 0)
        response.usage.estimated_cost = bad
        di_client._client.chat.completions.create.return_value = response

        di_client.chat.completions.create(
            model="meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", messages=MSGS
        )

        assert mock_send.call_args[0][1]["cost_usd"] == pytest.approx(0.02)

    def test_unpriced_model_records_zero_cost(self, di_client, mock_send):
        di_client._client.chat.completions.create.return_value = _make_response(100, 50)

        with pytest.warns(UserWarning, match="Unknown DeepInfra model pricing"):
            di_client.chat.completions.create(model="some-org/Brand-New-Model", messages=MSGS)

        assert mock_send.call_args[0][1]["cost_usd"] == 0.0

    def test_sends_metric_on_error(self, di_client, mock_send):
        err = Exception("rate limited")
        err.status_code = 429
        di_client._client.chat.completions.create.side_effect = err

        with pytest.raises(Exception, match="rate limited"):
            di_client.chat.completions.create(model=MODEL, messages=MSGS)

        mock_send.assert_called_once()
        metric = mock_send.call_args[0][1]
        assert metric["status_code"] == 429
        assert metric["cost_usd"] == 0.0

    def test_tags_forwarded(self, mock_send):
        from llm_observatory.deepinfra import MonitoredDeepInfra, _DeepInfraChatProxy

        instance = object.__new__(MonitoredDeepInfra)
        instance._observatory_url = "http://obs:3001"
        instance._observatory_token = "obs_sk_test"
        instance._tags = {"env": "staging", "team": "ml"}
        instance._api_key_hint = "di-…5678"
        instance._client = MagicMock()
        instance._client.chat.completions.create.return_value = _make_response()
        instance.chat = _DeepInfraChatProxy(instance)

        instance.chat.completions.create(model=MODEL, messages=MSGS)

        assert mock_send.call_args[0][1]["tags"] == {"env": "staging", "team": "ml"}


class TestMonitoredDeepInfraStreaming:
    def test_stream_yields_all_chunks(self, di_client, mock_send):
        chunks = [MagicMock() for _ in range(3)]
        for c in chunks:
            c.usage = None
        di_client._client.chat.completions.create.return_value = iter(chunks)

        result = list(di_client.chat.completions.create(model=MODEL, messages=MSGS, stream=True))

        assert len(result) == 3

    def test_stream_captures_usage_from_final_chunk(self, di_client, mock_send):
        chunk1 = MagicMock()
        chunk1.usage = None
        chunk2 = MagicMock()
        chunk2.usage.prompt_tokens = 1_000_000
        chunk2.usage.completion_tokens = 0
        di_client._client.chat.completions.create.return_value = iter([chunk1, chunk2])

        list(di_client.chat.completions.create(
            model="meta-llama/Llama-3.3-70B-Instruct-Turbo", messages=MSGS, stream=True
        ))

        mock_send.assert_called_once()
        metric = mock_send.call_args[0][1]
        assert metric["input_tokens"] == 1_000_000
        assert metric["provider"] == "deepinfra"
        assert metric["cost_usd"] == pytest.approx(0.10)

    def test_stream_uses_cost_reported_in_final_chunk(self, di_client, mock_send):
        chunk = MagicMock()
        chunk.usage.prompt_tokens = 120
        chunk.usage.completion_tokens = 60
        chunk.usage.estimated_cost = 0.0042
        di_client._client.chat.completions.create.return_value = iter([chunk])

        list(di_client.chat.completions.create(model=MODEL, messages=MSGS, stream=True))

        assert mock_send.call_args[0][1]["cost_usd"] == pytest.approx(0.0042)

    def test_stream_metric_sent_on_early_close(self, di_client, mock_send):
        di_client._client.chat.completions.create.return_value = iter([MagicMock(), MagicMock()])

        stream = di_client.chat.completions.create(model=MODEL, messages=MSGS, stream=True)

        for _ in stream:
            break
        stream.close()  # explicitly trigger finally block

        mock_send.assert_called_once()


class TestMonitoredDeepInfraAsync:
    async def test_async_prefers_reported_cost(self):
        from llm_observatory.deepinfra import AsyncMonitoredDeepInfra, _AsyncDeepInfraChatProxy

        instance = object.__new__(AsyncMonitoredDeepInfra)
        instance._observatory_url = "http://obs:3001"
        instance._observatory_token = "obs_sk_test"
        instance._tags = {}
        instance._api_key_hint = "di-…5678"
        instance._client = MagicMock()
        instance._client.chat.completions.create = AsyncMock(
            return_value=_make_response(1_000_000, 1_000_000, cost=0.77)
        )
        instance.chat = _AsyncDeepInfraChatProxy(instance)

        with patch("llm_observatory.deepinfra.send_metric_background_async", new=AsyncMock()) as send:
            await instance.chat.completions.create(model=MODEL, messages=MSGS)

        metric = send.call_args[0][1]
        assert metric["provider"] == "deepinfra"
        assert metric["cost_usd"] == pytest.approx(0.77)


class TestMonitoredDeepInfraConstructor:
    def test_defaults_base_url_to_deepinfra(self, mock_send):
        from llm_observatory.deepinfra import MonitoredDeepInfra, DEEPINFRA_BASE_URL

        with patch("openai.OpenAI") as mock_openai_cls:
            MonitoredDeepInfra(api_key="di-test-key-0000000000")
            _, kwargs = mock_openai_cls.call_args
            assert kwargs["base_url"] == DEEPINFRA_BASE_URL == "https://api.deepinfra.com/v1/openai"

    def test_api_key_falls_back_to_deepinfra_then_token_env_var(self, mock_send, monkeypatch):
        from llm_observatory.deepinfra import MonitoredDeepInfra

        monkeypatch.delenv("DEEPINFRA_API_KEY", raising=False)
        monkeypatch.setenv("DEEPINFRA_TOKEN", "di-from-token-env")
        with patch("openai.OpenAI") as mock_openai_cls:
            MonitoredDeepInfra()
            assert mock_openai_cls.call_args.kwargs["api_key"] == "di-from-token-env"

        monkeypatch.setenv("DEEPINFRA_API_KEY", "di-from-key-env")
        with patch("openai.OpenAI") as mock_openai_cls:
            MonitoredDeepInfra()
            assert mock_openai_cls.call_args.kwargs["api_key"] == "di-from-key-env"
