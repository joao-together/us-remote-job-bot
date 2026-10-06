import { REQUEST_TIMEOUT_MS } from "../config";
import type { InlineKeyboardMarkup } from "./format";

const API_BASE = "https://api.telegram.org";
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_S = 60;

const htmlOptions = {
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
} as const;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface TelegramClientOptions {
  token: string;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  waitOn429?: boolean;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

type ChatId = number | string;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TelegramClient {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly waitOn429: boolean;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.fetcher = opts.fetcher ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.waitOn429 = opts.waitOn429 ?? false;
  }

  async sendMessage(chatId: ChatId, html: string, replyMarkup?: InlineKeyboardMarkup): Promise<{ messageId: number }> {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: html,
      ...htmlOptions,
      ...(replyMarkup && { reply_markup: replyMarkup }),
    });
    return { messageId: result.message_id };
  }

  async editMessageReplyMarkup(chatId: ChatId, messageId: number, replyMarkup: InlineKeyboardMarkup): Promise<void> {
    await this.edit("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  async editMessageText(
    chatId: ChatId,
    messageId: number,
    html: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    await this.edit("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      ...htmlOptions,
      ...(replyMarkup && { reply_markup: replyMarkup }),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text !== undefined && { text }),
    });
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  }

  private async edit(method: string, body: Record<string, unknown>): Promise<void> {
    try {
      await this.call(method, body);
    } catch (err) {
      if (err instanceof TelegramError && err.status === 400 && /message is not modified/i.test(err.description)) return;
      throw err;
    }
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<T>(method, body);
      } catch (err) {
        const canRetry =
          err instanceof TelegramError &&
          err.status === 429 &&
          this.waitOn429 &&
          attempt < MAX_ATTEMPTS;
        if (!canRetry) throw err;
        const waitS = Math.min(Math.max(err.retryAfter ?? 1, 1), MAX_RETRY_AFTER_S);
        await this.sleep(waitS * 1000);
      }
    }
  }

  private async request<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = this.redact(err instanceof Error ? err.message : String(err));
      throw new TelegramError(`Telegram ${method} request failed: ${reason}`, 0, reason);
    }

    let data: TelegramResponse<T> | undefined;
    try {
      data = (await res.json()) as TelegramResponse<T>;
    } catch {
      data = undefined;
    }

    if (res.ok && data?.ok) return data.result as T;

    const status = data?.error_code ?? res.status;
    const description = this.redact(data?.description ?? (res.statusText || "unknown error"));
    const retryAfter = data?.parameters?.retry_after;
    throw new TelegramError(`Telegram ${method} failed (${status}): ${description}`, status, description, retryAfter);
  }

  private redact(text: string): string {
    return this.token ? text.split(this.token).join("<redacted>") : text;
  }
}
