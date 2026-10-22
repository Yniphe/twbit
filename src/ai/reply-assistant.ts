import type { ChatMessage } from "../clients/websocket-chat-client";
import type { Logger } from "../logger";
import type { Transcript } from "../speech/types";
import type { AiConfig } from "./ai-config";
import { ConversationBuffer } from "./conversation-buffer";
import { buildReplyPrompt } from "./reply-prompt";
import { completionTemperature } from "./chat-request";
import { ResponseDeadlineError, AiApiError, ChatClient, AiTimeoutError } from "./chat-client";
import type { AnalysisBatch, ReplyAnalyzer, ReplyDecision, ReplyDraft } from "./types";
import type { ConversationMemory } from "../memory/types";
import { formatReplyMessage, stripRecipientAddress, type ChatSender } from "../chat-delivery";
import type { TwitchUser } from "../twitch-api";
import { BotDialogue } from "./bot-dialogue";
import type { ReplyHistoryEntry, ReplyHistorySink } from "./reply-history";
import { ChatDeliveryError, describeSendFailure } from "../chat-send-error";
import { isChatCommand, isLowInformationMessage } from "./message-attention";
import { rejectUngroundedReply } from "./reply-grounding";
import { ReplyScheduler } from "./reply-scheduler";
import { ChatReplyReviewer, type ReplyReviewer } from "./reply-reviewer";
import { observe, type ServiceObserver } from "../runtime/events";
import { ChatOutputPolicy, BLOCKED_WORD_REASON } from "../chat-output-policy";
import { ReplyBanter } from "./reply-banter";
import type { RelationshipSource } from "../people/relationships";

/** Batches ambient conversation and prioritizes direct dialogue; validates before delivery. */
export class ReplyAssistant {
  private readonly buffer: ConversationBuffer;
  private readonly shutdown = new AbortController();
  private readonly drafts: ReplyDraft[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  private analyzing = false;
  private readonly scheduler: ReplyScheduler;
  private analysisTask: Promise<void> = Promise.resolve();
  private readonly dialogue: BotDialogue;
  private readonly outputPolicy: ChatOutputPolicy;
  private readonly banter: ReplyBanter;
  private backoffUntil = 0;
  private readonly memoryTasks = new Set<Promise<void>>();

  constructor(
    private readonly channel: string,
    private readonly config: AiConfig,
    private readonly logger: Logger,
    private readonly analyzer: ReplyAnalyzer = new ChatClient(config, channel),
    private readonly memory?: ConversationMemory,
    private readonly sender?: ChatSender,
    private readonly history?: ReplyHistorySink,
    private readonly reviewer: ReplyReviewer = new ChatReplyReviewer(config, channel),
    private readonly observer?: ServiceObserver,
    private readonly relationships?: RelationshipSource,
  ) {
    this.buffer = new ConversationBuffer(config.context);
    this.dialogue = new BotDialogue(config.dialogue.windowSeconds);
    this.scheduler = new ReplyScheduler(config);
    this.outputPolicy = new ChatOutputPolicy(config.blockedWords);
    this.banter = new ReplyBanter(channel, config.banter, config.reply.maxAgeSeconds);
  }

  identify(account: Pick<TwitchUser, "userId" | "login">): void { this.dialogue.identify(account); }

  recordReply(draft: ReplyDraft): void {
    this.dialogue.sent(draft, Date.now());
    this.banter.replied(draft);
    this.drafts.push(draft);
    if (this.drafts.length > 6) this.drafts.shift();
    observe(this.observer, { type: "reply", draft });
  }

  start(): void {
    if (this.active || this.shutdown.signal.aborted) return;
    if (!this.config.enabled) {
      this.logger.info("AI выключен; для включения задайте ai.enabled=true");
      return;
    }
    this.active = true;
    this.logger.info({ provider: this.config.provider, model: this.config.model, strategy: this.config.strategy,
      batchSize: this.config.batch.size, maxWaitSeconds: this.config.batch.maxWaitSeconds,
      delivery: this.config.delivery }, this.config.delivery === "chat"
      ? "AI накапливает события; уместные ответы будут отправляться в чат" : "AI накапливает события; ответы выводятся только в консоль");
    this.timer = setInterval(() => this.scheduleAnalysis(), 1000);
    this.logger.info({ event: "ai.limits" }, `Мышление: чат=${this.config.reasoningEffort}, эфир=${this.config.stream.reasoningEffort}; таймаут API=${this.config.timeoutSeconds} с; срок чата=${this.config.reply.maxAgeSeconds} с, эфира=${this.config.stream.maxAgeSeconds} с`);
  }

  addChat(message: ChatMessage): void {
    if (!this.active || !message.text.trim() || this.dialogue.isOwn(message)) return;
    const now = Date.now();
    const timestamp = new Date(message.at);
    const login = message.login ?? message.author;
    this.buffer.add({
      id: `chat:${message.id ?? crypto.randomUUID()}`, source: "chat",
      speaker: message.isBroadcaster || login.toLowerCase() === this.channel ? "streamer" : "viewer",
      author: login, userId: message.userId, messageId: message.id, reply: message.reply,
      attention: this.config.dialogue.enabled ? this.dialogue.attention(message, now) : undefined,
      at: Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date(now).toISOString(),
      receivedAt: now, text: message.text,
    });
    this.scheduleAnalysis();
  }

  addTranscript(transcript: Transcript): void {
    if (!this.active || !transcript.final || !transcript.text.trim()) return;
    const now = Date.now();
    this.buffer.add({
      id: `audio:${crypto.randomUUID()}`, source: "stream_audio", speaker: "unverified",
      author: this.channel, at: new Date(now).toISOString(), receivedAt: now, text: transcript.text,
    });
    this.scheduleAnalysis();
  }

  stop(): void {
    this.active = false;
    clearInterval(this.timer);
    this.shutdown.abort();
  }

  async settled(): Promise<void> { await this.analysisTask; await Promise.all(this.memoryTasks); }

  private scheduleAnalysis(): void {
    if (!this.analyzing) this.analysisTask = this.maybeAnalyze();
  }

  private async maybeAnalyze(): Promise<void> {
    const now = Date.now();
    if (!this.active || this.analyzing || now < this.backoffUntil) return;
    const snapshot = this.buffer.snapshot(now);
    if (!snapshot) return;
    const plan = this.scheduler.select(snapshot, now);
    if (!plan) return;
    const { batch, priorityIds } = plan;
    const reasoningEffort = plan.trigger === "stream" ? this.config.stream.reasoningEffort : this.config.reasoningEffort;
    this.analyzing = true;
    observe(this.observer, { type: "phase", phase: "thinking" });
    this.scheduler.started(plan, now);
    // Mark only this snapshot: events arriving while the request is in flight remain pending.
    this.buffer.acknowledge(batch);
    let history: ReplyHistoryEntry | undefined;
    try {
      const memory = await this.memory?.recall(batch);
      if (!this.active) return;
      let banterTarget = priorityIds.length ? undefined : this.banter.select(batch, Date.now());
      const style = banterTarget && this.relationships?.get(this.channel, banterTarget.login)?.style;
      if (style && style !== "banter") banterTarget = undefined;
      const relationships = this.relationships?.context(this.channel, batch) ?? [];
      const prompts = buildReplyPrompt(this.config, this.channel, batch, this.drafts, memory, this.dialogue.identity, priorityIds, banterTarget, relationships);
      history = { id: crypto.randomUUID(), channel: this.channel, model: this.config.model,
        startedAt: new Date(), finishedAt: new Date(), trigger: plan.trigger, delivery: this.config.delivery,
        outcome: "analysis_error", outcomeReason: "Анализ не завершён", errorCode: null,
        decision: null, targetUserId: null, outgoingText: null, messageId: null, replyParentMessageId: null,
        context: JSON.parse(prompts[1]!.content), systemPrompt: prompts[0]!.content,
        modelSettings: { provider: this.config.provider, providerRouting: this.config.providerRouting,
          temperature: completionTemperature(this.config) ?? null,
          maxTokens: this.config.maxTokens, reasoningEffort,
          review: { ...this.config.review }, streamMaxAgeSeconds: this.config.stream.maxAgeSeconds } };
      // Keep the stream's generation window; a fast draft leaves extra time for review.
      // Review still receives the remaining source deadline and cannot extend it.
      const reserveMs = this.config.review.enabled
        ? Math.min(this.config.review.timeoutSeconds * 1000, plan.trigger === "stream" ? 4000 : Infinity) : 0;
      const freshnessMs = plan.expiresAt - Date.now() - reserveMs - 500;
      const generationMs = Math.min(this.config.timeoutSeconds * 1000, freshnessMs);
      this.logger.info({ event: "ai.analysis", newEvents: batch.newEventIds.length, trigger: plan.trigger,
        reasoningEffort, generationBudgetMs: Math.max(0, Math.floor(generationMs)),
        analysisId: history.id,
        memoryUsers: memory?.length ?? 0,
        earlierSpeechTurns: batch.earlierSpeech?.length ?? 0,
        contextEvents: batch.events.length, provider: this.config.provider, model: this.config.model }, "Анализ накопленных событий");
      if (generationMs <= 0) {
        history.outcome = "cancelled"; history.outcomeReason = "Повод устарел до начала анализа"; history.errorCode = "STALE";
        return;
      }
      const result = await this.analyzer.analyze(prompts,
        AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(Math.ceil(freshnessMs))]), history.id, {
          reasoningEffort, onRequestPrepared: (request) => { if (history) history.context.modelRequest = request; },
        });
      history.decision = result.decision;
      history.targetUserId = batch.events.find((event) => event.source === "chat"
        && event.author.toLowerCase() === result.decision.target?.login?.toLowerCase())?.userId ?? null;
      if (!this.active) { history.outcome = "cancelled"; history.outcomeReason = "Приложение остановлено"; return; }
      if (result.rejectedMemoryUpdates) this.logger.info({ event: "memory.invalid", count: result.rejectedMemoryUpdates },
        `Некорректных предложений памяти: ${result.rejectedMemoryUpdates}`);
      if (this.memory) {
        const task = Promise.resolve().then(() => this.memory!.remember(batch, result.memoryUpdates ?? []))
          .catch((err) => { this.logger.warn({ err, event: "memory.save_failed" }, "Не удалось сохранить память"); });
        this.memoryTasks.add(task);
        void task.finally(() => this.memoryTasks.delete(task));
      }
      if (!this.active) { history.outcome = "cancelled"; history.outcomeReason = "Приложение остановлено"; return; }
      let rejection = this.rejectReason(result.decision, batch, priorityIds);
      if (!rejection && this.config.review.enabled) {
        observe(this.observer, { type: "phase", phase: "reviewing" });
        const requestId = crypto.randomUUID();
        const reviewStarted = performance.now();
        try {
          const remainingMs = plan.expiresAt - Date.now() - 500;
          if (remainingMs <= 0) throw new Error("Истёк срок реакции");
          const laterEvents = this.buffer.snapshot(Date.now())?.events.filter((event) => event.sequence > batch.lastSequence) ?? [];
          history.review = { requestId, verdict: "unavailable", reason: "Проверка не завершена", durationMs: 0,
            updates: laterEvents.slice(-6).map(({ sequence: _sequence, receivedAt: _receivedAt, ...event }) => event) };
          const verdict = await this.reviewer.review({ decision: result.decision, batch, previousReplies: this.drafts, laterEvents },
            AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(Math.ceil(remainingMs))]), requestId, {
              onRequestPrepared: (request) => { if (history?.review) history.review.request = request; },
            });
          history.review = { ...history.review, ...verdict, durationMs: Math.round(performance.now() - reviewStarted) };
          if (verdict.verdict !== "accept") rejection = `Проверка смысла: ${verdict.reason}`;
        } catch (err) {
          history.review = { ...history.review, requestId, verdict: "unavailable", reason: "Проверка не завершена", durationMs: Math.round(performance.now() - reviewStarted) };
          rejection = "Проверка смысла не завершена; ответ не отправлен";
          this.logger.warn({ event: "ai.review_unavailable", analysisId: history.id }, rejection);
          if (err instanceof AiApiError) throw err;
        }
        if (!this.active) { history.outcome = "cancelled"; history.outcomeReason = "Приложение остановлено"; return; }
        // The source can expire while the reviewer is working. Never enqueue a late reaction.
        rejection ??= this.rejectReason(result.decision, batch, priorityIds);
      }
      if (rejection) {
        history.outcome = result.decision.action === "skip" ? "skipped" : "rejected";
        history.outcomeReason = rejection;
        if (rejection === BLOCKED_WORD_REASON) history.errorCode = "BLOCKED_WORD";
        this.logger.info({ event: "ai.skip", reason: rejection,
          analysisId: history.id,
          accepted: false, decision: result.decision,
          confidence: result.decision.confidence, usage: result.usage }, "Ответ пропущен");
        return;
      }
      const decision = result.decision;
      const source = batch.events.find((event) => event.id === decision.replyToEventId && event.source === "chat");
      const replyTo = decision.target?.kind === "chat" ? undefined : source?.messageId;
      let text: string;
      try {
        text = formatReplyMessage(decision.text, decision.target?.login, replyTo);
        this.outputPolicy.assert(text);
      } catch (error) {
        if (!(error instanceof ChatDeliveryError) || error.code !== "BLOCKED_WORD") throw error;
        history.outcome = "rejected"; history.outcomeReason = BLOCKED_WORD_REASON; history.errorCode = "BLOCKED_WORD";
        this.logger.info({ event: "ai.skip", reason: BLOCKED_WORD_REASON, analysisId: history.id }, "Ответ пропущен");
        return;
      }
      const draft: ReplyDraft = { at: new Date().toISOString(), text,
        action: decision.action, target: decision.target, delivery: this.config.delivery };
      observe(this.observer, { type: "phase", phase: "responding" });
      if (this.config.delivery === "chat") {
        history.outgoingText = text;
        history.replyParentMessageId = replyTo ?? null;
        try {
          if (!this.sender) throw new ChatDeliveryError("SEND_NOT_CONFIGURED", "Не настроен отправитель Twitch");
          const sent = await this.sender.send(text, replyTo);
          draft.messageId = sent.messageId;
          draft.at = new Date().toISOString();
          history.outcome = "sent"; history.outcomeReason = "Twitch подтвердил отправку"; history.messageId = sent.messageId;
        } catch (error) {
          history.outcome = this.shutdown.signal.aborted ? "cancelled" : "send_failed";
          const failure = describeSendFailure(error);
          history.outcomeReason = this.shutdown.signal.aborted ? "Приложение остановлено во время отправки, доставка не подтверждена" : failure.reason;
          history.errorCode = this.shutdown.signal.aborted ? "ABORTED" : failure.code;
          this.logger.warn({ err: error, event: "ai.send_failed", delivery: "chat", accepted: false, analysisId: history.id },
            "Ответ не подтверждён Twitch; автоматического повтора нет");
          return;
        }
      } else {
        history.outcome = "console_only"; history.outcomeReason = "Черновик показан только в консоли";
      }
      this.recordReply(draft);
      this.scheduler.delivered(plan, Date.now());
      this.logger.info({ event: "ai.reply", delivery: draft.delivery, messageId: draft.messageId, accepted: true, at: draft.at, analysisId: history.id,
        sourceAgeMs: Date.now() - (batch.events.find((event) => event.id === decision.replyToEventId)?.receivedAt ?? now),
        decision: { ...decision, text: draft.text }, usage: result.usage },
        draft.delivery === "chat" ? "Ответ отправлен в Twitch" : "Предлагаемый ответ — только консоль");
    } catch (error) {
      if (history) {
        history.outcome = this.shutdown.signal.aborted || error instanceof ResponseDeadlineError ? "cancelled" : "analysis_error";
        history.outcomeReason = this.shutdown.signal.aborted ? "Приложение остановлено" : error instanceof ResponseDeadlineError ? error.message : "AI не выполнил анализ";
        history.errorCode = this.shutdown.signal.aborted ? "ABORTED" : error instanceof ResponseDeadlineError ? "RESPONSE_DEADLINE"
          : error instanceof AiTimeoutError ? "TIMEOUT" : error instanceof AiApiError ? `HTTP_${error.status}` : "ANALYSIS_FAILED";
      }
      if (!this.active) return;
      if (error instanceof ResponseDeadlineError) {
        this.logger.info({ event: "ai.stale", analysisId: history?.id }, error.message);
        return;
      }
      this.logger.warn({ err: error, event: "ai.error", analysisId: history?.id }, "AI не выполнил анализ; чат и распознавание продолжают работать");
      if (error instanceof AiApiError && (error.status === 401 || error.status === 403)) {
        this.active = false;
        clearInterval(this.timer);
        this.logger.error("AI приостановлен до исправления ключа/доступа и перезапуска приложения");
      }
      if (error instanceof AiApiError && error.status === 429) this.backoffUntil = Date.now() + 60_000;
    } finally {
      this.analyzing = false;
      if (history) {
        history.finishedAt = new Date();
        observe(this.observer, { type: "result", outcome: history.outcome,
          reason: history.outcomeReason, durationMs: history.finishedAt.getTime() - history.startedAt.getTime() });
        try { this.history?.recordReply(history); }
        catch { this.logger.error({ event: "database.history_lost", analysisId: history.id }, "Не удалось поставить историю ответа в очередь"); }
      }
      observe(this.observer, { type: "phase", phase: "listening" });
    }
  }

  private rejectReason(decision: ReplyDecision, batch: AnalysisBatch, priorityIds: string[]): string | undefined {
    if (decision.action === "skip") return decision.reason || "Модель решила не отвечать";
    if (priorityIds.length && (decision.action !== "reply" || !priorityIds.includes(decision.replyToEventId ?? ""))) {
      return "В ускоренном анализе нужен ответ на обращение к боту";
    }
    if (decision.confidence < this.config.reply.minConfidence) return "Недостаточная уверенность в уместности ответа";
    if (!decision.text || Array.from(decision.text).length > this.config.reply.maxCharacters) return "Ответ пустой или слишком длинный";
    if (this.outputPolicy.find(decision.text)) return BLOCKED_WORD_REASON;
    if (decision.text.trim().split(/\s+/u).length > this.config.reply.maxWords) return "Слишком много слов в ответе";
    const availableIds = new Set(batch.events.map((event) => event.id));
    if (!decision.eventIds.length || decision.eventIds.some((id) => !availableIds.has(id))) return "Ответ ссылается на неизвестные события";
    const freshEvidence = batch.events.filter((event) => decision.eventIds.includes(event.id) && batch.newEventIds.includes(event.id));
    if (!freshEvidence.length) return "Нет опоры на новые события";
    // Earlier speech can explain a fresh turn without becoming its response deadline.
    // An explicit reply to old audio still expires even when fresh chat is present.
    const anchor = decision.action === "reply" ? batch.events.find((event) => event.id === decision.replyToEventId)
      : freshEvidence.reduce((latest, event) => event.receivedAt > latest.receivedAt ? event : latest);
    if (anchor?.source === "stream_audio" && Date.now() - anchor.receivedAt > this.config.stream.maxAgeSeconds * 1000) {
      return "Реакция на эфир устарела";
    }
    if (Date.now() - Math.max(...freshEvidence.map((event) => event.receivedAt)) > this.config.reply.maxAgeSeconds * 1000) {
      return "Ответ устарел во время анализа";
    }
    const target = decision.target!;
    const source = batch.events.find((event) => event.id === decision.replyToEventId);
    if (this.relationships?.get(this.channel, target.login ?? "", source?.userId)?.style === "ignore"
      || (source?.source === "chat" && this.relationships?.get(this.channel, source.author, source.userId)?.style === "ignore")) {
      return "Для этого зрителя отключены ответы агента";
    }
    if (target.kind === "streamer" && target.login?.toLowerCase() !== this.channel) return "Неверный login стримера";
    if (target.kind === "viewer" && !batch.events.some((event) => event.source === "chat"
      && event.speaker === "viewer" && event.author.toLowerCase() === target.login?.toLowerCase())) return "Адресат отсутствует в контексте чата";
    if (decision.action === "reply") {
      const source = batch.events.find((event) => event.id === decision.replyToEventId);
      if (!source || !decision.eventIds.includes(source.id)) return "Неизвестное событие для ответа";
      if (source.source === "chat" && Date.now() - source.receivedAt > this.config.reply.maxAgeSeconds * 1000) return "Сообщение для ответа устарело";
      if (source.source === "chat" && isChatCommand(source.text)) return "Команда чата не требует разговорного ответа";
      if (source.source === "chat" && isLowInformationMessage(source.text)) return "Эмодзи или спам без содержательного повода для ответа";
      if (target.kind === "viewer" && (source.source !== "chat"
        || source.author.toLowerCase() !== target.login?.toLowerCase())) return "Ответ адресован другому автору";
      if (target.kind === "streamer" && source.source === "chat" && source.author.toLowerCase() !== this.channel) {
        return "Событие для ответа принадлежит другому автору";
      }
    }
    const normalize = (text: string, login?: string | null) => stripRecipientAddress(text, login).toLowerCase().replace(/\s+/g, " ");
    const grounding = rejectUngroundedReply(decision, batch);
    if (grounding) return grounding;
    if (this.drafts.some((draft) => normalize(draft.text, draft.target?.login) === normalize(decision.text, target.login))) return "Такой ответ уже предлагался";
    return;
  }
}
