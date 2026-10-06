import { env } from "cloudflare:test";
import type { AtsKind } from "../src/core/ats/types";
import { Store, type CompanyState } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";
import type { InlineKeyboardMarkup } from "../src/core/telegram/format";
import type { PollDeps } from "../src/poller/run";
import { fakeFetcher, json, type RecordedRequest } from "./fake-fetch";

export const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
export const HOUR = 60 * 60 * 1000;

export interface Sent {
  chatId: number | string;
  html: string;
  markup?: InlineKeyboardMarkup;
}

export function fakeTelegram() {
  const sends: Sent[] = [];
  let nextId = 500;
  const tg = {
    sends,
    failNext: false,
    /** Thrown (once) instead of the default ambiguous 502 when failNext is set. */
    failWith: undefined as Error | undefined,
    /** While set, getMe throws (Telegram unreachable). */
    failGetMe: false,
    getMeCalls: 0,
    /** Called after each successful send, e.g. to simulate /pause mid-delivery. */
    onSend: undefined as ((sent: Sent) => void | Promise<void>) | undefined,
    async getMe() {
      tg.getMeCalls++;
      if (tg.failGetMe) throw new Error("Telegram getMe request failed: fetch failed");
      return { id: 42, username: "test_bot" };
    },
    async sendMessage(chatId: number | string, html: string, markup?: InlineKeyboardMarkup) {
      if (tg.failNext) {
        tg.failNext = false;
        const err = tg.failWith ?? new Error("Telegram sendMessage failed (502): Bad Gateway");
        tg.failWith = undefined;
        throw err;
      }
      const sent = { chatId, html, markup };
      sends.push(sent);
      await tg.onSend?.(sent);
      return { messageId: nextId++ };
    },
  };
  return tg;
}

export function leverPosting(
  id: string,
  title: string,
  opts: { location?: string; description?: string; workplaceType?: string; country?: string } = {},
) {
  return {
    id,
    text: title,
    categories: { location: opts.location ?? "United States", allLocations: [opts.location ?? "United States"] },
    workplaceType: opts.workplaceType ?? "remote",
    country: opts.country ?? "US",
    descriptionPlain: opts.description ?? "Build great software.",
    hostedUrl: `https://jobs.lever.co/acme/${id}`,
    createdAt: T0 - HOUR,
  };
}

export function greenhouseJob(id: number, title: string, location = "Remote - US") {
  return {
    id,
    title,
    location: { name: location },
    absolute_url: `https://job-boards.greenhouse.io/globex/jobs/${id}`,
    first_published: new Date(T0 - 2 * HOUR).toISOString(),
  };
}

const LEVER = /^https:\/\/api\.lever\.co\/v0\/postings\/([^/?]+)\?mode=json$/;
const GH_LIST = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs$/;
const GH_DETAIL = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/([^/?]+)\?pay_transparency=true$/;

export interface Boards {
  lever: Record<string, unknown[]>;
  greenhouse: Record<string, unknown[]>;
  /** Greenhouse detail payloads keyed by job id. */
  ghDetail: Record<string, unknown>;
  /** Greenhouse job ids whose detail is 404 (posting removed). Other missing details are 503. */
  ghGone: Set<string>;
  /** Tokens whose requests time out. */
  timeout: Set<string>;
}

/** A fake fetcher that answers from mutable in-memory boards; unknown boards are 404. */
export function boardFetcher(boards: Boards) {
  return fakeFetcher((req: RecordedRequest) => {
    const lever = LEVER.exec(req.url);
    const ghDetail = GH_DETAIL.exec(req.url);
    const ghList = GH_LIST.exec(req.url);
    const token = lever?.[1] ?? ghDetail?.[1] ?? ghList?.[1];
    if (token && boards.timeout.has(token)) {
      throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    }
    if (lever) {
      const postings = boards.lever[lever[1]!];
      return postings ? json(postings) : json({ ok: false, error: "Document not found" }, 404);
    }
    if (ghDetail) {
      const detail = boards.ghDetail[ghDetail[2]!];
      if (detail) return json(detail);
      if (boards.ghGone.has(ghDetail[2]!)) return json({ status: 404, error: "Job not found" }, 404);
      return json({ error: "unavailable" }, 503);
    }
    if (ghList) {
      const jobs = boards.greenhouse[ghList[1]!];
      return jobs ? json({ jobs }) : undefined;
    }
    return undefined;
  });
}

export function emptyBoards(): Boards {
  return { lever: {}, greenhouse: {}, ghDetail: {}, ghGone: new Set(), timeout: new Set() };
}

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM companies"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
}

export function setup(boards: Boards) {
  const clock = { now: T0 };
  const store = new Store(bindingDriver(env.DB), () => clock.now);
  const telegram = fakeTelegram();
  const fetcher = boardFetcher(boards);
  const sleeps: number[] = [];
  const deps: PollDeps = {
    store,
    fetcher,
    telegram,
    ownerId: "1001",
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { clock, store, telegram, fetcher, sleeps, deps };
}

export async function addCompany(
  store: Store,
  name: string,
  ats: AtsKind,
  token: string,
  opts: { state?: CompanyState; baselined?: boolean } = {},
): Promise<number> {
  const { company } = await store.insertCompany({ name, ats, boardToken: token, state: opts.state ?? "active" });
  if (opts.baselined) await env.DB.prepare("UPDATE companies SET baselined = 1 WHERE id = ?").bind(company.id).run();
  return company.id;
}

export async function jobRows(): Promise<Record<string, unknown>[]> {
  const res = await env.DB.prepare(
    "SELECT board_job_id, status, telegram_message_id, location_class, salary_text, title FROM jobs ORDER BY id",
  ).all();
  return res.results;
}

export async function jobStatus(boardJobId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM jobs WHERE board_job_id = ?").bind(boardJobId).first<{ status: string }>();
  return row?.status;
}
