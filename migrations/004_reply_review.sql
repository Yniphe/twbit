ALTER TABLE twbit.reply_history
    ADD COLUMN review jsonb CHECK (review IS NULL OR jsonb_typeof(review) = 'object');

ALTER TABLE twbit.reply_history DROP CONSTRAINT reply_history_trigger_check;
ALTER TABLE twbit.reply_history ADD CONSTRAINT reply_history_trigger_check
    CHECK (trigger IN ('batch', 'dialogue', 'stream'));
