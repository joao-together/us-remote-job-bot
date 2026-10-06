import { ATS_KINDS, ATS_NAMES, type AtsKind } from "../core/ats/types";
import { parseBoardInput, SLUG_PATTERN } from "../core/ats/detect";
import { MAX_EXCLUDED_WORD_LENGTH } from "../core/config";
import { normalizeExcludedWord } from "../core/match/rules";
import type { CompanyRow, Store } from "../core/store/db";
import type { TelegramClient } from "../core/telegram/client";
import { isRecord } from "../core/util";
import { escapeHtml, jobKeyboard, parseCallbackData, truncate } from "../core/telegram/format";
import { buildStatus } from "./watchdog";

const MAX_MESSAGE_LENGTH = 4000;
const APPLIED_LIMIT = 20;

export type CommandTelegram = Pick<TelegramClient, "sendMessage" | "editMessageReplyMarkup" | "answerCallbackQuery">;

export interface CommandDeps {
  store: Store;
  telegram: CommandTelegram;
  ownerId: string;
  now: () => number;
}

interface Chat {
  id: number;
  type: string;
}

interface Message {
  message_id: number;
  from?: { id: number };
  chat: Chat;
  text?: string;
}

interface CallbackQuery {
  id: string;
  from: { id: number };
  message?: Message;
  data?: string;
}

function asChat(v: unknown): Chat | undefined {
  if (!isRecord(v) || typeof v.id !== "number" || typeof v.type !== "string") return undefined;
  return { id: v.id, type: v.type };
}

function senderId(v: unknown): number | undefined {
  return isRecord(v) && typeof v.id === "number" ? v.id : undefined;
}

function asMessage(v: unknown): Message | undefined {
  if (!isRecord(v) || typeof v.message_id !== "number") return undefined;
  const chat = asChat(v.chat);
  if (!chat) return undefined;
  const fromId = senderId(v.from);
  return {
    message_id: v.message_id,
    chat,
    ...(fromId !== undefined && { from: { id: fromId } }),
    ...(typeof v.text === "string" && { text: v.text }),
  };
}

function asCallbackQuery(v: unknown): CallbackQuery | undefined {
  if (!isRecord(v) || typeof v.id !== "string") return undefined;
  const fromId = senderId(v.from);
  if (fromId === undefined) return undefined;
  return {
    id: v.id,
    from: { id: fromId },
    message: asMessage(v.message),
    ...(typeof v.data === "string" && { data: v.data }),
  };
}

function isOwnerInPrivate(fromId: number | undefined, chat: Chat | undefined, ownerId: string): boolean {
  return fromId !== undefined && String(fromId) === ownerId && chat?.type === "private";
}

/** Handles one Telegram update. Anything not from the owner in a private chat is ignored. */
export async function handleUpdate(update: unknown, deps: CommandDeps): Promise<void> {
  if (!isRecord(update)) return;

  const callback = asCallbackQuery(update.callback_query);
  if (callback) {
    if (isOwnerInPrivate(callback.from.id, callback.message?.chat, deps.ownerId)) await handleCallback(callback, deps);
    return;
  }

  const message = asMessage(update.message);
  if (message && isOwnerInPrivate(message.from?.id, message.chat, deps.ownerId)) {
    await handleMessage(message, deps);
  }
}

// ---- buttons ----

async function handleCallback(cb: CallbackQuery, { store, telegram, now }: CommandDeps): Promise<void> {
  const parsed = parseCallbackData(cb.data ?? "");
  if (!parsed) {
    await telegram.answerCallbackQuery(cb.id, "Unknown button");
    return;
  }
  const job = await store.setUserAction(parsed.jobId, parsed.action, now());
  if (!job) {
    await telegram.answerCallbackQuery(cb.id, "This job can't be updated");
    return;
  }
  await telegram.answerCallbackQuery(cb.id, parsed.action === "applied" ? "Marked applied" : "Marked skipped");
  if (cb.message) {
    await telegram.editMessageReplyMarkup(cb.message.chat.id, cb.message.message_id, jobKeyboard(parsed.jobId, parsed.action));
  }
}

// ---- commands ----

const HELP = [
  "<b>US remote job alerts</b>",
  "",
  `/add &lt;board link&gt; — watch a company (${ATS_KINDS.map((k) => ATS_NAMES[k]).join(", ")})`,
  "/remove &lt;name&gt; — stop watching a company",
  "/companies — list watched companies",
  "/exclude add|remove &lt;word&gt; — skip jobs mentioning a word",
  "/exclude list — show excluded words",
  "/pause — stop alerts (waiting jobs are dropped)",
  "/resume — start alerts again",
  "/status — health and counts",
  "/applied — jobs you marked applied",
  "/help — this message",
].join("\n");

type Reply = (html: string) => Promise<void>;

async function handleMessage(msg: Message, deps: CommandDeps): Promise<void> {
  const reply: Reply = async (html) => {
    await deps.telegram.sendMessage(msg.chat.id, html);
  };
  const text = msg.text?.trim() ?? "";
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) {
    await reply("Send /help to see what I can do.");
    return;
  }
  const command = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();

  switch (command) {
    case "start":
    case "help":
      return reply(HELP);
    case "add":
      return addCommand(args, deps, reply);
    case "remove":
      return removeCommand(args, deps, reply);
    case "companies":
      return companiesCommand(deps, reply);
    case "exclude":
      return excludeCommand(args, deps, reply);
    case "pause":
      await deps.store.pause();
      return reply("⏸ Paused. Jobs waiting to be sent were dropped, and new matches won't be sent. Send /resume to start again.");
    case "resume":
      await deps.store.resume();
      return reply("▶️ Resumed. You'll get alerts for jobs found from now on.");
    case "status":
      return reply(await buildStatus(deps.store, deps.now()));
    case "applied":
      return appliedCommand(deps, reply);
    default:
      return reply("Unknown command. Send /help to see what I can do.");
  }
}

const BOARD_LINK_EXAMPLE =
  "Send the job board link, like https://jobs.lever.co/acme or https://boards.greenhouse.io/acme";

async function addCommand(args: string, { store }: CommandDeps, reply: Reply): Promise<void> {
  if (!args) return reply(`Usage: /add &lt;board link&gt;\n${escapeHtml(BOARD_LINK_EXAMPLE)}`);
  const parsed = parseBoardInput(args);
  if ("error" in parsed) return reply(`❌ ${escapeHtml(parsed.error)}`);
  if ("slug" in parsed) {
    return reply(`I can't tell which job board "${escapeHtml(parsed.slug)}" is on. ${escapeHtml(BOARD_LINK_EXAMPLE)}`);
  }

  const { status, company } = await store.insertCompany({
    name: parsed.token,
    ats: parsed.ats,
    boardToken: parsed.token,
    state: "pending_validation",
  });
  const name = escapeHtml(company.name);
  if (status === "exists") return reply(`Already watching ${name}.`);
  if (status === "reactivated") return reply(`⏳ Re-checking ${name} within the hour.`);
  return reply(`⏳ ${name} will be checked within the hour. I'll confirm here.`);
}

const describeBoard = (c: CompanyRow) => `${escapeHtml(c.name)} (${c.ats}:${escapeHtml(c.boardToken)})`;

/** Accepts a name, a board token, or "ats:token" to pick one of several matches. */
async function removeCommand(args: string, { store }: CommandDeps, reply: Reply): Promise<void> {
  if (!args) return reply("Usage: /remove &lt;company name&gt;");

  let lookup = args;
  let ats: AtsKind | undefined;
  const qualified = /^([a-z]+):(.+)$/i.exec(args);
  const kind = qualified?.[1]?.toLowerCase() as AtsKind | undefined;
  if (qualified && kind && ATS_KINDS.includes(kind) && SLUG_PATTERN.test(qualified[2]!)) {
    ats = kind;
    lookup = qualified[2]!;
  }

  const matches = (await store.findCompaniesByName(lookup)).filter(
    (c) => c.state !== "inactive" && (ats === undefined || (c.ats === ats && c.boardToken.toLowerCase() === lookup.toLowerCase())),
  );
  if (matches.length === 0) return reply(`Not watching any company called "${escapeHtml(args)}". Send /companies to see the list.`);
  if (matches.length > 1) {
    const lines = matches.map((c) => `• ${describeBoard(c)}`);
    return reply(
      `Several companies match "${escapeHtml(args)}":\n${lines.join("\n")}\n\nSend /remove with the board, like /remove ${matches[0]!.ats}:${escapeHtml(matches[0]!.boardToken)}`,
    );
  }
  const company = matches[0]!;
  await store.setCompanyState(company.id, "inactive");
  return reply(`🗑 Stopped watching ${escapeHtml(company.name)}.`);
}

async function companiesCommand({ store }: CommandDeps, reply: Reply): Promise<void> {
  const companies = await store.listCompanies();
  const active = companies.filter((c) => c.state === "active");
  const pending = companies.filter((c) => c.state === "pending_validation");
  if (companies.length === 0) return reply("Not watching any companies yet. Add one with /add &lt;board link&gt;.");

  const lines = [`<b>Watching ${active.length} ${active.length === 1 ? "company" : "companies"}</b>`];
  const failing = active.filter((c) => c.failing).length;
  if (failing > 0) lines.push(`⚠️ = failing (${failing})`);
  lines.push(...active.map((c) => `${escapeHtml(c.name)}${c.failing ? " ⚠️" : ""}`));
  if (pending.length > 0) {
    lines.push("", `<b>Waiting for validation (${pending.length})</b>`, ...pending.map(describeBoard));
  }
  for (const part of chunkLines(lines, MAX_MESSAGE_LENGTH)) await reply(part);
}

/** Joins lines into messages no longer than `max` characters. */
export function chunkLines(lines: string[], max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= max) {
      current = next;
    } else {
      if (current) out.push(current);
      current = line.slice(0, max);
    }
  }
  if (current) out.push(current);
  return out;
}

async function excludeCommand(args: string, { store }: CommandDeps, reply: Reply): Promise<void> {
  const [, sub = "", rest = ""] = /^(\S*)\s*([\s\S]*)$/.exec(args) ?? [];
  const action = sub.toLowerCase();

  let words: string[];
  if (action === "list") {
    words = (await store.getSettings()).excludedWords;
  } else if (action === "add" || action === "remove") {
    const word = normalizeExcludedWord(rest);
    if (word === null) {
      return reply(`Usage: /exclude ${action} &lt;word&gt; (1–${MAX_EXCLUDED_WORD_LENGTH} characters)`);
    }
    words = action === "add" ? await store.addExcludedWord(word) : await store.removeExcludedWord(word);
  } else {
    return reply("Usage: /exclude add &lt;word&gt;, /exclude remove &lt;word&gt; or /exclude list");
  }

  if (words.length === 0) return reply("No excluded words.");
  return reply(`<b>Excluded words</b>\n${words.map((w) => `• ${escapeHtml(w)}`).join("\n")}`);
}

const isoDate = (at: number | null) => (at === null ? "?" : new Date(at).toISOString().slice(0, 10));

async function appliedCommand({ store }: CommandDeps, reply: Reply): Promise<void> {
  const jobs = await store.listApplied(APPLIED_LIMIT);
  if (jobs.length === 0) {
    return reply("You haven't marked any jobs as applied yet. Tap ✅ Applied on an alert to track it here.");
  }
  const entries = jobs.map(
    (j, i) => `${i + 1}. ${escapeHtml(truncate(j.title, 200))} — ${escapeHtml(truncate(j.companyName, 100))} (${isoDate(j.actionAt)})\n${escapeHtml(j.applyUrl)}`,
  );
  for (const part of chunkLines([`<b>Applied (last ${jobs.length})</b>`, ...entries], MAX_MESSAGE_LENGTH)) await reply(part);
}
