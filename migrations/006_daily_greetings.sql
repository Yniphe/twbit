CREATE TABLE twbit.daily_greetings (
  channel text NOT NULL,
  bot_user_id text NOT NULL,
  greeting_day date NOT NULL,
  time_zone text NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'unconfirmed', 'cancelled')),
  message_id text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (channel, bot_user_id, greeting_day),
  CHECK ((status = 'sent') = (message_id IS NOT NULL)),
  CHECK ((status = 'pending') = (finished_at IS NULL))
);
