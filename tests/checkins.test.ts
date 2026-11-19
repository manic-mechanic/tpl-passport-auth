import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb } from "../src/db";
import { saveCheckIn } from "../src/checkins";

// Runs the real SQL against an in-memory libsql database with the same
// unique key the production table's ON CONFLICT relies on.
let db: ReturnType<typeof createDb>;

beforeEach(async () => {
  db = createDb({ TURSO_DATABASE_URL: ":memory:", TURSO_AUTH_TOKEN: "" });
  await sql`
    CREATE TABLE check_ins (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      branch_code TEXT NOT NULL,
      "timestamp" TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      photo_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (user_id, "timestamp")
    )
  `.execute(db);
});

const base = { userId: "u1", branchCode: "AN", note: "", photoUri: null };

async function rows() {
  return db.selectFrom("check_ins").select(["user_id", "branch_code", "timestamp", "note", "photo_url"]).orderBy("timestamp").execute();
}

describe("saveCheckIn", () => {
  it("saves an evening visit and the next morning's as separate days", async () => {
    // 8pm EST Nov 14 (01:00 UTC Nov 15), then 10am EST Nov 15.
    expect(await saveCheckIn(db, { ...base, timestamp: "2026-11-15T01:00:00.000Z" })).toEqual({ duplicateOf: null });
    expect(await saveCheckIn(db, { ...base, timestamp: "2026-11-15T15:00:00.000Z" })).toEqual({ duplicateOf: null });
    expect(await rows()).toHaveLength(2);
  });

  it("keeps the first check-in for a branch and Toronto day and reports it", async () => {
    // 9am and 8pm EST on Nov 14 (the second is Nov 15 in UTC).
    await saveCheckIn(db, { ...base, timestamp: "2026-11-14T14:00:00.000Z" });
    expect(await saveCheckIn(db, { ...base, timestamp: "2026-11-15T01:00:00.000Z" }))
      .toEqual({ duplicateOf: "2026-11-14T14:00:00.000Z" });
    expect(await rows()).toHaveLength(1);
  });

  it("updates the note and photo when the same timestamp is re-sent", async () => {
    await saveCheckIn(db, { ...base, timestamp: "2026-11-14T14:00:00.000Z", note: "first" });
    expect(await saveCheckIn(db, { ...base, timestamp: "2026-11-14T14:00:00.000Z", note: "edited", photoUri: "https://p/x.jpg" }))
      .toEqual({ duplicateOf: null });
    expect(await rows()).toMatchObject([{ note: "edited", photo_url: "https://p/x.jpg" }]);
  });

  it("keeps the stored photo when a check-in is re-sent without one", async () => {
    // e.g. a note edit from a device that doesn't have the photo yet
    await saveCheckIn(db, { ...base, timestamp: "2026-11-14T14:00:00.000Z", photoUri: "https://p/x.jpg" });
    await saveCheckIn(db, { ...base, timestamp: "2026-11-14T14:00:00.000Z", note: "edited", photoUri: null });
    expect(await rows()).toMatchObject([{ note: "edited", photo_url: "https://p/x.jpg" }]);
  });

  it("still updates an edit when an older same-day duplicate exists", async () => {
    // Two same-day rows can exist from before this rule; editing either must work.
    await db.insertInto("check_ins").values([
      { user_id: "u1", branch_code: "AN", timestamp: "2026-11-14T14:00:00.000Z", note: "", photo_url: null },
      { user_id: "u1", branch_code: "AN", timestamp: "2026-11-14T20:00:00.000Z", note: "", photo_url: null },
    ]).execute();
    expect(await saveCheckIn(db, { ...base, timestamp: "2026-11-14T20:00:00.000Z", note: "edited" })).toEqual({ duplicateOf: null });
    expect((await rows())[1].note).toBe("edited");
  });

  it("allows the same day at a different branch, and other users", async () => {
    await saveCheckIn(db, { ...base, timestamp: "2026-11-14T14:00:00.000Z" });
    expect(await saveCheckIn(db, { ...base, branchCode: "TRL", timestamp: "2026-11-14T15:00:00.000Z" })).toEqual({ duplicateOf: null });
    expect(await saveCheckIn(db, { ...base, userId: "u2", timestamp: "2026-11-14T16:00:00.000Z" })).toEqual({ duplicateOf: null });
    expect(await rows()).toHaveLength(3);
  });

  it("lets only one of two concurrent same-day check-ins in", async () => {
    const results = await Promise.all([
      saveCheckIn(db, { ...base, timestamp: "2026-11-14T14:00:00.000Z" }),
      saveCheckIn(db, { ...base, timestamp: "2026-11-14T15:00:00.000Z" }),
    ]);
    expect(await rows()).toHaveLength(1);
    expect(results.filter(r => r?.duplicateOf === null)).toHaveLength(1);
  });
});
