CREATE TABLE twbit.reply_history (
    id uuid PRIMARY KEY,
    channel text NOT NULL,
    model text NOT NULL,
    started_at timestamptz NOT NULL,
    finished_at timestamptz NOT NULL,
    trigger text NOT NULL CHECK (trigger IN ('batch', 'dialogue')),
    delivery text NOT NULL CHECK (delivery IN ('chat', 'console_only')),
    outcome text NOT NULL CHECK (outcome IN ('sent', 'console_only', 'skipped', 'rejected', 'send_failed', 'analysis_error', 'cancelled')),
    outcome_reason text NOT NULL,
    error_code text,
    decision jsonb CHECK (decision IS NULL OR jsonb_typeof(decision) = 'object'),
    target_user_id text,
    outgoing_text text,
    message_id text CHECK (message_id IS NULL OR length(message_id) > 0),
    reply_parent_message_id text,
    context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
    system_prompt text NOT NULL,
    model_settings jsonb NOT NULL CHECK (jsonb_typeof(model_settings) = 'object'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((outcome = 'sent') = (message_id IS NOT NULL)),
    CHECK (outcome <> 'sent' OR (delivery = 'chat' AND outgoing_text IS NOT NULL)),
    CHECK (outcome NOT IN ('sent', 'console_only', 'skipped', 'rejected', 'send_failed') OR decision IS NOT NULL)
);

CREATE INDEX reply_history_channel_finished_idx ON twbit.reply_history (channel, finished_at DESC);
CREATE INDEX reply_history_user_finished_idx ON twbit.reply_history (channel, target_user_id, finished_at DESC)
    WHERE target_user_id IS NOT NULL;
CREATE INDEX reply_history_finished_idx ON twbit.reply_history (finished_at);
