// End-to-end test of the Worker app in Node: the real Hono routes and
// better-auth, against a libsql database file. Covers sign-up, sessions,
// check-ins and CORS, so dependency upgrades (better-auth especially) are
// checked against the routes the app uses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth";
import { createDb } from "../src/db";
import app from "../src/index";

const dir = mkdtempSync(join(tmpdir(), "tpl-auth-"));
const ORIGIN = "https://librarypassport.ca";
const env = {
  TURSO_DATABASE_URL: `file:${join(dir, "test.db")}`,
  TURSO_AUTH_TOKEN: "",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
  BETTER_AUTH_URL: "http://localhost",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  R2_PUBLIC_URL: "https://photos.example.test",
  R2_BUCKET_NAME: "test",
  R2_ACCOUNT_ID: "",
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
  PHOTOS_BUCKET: {} as R2Bucket,
};

let cookie = "";

function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", ORIGIN);
  if (cookie) headers.set("Cookie", cookie);
  return app.request(`http://localhost${path}`, { ...init, headers }, env);
}

function postJson(path: string, body: unknown) {
  return call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  const auth = createAuth(env);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const db = createDb(env);
  await sql`
    CREATE TABLE check_ins (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL, branch_code TEXT NOT NULL, "timestamp" TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', photo_url TEXT, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (user_id, "timestamp")
    )`.execute(db);
  await sql`
    CREATE TABLE user_profile (
      user_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', home_branch TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    )`.execute(db);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Worker app", () => {
  it("answers CORS preflight for the app's origin only", async () => {
    const ok = await call("/api/checkins", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const other = await app.request("http://localhost/api/checkins", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    }, env);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects check-ins without a session", async () => {
    const res = await postJson("/api/checkins", { branchCode: "AN", timestamp: "2026-11-14T14:00:00.000Z" });
    expect(res.status).toBe(401);
  });

  it("signs up with email and returns a session", async () => {
    const res = await postJson("/api/auth/sign-up/email", { email: "reader@example.test", password: "correct-horse-battery", name: "Reader" });
    expect(res.status).toBe(200);
    cookie = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).map(c => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");

    const session = await call("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe("reader@example.test");
  });

  it("saves check-ins, one per branch per Toronto day", async () => {
    expect(await (await postJson("/api/checkins", { branchCode: "AN", timestamp: "2026-11-14T14:00:00.000Z" })).json()).toEqual({ ok: true });
    // 8pm EST the same Toronto day (Nov 15 in UTC): refused, with the kept one named.
    expect(await (await postJson("/api/checkins", { branchCode: "AN", timestamp: "2026-11-15T01:00:00.000Z" })).json())
      .toEqual({ ok: true, duplicateOf: "2026-11-14T14:00:00.000Z" });
    // Next morning: a new day.
    expect(await (await postJson("/api/checkins", { branchCode: "AN", timestamp: "2026-11-15T15:00:00.000Z" })).json()).toEqual({ ok: true });

    const list = (await (await call("/api/checkins")).json()) as { timestamp: string }[];
    expect(list.map(r => r.timestamp)).toEqual(["2026-11-15T15:00:00.000Z", "2026-11-14T14:00:00.000Z"]);
  });

  it("validates check-in input", async () => {
    expect((await postJson("/api/checkins", { branchCode: "AN", timestamp: "Nov 14 2026" })).status).toBe(400);
    expect((await postJson("/api/checkins", {
      branchCode: "AN", timestamp: "2026-11-16T15:00:00.000Z", photoUri: "https://photos.example.test.evil.com/photos/x/a.jpg",
    })).status).toBe(400);
  });

  it("stores and returns the profile", async () => {
    const put = await call("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Reader", homeBranch: "AN" }) });
    expect(put.status).toBe(200);
    expect(await (await call("/api/profile")).json()).toEqual({ name: "Reader", home_branch: "AN" });
  });

  it("signs out", async () => {
    const res = await call("/api/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
