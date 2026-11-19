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

  it("attaches a photo to an existing check-in, and 404s for a missing one", async () => {
    const patch = (timestamp: string, photoUri: string) => call(`/api/checkins/${encodeURIComponent(timestamp)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photoUri }),
    });
    const session = (await (await call("/api/auth/get-session")).json()) as { user: { id: string } };
    const photo = `https://photos.example.test/photos/${session.user.id}/a.jpg`;

    expect((await patch("2026-11-14T14:00:00.000Z", photo)).status).toBe(200);
    const list = (await (await call("/api/checkins")).json()) as { timestamp: string; photo_url: string | null }[];
    expect(list.find(r => r.timestamp === "2026-11-14T14:00:00.000Z")?.photo_url).toBe(photo);

    expect((await patch("2026-10-01T14:00:00.000Z", photo)).status).toBe(404);
  });

  it("stores and returns the profile", async () => {
    const put = await call("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Reader", homeBranch: "AN" }) });
    expect(put.status).toBe(200);
    expect(await (await call("/api/profile")).json()).toEqual({ name: "Reader", home_branch: "AN" });
  });

  it("limits photo uploads per user: rate, then storage quota", async () => {
    const original = { PHOTOS_BUCKET: env.PHOTOS_BUCKET, PHOTO_UPLOAD_LIMITER: (env as { PHOTO_UPLOAD_LIMITER?: unknown }).PHOTO_UPLOAD_LIMITER };
    const stored: { key: string; size: number; uploaded: Date }[] = [];
    let allowed = 2;
    Object.assign(env, {
      PHOTOS_BUCKET: {
        async put(key: string, bytes: Uint8Array) { stored.push({ key, size: bytes.byteLength, uploaded: new Date() }); },
        async list({ prefix }: { prefix: string }) {
          return { objects: stored.filter(o => o.key.startsWith(prefix)), truncated: false, delimitedPrefixes: [] };
        },
        async delete(keys: string[]) {
          for (const key of keys) stored.splice(stored.findIndex(o => o.key === key), 1);
        },
      },
      PHOTO_UPLOAD_LIMITER: { async limit() { return { success: allowed-- > 0 }; } },
    });
    try {
      const upload = (body = new Uint8Array(10)) =>
        call("/api/upload/photo?ext=jpg", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body });

      // A rejected file doesn't use up the rate limit.
      expect((await upload(new Uint8Array(0))).status).toBe(400);
      expect((await upload()).status).toBe(200);
      expect((await upload()).status).toBe(200);
      const limited = await upload();
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect(await limited.json()).toMatchObject({ code: "rate_limited" });
      expect(stored).toHaveLength(2);

      // At the quota, with every photo recent: refused before storing.
      allowed = 1;
      const folder = stored[0]!.key.replace(/[^/]+$/, "");
      stored.push(...Array.from({ length: 300 }, (_, i) => ({ key: `${folder}old-${i}.jpg`, size: 1, uploaded: new Date() })));
      const full = await upload();
      expect(full.status).toBe(507);
      expect(await full.json()).toMatchObject({ code: "photo_quota" });
      expect(stored).toHaveLength(302);

      // Once those are over 30 days old, the ones no check-in uses are
      // deleted to make room. a.jpg is attached to this user's check-in
      // above, and old-0.jpg to another user's (allowed before photo URLs
      // were checked per user), so both stay, along with today's 2 uploads.
      allowed = 1;
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      for (const o of stored) if (o.key.includes("/old-")) o.uploaded = old;
      stored.push({ key: `${folder}a.jpg`, size: 1, uploaded: old });
      await createDb(env).insertInto("check_ins").values({
        user_id: "someone-else", branch_code: "AN", timestamp: "2026-01-01T15:00:00.000Z",
        note: "", photo_url: `https://old-bucket.example/${folder}old-0.jpg`,
      }).execute();
      expect((await upload()).status).toBe(200);
      expect(stored.map(o => o.key.replace(folder, ""))).toEqual(expect.arrayContaining(["a.jpg", "old-0.jpg"]));
      expect(stored.filter(o => o.key.includes("/old-"))).toHaveLength(1);
      expect(stored).toHaveLength(5);
    } finally {
      Object.assign(env, original);
    }
  });

  it("signs out", async () => {
    const res = await call("/api/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
