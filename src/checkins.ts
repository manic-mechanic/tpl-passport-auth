import { sql } from "kysely";
import { checkInDayKey, dayRangeUtc } from "@tpl-passport/shared/src/date";
import type { createDb } from "./db";

type Db = ReturnType<typeof createDb>;

export type SaveCheckInResult = { duplicateOf: string | null } | null;

// Saves a check-in, keeping one per user+branch per library day
// (America/Toronto, the same rule as the app).
//
// One statement inserts the check-in, or updates its note and photo when this
// timestamp already exists (an edit), unless a different check-in already
// holds this branch and day, e.g. one made on another device. A single
// statement is atomic, so two concurrent requests can't both get in.
//
// Returns { duplicateOf: null } when saved, { duplicateOf: <kept timestamp> }
// when another check-in holds the day, or null for an unusable timestamp.
export async function saveCheckIn(
  db: Db,
  ci: { userId: string; branchCode: string; timestamp: string; note: string; photoUri: string | null },
): Promise<SaveCheckInResult> {
  const range = dayRangeUtc(checkInDayKey(ci.timestamp));
  if (!range) return null;

  const result = await sql`
    INSERT INTO check_ins (user_id, branch_code, "timestamp", note, photo_url)
    SELECT ${ci.userId}, ${ci.branchCode}, ${ci.timestamp}, ${ci.note}, ${ci.photoUri}
    WHERE EXISTS (
      SELECT 1 FROM check_ins WHERE user_id = ${ci.userId} AND "timestamp" = ${ci.timestamp}
    ) OR NOT EXISTS (
      SELECT 1 FROM check_ins
      WHERE user_id = ${ci.userId} AND branch_code = ${ci.branchCode}
        AND "timestamp" >= ${range.start} AND "timestamp" < ${range.end}
        AND "timestamp" <> ${ci.timestamp}
    )
    ON CONFLICT (user_id, "timestamp") DO UPDATE SET
      note = excluded.note,
      photo_url = excluded.photo_url
  `.execute(db);

  if (Number(result.numAffectedRows ?? 0) > 0) return { duplicateOf: null };

  const kept = await db
    .selectFrom("check_ins")
    .select("timestamp")
    .where("user_id", "=", ci.userId)
    .where("branch_code", "=", ci.branchCode)
    .where("timestamp", ">=", range.start)
    .where("timestamp", "<", range.end)
    .orderBy("timestamp", "asc")
    .executeTakeFirst();
  return { duplicateOf: kept?.timestamp ?? null };
}
