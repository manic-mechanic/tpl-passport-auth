import { describe, expect, it } from "vitest";
import { checkPhotoQuota } from "../src/uploadLimits";

// A stand-in for R2's list(): pages of `pageSize` objects under the prefix.
function bucket(sizes: number[], pageSize = 1000) {
  const calls: string[] = [];
  return {
    calls,
    async list({ prefix, cursor }: { prefix?: string; cursor?: string }) {
      calls.push(prefix ?? "");
      const start = Number(cursor ?? 0);
      const objects = sizes.slice(start, start + pageSize).map((size, i) => ({ key: `${prefix}${start + i}.jpg`, size }));
      const next = start + pageSize;
      return next < sizes.length
        ? { objects, truncated: true as const, cursor: String(next), delimitedPrefixes: [] }
        : { objects, truncated: false as const, delimitedPrefixes: [] };
    },
  } as unknown as R2Bucket & { calls: string[] };
}

const limits = { photos: 5, bytes: 1000 };

describe("checkPhotoQuota", () => {
  it("allows an upload under both limits and only looks under the user's prefix", async () => {
    const b = bucket([100, 100]);
    expect(await checkPhotoQuota(b, "u1", 100, limits)).toMatchObject({ ok: true, count: 2, bytes: 200 });
    expect(b.calls).toEqual(["photos/u1/"]);
  });

  it("refuses the upload past the photo count", async () => {
    expect(await checkPhotoQuota(bucket([10, 10, 10, 10]), "u1", 10, limits)).toMatchObject({ ok: true });
    expect(await checkPhotoQuota(bucket([10, 10, 10, 10, 10]), "u1", 10, limits)).toMatchObject({ ok: false, count: 5 });
  });

  it("refuses the upload that would pass the byte limit", async () => {
    expect(await checkPhotoQuota(bucket([400, 400]), "u1", 200, limits)).toMatchObject({ ok: true });
    expect(await checkPhotoQuota(bucket([400, 400]), "u1", 201, limits)).toMatchObject({ ok: false, error: expect.stringContaining("storage") });
  });

  it("counts across pages, and stops listing once over the limit", async () => {
    const many = bucket(Array(12).fill(1), 2);
    expect(await checkPhotoQuota(many, "u1", 1, limits)).toMatchObject({ ok: false });
    expect(many.calls.length).toBe(3); // 6 objects seen, already over 5
    const few = bucket([1, 1, 1], 2);
    expect(await checkPhotoQuota(few, "u1", 1, limits)).toMatchObject({ ok: true, count: 3 });
  });
});
