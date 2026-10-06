import type { Fetcher } from "../src/core/ats/types";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

export type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** A fetch stand-in that answers from routes and records every request; unmatched URLs get 404. */
export function fakeFetcher(...routes: Route[]): Fetcher & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(req);
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    return new Response("Not Found", { status: 404 });
  };
  return Object.assign(fn as Fetcher, { requests });
}

/** Route matching an exact URL (and optional method). */
export function on(url: string, respond: (req: RecordedRequest) => Response, method?: string): Route {
  return (req) => (req.url === url && (!method || req.method === method) ? respond(req) : undefined);
}
