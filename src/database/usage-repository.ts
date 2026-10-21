import type { SQL } from "bun";
import type { AiRequestUsage } from "../ai/usage";

export class UsageRepository {
  constructor(private readonly sql: SQL) {}

  async insert(requests: AiRequestUsage[]): Promise<void> {
    if (!requests.length) return;
    const rows = requests.map((request) => ({
      id: request.id, provider: request.provider, channel: request.channel,
      requested_model: request.requestedModel, response_model: request.responseModel,
      provider_request_id: request.providerRequestId,
      started_at: request.startedAt, finished_at: request.finishedAt, duration_ms: request.durationMs,
      input_characters: request.inputCharacters, http_status: request.httpStatus, status: request.status,
      finish_reason: request.finishReason, decision_action: request.decisionAction, error_code: request.errorCode,
      input_tokens: request.usage?.prompt_tokens ?? null,
      output_tokens: request.usage?.completion_tokens ?? null,
      total_tokens: request.usage?.total_tokens ?? null,
      cached_input_tokens: request.usage?.prompt_tokens_details?.cached_tokens ?? null,
      cache_write_input_tokens: request.usage?.prompt_tokens_details?.cache_write_tokens ?? null,
      reasoning_tokens: request.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    }));
    // A retry after an uncertain commit cannot double-count the same request.
    await this.sql`INSERT INTO twbit.ai_requests ${this.sql(rows)} ON CONFLICT (id) DO NOTHING`;
  }
}
