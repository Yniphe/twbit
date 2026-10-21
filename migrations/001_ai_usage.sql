CREATE TABLE twbit.ai_requests (
    id uuid PRIMARY KEY,
    started_at timestamptz NOT NULL,
    finished_at timestamptz NOT NULL,
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    channel text NOT NULL,
    provider text NOT NULL,
    requested_model text NOT NULL,
    response_model text,
    provider_request_id text,
    status text NOT NULL CHECK (status IN ('success', 'error', 'cancelled')),
    http_status smallint CHECK (http_status BETWEEN 100 AND 599),
    finish_reason text,
    decision_action text CHECK (decision_action IN ('reply', 'start_conversation', 'skip')),
    error_code text,
    input_characters integer NOT NULL CHECK (input_characters >= 0),
    input_tokens bigint CHECK (input_tokens >= 0),
    output_tokens bigint CHECK (output_tokens >= 0),
    total_tokens bigint CHECK (total_tokens >= 0),
    cached_input_tokens bigint CHECK (cached_input_tokens >= 0),
    reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_requests_channel_started_idx ON twbit.ai_requests (channel, started_at DESC);
CREATE INDEX ai_requests_started_idx ON twbit.ai_requests (started_at DESC);

CREATE VIEW twbit.usage_daily AS
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
    round(avg(duration_ms), 1) AS average_duration_ms
FROM twbit.ai_requests
GROUP BY 1, 2, 3, 4;
