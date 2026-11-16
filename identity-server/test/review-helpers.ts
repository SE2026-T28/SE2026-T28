import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import express from "express";
import { ReviewStore } from "../src/review/review-store.js";
import type { Actor, ReviewItem } from "../src/review/review-store.js";
import { createReviewRouter } from "../src/review/review.routes.js";
import type { ReviewRouterOptions } from "../src/review/review.routes.js";

export const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export const TOKENS: Record<string, Actor> = {
  "admin-token": { id: "admin-1", role: "admin" },
  "reviewer-token": { id: "reviewer-1", role: "reviewer" },
  "reviewer2-token": { id: "reviewer-2", role: "reviewer" },
  "guest-token": { id: "guest-1", role: "guest" },
};

export function makeItem(id = "item-1", overrides: Partial<ReviewItem> = {}): ReviewItem {
  return { id, data: { title: "T", body: "B" }, status: "pending", version: 1, ...overrides };
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Releases every waiter once `parties` callers have arrived (no timers). */
export function createBarrier(parties: number) {
  const gate = deferred();
  let arrived = 0;
  return {
    arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) gate.resolve();
      return gate.promise;
    },
    get arrived() { return arrived; },
  };
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

export interface CallOptions {
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface TestApp {
  store: ReviewStore;
  baseUrl: string;
  call(method: string, path: string, options?: CallOptions): Promise<ApiResponse>;
}

/** Fresh store + express app on an ephemeral loopback port; closed via t.after. */
export async function startApp(
  t: TestContext,
  options: {
    items?: ReviewItem[];
    beforeCommit?: ReviewRouterOptions["beforeCommit"];
    /** Replaces the token-based resolver (e.g. to inject a throwing one). */
    resolveActor?: ReviewRouterOptions["resolveActor"];
  } = {},
): Promise<TestApp> {
  const store = new ReviewStore();
  for (const item of options.items ?? [makeItem()]) store.seed(item);
  const app = express();
  app.use(express.json());
  app.use("/review-items", createReviewRouter({
    store,
    resolveActor: options.resolveActor ?? ((req) => {
      const match = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
      return match ? TOKENS[match[1]] ?? null : null;
    }),
    beforeCommit: options.beforeCommit,
    now: () => new Date(FIXED_NOW),
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    baseUrl,
    async call(method, path, { token, headers = {}, body } = {}) {
      const finalHeaders: Record<string, string> = { ...headers };
      if (token) finalHeaders.authorization = `Bearer ${token}`;
      if (body !== undefined) finalHeaders["content-type"] = "application/json";
      const response = await fetch(`${baseUrl}/review-items${path}`, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: response.status, headers: response.headers, text, json };
    },
  };
}

/** Decision request helper. Omit ifMatch/key to test the missing-header paths. */
export function decide(
  app: TestApp,
  token: string,
  decision: unknown,
  opts: { id?: string; ifMatch?: string; key?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
  if (opts.key !== undefined) headers["idempotency-key"] = opts.key;
  return app.call("POST", `/${opts.id ?? "item-1"}/decision`, { token, headers, body: { decision } });
}

export function patch(app: TestApp, token: string, body: unknown, opts: { id?: string; ifMatch?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
  return app.call("PATCH", `/${opts.id ?? "item-1"}`, { token, headers, body });
}

/** Snapshot string for byte-identical comparisons. */
export function snapshot(store: ReviewStore, id = "item-1"): string {
  return JSON.stringify(store.get(id));
}
