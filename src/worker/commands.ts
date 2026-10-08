import { ATS_KINDS, ATS_NAMES, type AtsKind } from "../core/ats/types";
import { parseBoardInput, SLUG_PATTERN } from "../core/ats/detect";
import { MAX_EXCLUDED_WORD_LENGTH } from "../core/config";
import { normalizeExcludedWord } from "../core/match/rules";
import type { CompanyRow, Store, UserRow } from "../core/store/db";
import { TelegramError, type TelegramClient } from "../core/telegram/client";
import { errorMessage, isRecord } from "../core/util";
import { escapeHtml, jobKeyboard, parseCallbackData, truncate } from "../core/telegram/format";
import { buildReport } from "./report";
import { buildStatus } from "./watchdog";

const MAX_MESSAGE_LENGTH = 4000;
const APPLIED_LIMIT = 20;
const MAX_NAME_LENGTH = 100;

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

interface Sender {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
}

interface Message {
  message_id: number;
  from?: Sender;
  chat: Chat;
  text?: string;
}

interface CallbackQuery {
  id: string;
  from: Sender;
  message?: Message;
  data?: string;
}

/** Who sent an update: the owner, an active invited user, or anyone else. */
type Role = "owner" | "member" | "unknown";

function asChat(v: unknown): Chat | undefined {
  if (!isRecord(v) || typeof v.id !== "number" || typeof v.type !== "string") return undefined;
  return { id: v.id, type: v.type };
}

function asSender(v: unknown): Sender | undefined {
  if (!isRecord(v) || typeof v.id !== "number") return undefined;
  return {
    id: v.id,
    ...(typeof v.first_name === "string" && { firstName: v.first_name }),
    ...(typeof v.last_name === "string" && { lastName: v.last_name }),
    ...(typeof v.username === "string" && { username: v.username }),
  };
}

function asMessage(v: unknown): Message | undefined {
  if (!isRecord(v) || typeof v.message_id !== "number") return undefined;
  const chat = asChat(v.chat);
  if (!chat) return undefined;
  const from = asSender(v.from);
  return {
    message_id: v.message_id,
    chat,
    ...(from && { from }),
    ...(typeof v.text === "string" && { text: v.text }),
  };
}

function asCallbackQuery(v: unknown): CallbackQuery | undefined {
  if (!isRecord(v) || typeof v.id !== "string") return undefined;
  const from = asSender(v.from);
  if (!from) return undefined;
  return {
    id: v.id,
    from,
    message: asMessage(v.message),
    ...(typeof v.data === "string" && { data: v.data }),
  };
}

/** "First Last (@username)", or null when Telegram gave no name at all. */
export function displayName(from: Sender): string | null {
  const full = [from.firstName, from.lastName].filter((s) => s?.trim()).join(" ").trim();
  const handle = from.username ? `@${from.username}` : "";
  const name = full && handle ? `${full} (${handle})` : full || handle;
  return name ? truncate(name, MAX_NAME_LENGTH) : null;
}

async function roleOf(userId: number, { store, ownerId }: CommandDeps): Promise<Role> {
  const id = String(userId);
  if (id === ownerId) return "owner";
  return (await store.isActiveUser(id)) ? "member" : "unknown";
}

/**
 * Handles one Telegram update. Only private chats are handled. The owner and active invited
 * users are served (members get a limited command set); an unknown user's first message gets a
 * one-time "this bot is private" reply and the owner a one-time access request notice.
 */
export async function handleUpdate(update: unknown, deps: CommandDeps): Promise<void> {
  if (!isRecord(update)) return;

  const callback = asCallbackQuery(update.callback_query);
  if (callback) {
    if (callback.message?.chat.type !== "private") return;
    const role = await roleOf(callback.from.id, deps);
    if (role !== "unknown") await handleCallback(callback, deps);
    return;
  }

  const message = asMessage(update.message);
  if (!message?.from || message.chat.type !== "private") return;
  const role = await roleOf(message.from.id, deps);
  if (role === "unknown") {
    await handleStranger(message, message.from, deps);
    return;
  }
  await handleMessage(message, role, deps);
}

// ---- unknown users ----

async function handleStranger(msg: Message, from: Sender, { store, telegram, ownerId, now }: CommandDeps): Promise<void> {
  const id = String(from.id);
  const name = displayName(from);
  if (!(await store.recordAccessRequest(id, name, now()))) return; // Already asked once: stay silent.

  try {
    await telegram.sendMessage(
      msg.chat.id,
      `This bot is private. Your Telegram user id is <code>${id}</code> — send it to the bot owner to request access.`,
    );
  } catch (err) {
    console.error(`access request: reply failed: ${err instanceof TelegramError ? err.status : errorMessage(err)}`);
  }
  const who = name ? escapeHtml(name) : "someone";
  await telegram.sendMessage(ownerId, `🔔 Access request from ${who} — id <code>${id}</code>. Tap to allow: <code>/invite ${id}</code>`);
}

// ---- buttons ----

async function handleCallback(cb: CallbackQuery, { store, telegram, now }: CommandDeps): Promise<void> {
  const parsed = parseCallbackData(cb.data ?? "");
  if (!parsed) {
    await telegram.answerCallbackQuery(cb.id, "Unknown button");
    return;
  }
  const delivery = await store.setDeliveryAction(parsed.jobId, String(cb.from.id), parsed.action, now(), cb.message?.message_id ?? null);
  if (!delivery) {
    await telegram.answerCallbackQuery(cb.id, "This job can't be updated");
    return;
  }
  await telegram.answerCallbackQuery(cb.id, parsed.action === "applied" ? "Marked applied" : "Marked skipped");
  if (cb.message) {
    await telegram.editMessageReplyMarkup(cb.message.chat.id, cb.message.message_id, jobKeyboard(parsed.jobId, parsed.action));
  }
}

// ---- commands ----

const OWNER_HELP = [
  "<b>US remote job alerts</b>",
  "",
  `/add &lt;board link&gt; — watch a company (${ATS_KINDS.map((k) => ATS_NAMES[k]).join(", ")})`,
  "/remove &lt;name&gt; — stop watching a company",
  "/companies — list watched companies",
  "/exclude add|remove &lt;word&gt; — skip jobs mentioning a word",
  "/exclude list — show excluded words",
  "/pause — stop alerts (waiting jobs are dropped)",
  "/resume — start alerts again",
  "/invite &lt;user id&gt; — give someone the alerts",
  "/revoke &lt;user id&gt; — stop someone's alerts",
  "/users — list invited users",
  "/status — health and counts",
  "/applied — jobs you marked applied",
  "/report — today's applications so far (sent daily at 09:00 Brazil time for the day before)",
  "/help — this message",
].join("\n");

const MEMBER_HELP = [
  "<b>US remote job alerts</b>",
  "",
  "New US-remote engineering roles (mid-level and up) arrive here. Tap ✅ Applied or ❌ Skip on an alert to track it.",
  "",
  "/status — health and counts",
  "/applied — jobs you marked applied",
  "/report — today's applications so far (sent daily at 09:00 Brazil time for the day before)",
  "/help — this message",
].join("\n");

const OWNER_ONLY = new Set(["add", "remove", "companies", "exclude", "pause", "resume", "invite", "revoke", "users"]);

export const WELCOME_TEXT =
  "You've been given access to the job alerts bot. New US-remote engineering roles (mid-level and up) will arrive here.";

type Reply = (html: string) => Promise<void>;

async function handleMessage(msg: Message, role: Exclude<Role, "unknown">, deps: CommandDeps): Promise<void> {
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

  if (role !== "owner" && OWNER_ONLY.has(command)) return reply("Only the owner can do that.");
  const userId = String(msg.from!.id);

  switch (command) {
    case "start":
    case "help":
      return reply(role === "owner" ? OWNER_HELP : MEMBER_HELP);
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
    case "invite":
      return inviteCommand(args, deps, reply);
    case "revoke":
      return revokeCommand(args, deps, reply);
    case "users":
      return usersCommand(deps, reply);
    case "status": {
      let status = await buildStatus(deps.store, deps.now());
      if (role === "owner") status += `\nInvited users: ${await deps.store.countActiveUsers()}`;
      return reply(status);
    }
    case "report":
      return reply(await buildReport(deps.store, userId, deps.ownerId, "today", deps.now()));
    case "applied":
      return appliedCommand(userId, role === "owner", deps, reply);
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

  // Only fast-tier boards are listed by name: thousands of wide boards would take dozens of messages.
  const fast = active.filter((c) => c.tier === "fast");
  const wide = active.length - fast.length;
  const lines = [`<b>Watching ${active.length} ${active.length === 1 ? "company" : "companies"}</b>`];
  if (wide > 0) lines.push(`${fast.length} checked every 10 minutes (listed below), ${wide} more checked hourly.`);
  const failing = fast.filter((c) => c.failing).length;
  if (failing > 0) lines.push(`⚠️ = failing (${failing})`);
  lines.push(...fast.map((c) => `${escapeHtml(c.name)}${c.failing ? " ⚠️" : ""}`));
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

async function appliedCommand(userId: string, isOwner: boolean, { store }: CommandDeps, reply: Reply): Promise<void> {
  // The owner also sees jobs marked applied before per-user tracking existed.
  const jobs = await store.listApplied(userId, APPLIED_LIMIT, { includeLegacy: isOwner });
  if (jobs.length === 0) {
    return reply("You haven't marked any jobs as applied yet. Tap ✅ Applied on an alert to track it here.");
  }
  const entries = jobs.map(
    (j, i) => `${i + 1}. ${escapeHtml(truncate(j.title, 200))} — ${escapeHtml(truncate(j.companyName, 100))} (${isoDate(j.actionAt)})\n${escapeHtml(j.applyUrl)}`,
  );
  for (const part of chunkLines([`<b>Applied (last ${jobs.length})</b>`, ...entries], MAX_MESSAGE_LENGTH)) await reply(part);
}

// ---- whitelist ----

/** A Telegram user id: 1–20 digits, without leading zeros. Null when invalid. */
export function parseUserId(args: string): string | null {
  if (!/^\d{1,20}$/.test(args)) return null;
  const id = args.replace(/^0+/, "");
  return id === "" ? null : id;
}

const describeUser = (u: Pick<UserRow, "userId" | "name">) =>
  u.name ? `${escapeHtml(u.name)} (id <code>${u.userId}</code>)` : `id <code>${u.userId}</code>`;

async function inviteCommand(args: string, { store, telegram, ownerId, now }: CommandDeps, reply: Reply): Promise<void> {
  const userId = parseUserId(args);
  if (!userId) {
    return reply("Usage: /invite &lt;user id&gt; — the numeric Telegram user id (they get it by messaging this bot).");
  }
  if (userId === ownerId) return reply("You're already the owner.");

  const { status, user } = await store.inviteUser(userId, now());
  if (status === "exists") return reply(`${describeUser(user)} already has access.`);

  const added = `✅ ${status === "reactivated" ? "Re-added" : "Added"} ${describeUser(user)}. They'll get the same job alerts as you.`;
  try {
    await telegram.sendMessage(userId, WELCOME_TEXT);
  } catch (err) {
    if (err instanceof TelegramError && err.status >= 400 && err.status < 500) {
      // 403: they never pressed Start (or blocked the bot); 400: Telegram doesn't know the chat yet.
      return reply(`${added}\n\n⚠️ Added, but they need to open the bot and press Start before alerts can reach them.`);
    }
    console.error(`invite: welcome message failed: ${err instanceof TelegramError ? err.status : errorMessage(err)}`);
    return reply(`${added}\n\n⚠️ The welcome message couldn't be sent right now; alerts will still be tried.`);
  }
  return reply(`${added} A welcome message was sent.`);
}

async function revokeCommand(args: string, { store, ownerId }: CommandDeps, reply: Reply): Promise<void> {
  const userId = parseUserId(args);
  if (!userId) return reply("Usage: /revoke &lt;user id&gt; — see /users for the ids.");
  if (userId === ownerId) return reply("You can't revoke the owner.");
  const user = await store.revokeUser(userId);
  if (!user) return reply(`id <code>${userId}</code> isn't an invited user. Send /users to see the list.`);
  return reply(`🚫 Revoked ${describeUser(user)}. They won't get alerts anymore.`);
}

async function usersCommand({ store }: CommandDeps, reply: Reply): Promise<void> {
  const users = await store.listUsers();
  if (users.length === 0) return reply("No invited users.");
  const lines = [
    `<b>Invited users (${users.length})</b>`,
    ...users.map((u) => `• ${describeUser(u)} — added ${isoDate(u.addedAt)}`),
  ];
  for (const part of chunkLines(lines, MAX_MESSAGE_LENGTH)) await reply(part);
}
