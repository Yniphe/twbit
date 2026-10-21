ALTER TABLE twbit.ai_requests
    ADD COLUMN cache_write_input_tokens bigint CHECK (cache_write_input_tokens >= 0);

-- Append columns so existing daily-stat consumers retain their original shape.
CREATE OR REPLACE VIEW twbit.usage_daily AS
SELECT
    (started_at AT TIME ZONE 'UTC')::date AS day_utc,
    channel,
    provider,
    requested_model AS model,
    count(*) AS requests,
    count(*) FILTER (WHERE status = 'success') AS successes,
    count(*) FILTER (WHERE status = 'error') AS errors,
    count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
    count(*) FILTER (WHERE decision_action = 'reply') AS reply_decisions,
    count(*) FILTER (WHERE decision_action = 'start_conversation') AS conversation_starts,
    count(*) FILTER (WHERE decision_action = 'skip') AS skip_decisions,
    count(input_tokens) AS requests_with_input_usage,
    count(output_tokens) AS requests_with_output_usage,
    count(total_tokens) AS requests_with_total_usage,
    sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,
    sum(total_tokens) AS total_tokens,
    sum(cached_input_tokens) AS cached_input_tokens,
    sum(reasoning_tokens) AS reasoning_tokens,
    round(avg(duration_ms), 1) AS average_duration_ms,
    count(cache_write_input_tokens) AS requests_with_cache_write_usage,
    sum(cache_write_input_tokens) AS cache_write_input_tokens
FROM twbit.ai_requests
GROUP BY 1, 2, 3, 4;
