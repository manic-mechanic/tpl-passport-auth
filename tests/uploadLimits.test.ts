import { describe, expect, it } from "vitest";
import { enforcePhotoQuota, photoKeyFromUrl } from "../src/uploadLimits";

const NOW = new Date("2026-11-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

type Obj = { key: string; size: number; uploaded: Date };

// A stand-in for R2's list() and delete(), paging `pageSize` objects at a time.
function bucket(objects: Obj[], pageSize = 1000) {
  const stored = [...objects];
  const calls = { list: 0, deleted: [] as string[] };
  const b = {
    stored, calls,
    async list({ prefix, cursor }: { prefix?: string; cursor?: string }) {
      calls.list++;
      const matching = stored.filter(o => o.key.startsWith(prefix ?? ""));
      const start = Number(cursor ?? 0);
      const page = matching.slice(start, start + pageSize);
      const next = start + pageSize;
      return next < matching.length
        ? { objects: page, truncated: true, cursor: String(next), delimitedPrefixes: [] }
        : { objects: page, truncated: false, delimitedPrefixes: [] };
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) {
        calls.deleted.push(key);
        stored.splice(stored.findIndex(o => o.key === key), 1);
      }
    },
  };
  return b as unknown as R2Bucket & typeof b;
}

const photos = (n: number, size = 10, uploaded = daysAgo(3), user = "u1") =>
  Array.from({ length: n }, (_, i) => ({ key: `photos/${user}/${i}.jpg`, size, uploaded }));

const limits = { photos: 5, bytes: 1000 };
const run = (b: R2Bucket, incomingBytes: number, referenced: string[] = [], unmatched = 0) =>
  enforcePhotoQuota({ bucket: b, userId: "u1", incomingBytes, referencedKeys: async () => ({ keys: new Set(referenced), unmatched }), now: NOW, limits });

describe("enforcePhotoQuota", () => {
  it("allows an upload under both limits, counting only the user's folder", async () => {
    const b = bucket([...photos(2, 100), ...photos(10, 100, daysAgo(3), "u2")]);
    expect(await run(b, 100)).toMatchObject({ ok: true, count: 2, bytes: 200, deleted: 0 });
  });

  it("refuses past the photo count when every photo is in use", async () => {
    const b = bucket(photos(5));
    const all = b.stored.map(o => o.key);
    expect(await run(b, 10, all)).toMatchObject({ ok: false, count: 5, deleted: 0 });
    expect(b.calls.deleted).toEqual([]);
  });

  it("refuses the upload that would pass the byte limit", async () => {
    const b = bucket(photos(2, 400));
    const all = b.stored.map(o => o.key);
    expect(await run(b, 200, all)).toMatchObject({ ok: true });
    expect(await run(b, 201, all)).toMatchObject({ ok: false, error: expect.stringContaining("storage") });
  });

  it("frees space by deleting photos no check-in uses, then allows the upload", async () => {
    const b = bucket(photos(5));
    const used = ["photos/u1/0.jpg", "photos/u1/1.jpg"];
    expect(await run(b, 10, used)).toMatchObject({ ok: true, count: 2, deleted: 3 });
    expect(b.stored.map(o => o.key)).toEqual(used);
  });

  it("keeps unused photos less than a day old, which may not be attached yet", async () => {
    const b = bucket([...photos(4), { key: "photos/u1/new.jpg", size: 10, uploaded: daysAgo(0.5) }]);
    const used = b.stored.slice(0, 4).map(o => o.key);
    expect(await run(b, 10, used)).toMatchObject({ ok: false, deleted: 0 });
    expect(b.stored).toHaveLength(5);
  });

  it("deletes nothing when a check-in's photo URL can't be matched to a key", async () => {
    const b = bucket(photos(5));
    expect(await run(b, 10, ["photos/u1/0.jpg"], 1)).toMatchObject({ ok: false, deleted: 0 });
    expect(b.calls.deleted).toEqual([]);
  });

  it("only looks up which photos are used once the quota is reached", async () => {
    let looked = 0;
    const b = bucket(photos(2));
    await enforcePhotoQuota({ bucket: b, userId: "u1", incomingBytes: 10, referencedKeys: async () => { looked++; return { keys: new Set<string>(), unmatched: 0 }; }, now: NOW, limits });
    expect(looked).toBe(0);
  });

  it("counts across pages", async () => {
    const b = bucket(photos(7), 2);
    const all = b.stored.map(o => o.key);
    expect(await run(b, 10, all)).toMatchObject({ ok: false, count: 7 });
    expect(b.calls.list).toBe(4);
  });
});

describe("photoKeyFromUrl", () => {
  it("finds the user's key whatever the host or base path", () => {
    expect(photoKeyFromUrl("https://photos.librarypassport.ca/photos/u1/a.jpg", "u1")).toBe("photos/u1/a.jpg");
    expect(photoKeyFromUrl("https://pub-abc.r2.dev/photos/u1/a.jpg", "u1")).toBe("photos/u1/a.jpg");
    expect(photoKeyFromUrl("https://pub-abc.r2.dev/bucket/photos/u1/a.jpg", "u1")).toBe("photos/u1/a.jpg");
  });

  it("doesn't match another user's photo, a look-alike id, or a non-URL", () => {
    expect(photoKeyFromUrl("https://p.example/photos/u2/a.jpg", "u1")).toBeNull();
    expect(photoKeyFromUrl("https://p.example/photos/u10/a.jpg", "u1")).toBeNull();
    expect(photoKeyFromUrl("not a url", "u1")).toBeNull();
  });
});
