CREATE TABLE twbit.user_memories (
    channel text NOT NULL,
    user_id text NOT NULL CHECK (user_id ~ '^[1-9][0-9]{0,24}$'),
    login text NOT NULL CHECK (login ~ '^[a-z0-9_]{1,25}$'),
    kind text NOT NULL CHECK (kind IN ('fact', 'moment')),
    memory_key text NOT NULL CHECK (memory_key ~ '^[a-z][a-z0-9_]{0,63}$'),
    content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 400),
    confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) BETWEEN 1 AND 3),
    source_event_id text NOT NULL,
    observed_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > observed_at),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel, user_id, kind, memory_key)
);

CREATE INDEX user_memories_recall_idx ON twbit.user_memories (channel, user_id, observed_at DESC);
CREATE INDEX user_memories_expiry_idx ON twbit.user_memories (channel, expires_at);
