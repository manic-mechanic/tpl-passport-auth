# @tpl-passport/shared — Migration Plan

This package is the canonical source of truth for branch data and pure logic shared
between the RN app (`tpl-passport-rn`) and the web app (`tpl-passport`).

## What lives here

| Path | Contents |
|------|----------|
| `src/types.ts` | `Branch`, `Route`, `CheckIn`, `Profile` interfaces |
| `src/region.ts` | `physicalBranches`, `branchesByAlphaPage`, `haversineKm`, `filterBranches`, etc. |
| `src/stamp.ts` | `getStampColor`, `getStampShape`, `getStampFont`, `getStampRotation`, `getStampOpacity` |
| `src/badges.ts` | `BADGES`, `BADGE_DISPLAY_ORDER`, `buildBadgeCtx`, compass helpers |
| `src/index.ts` | Re-exports everything above |
| `data/branch-info.json` | Canonical branch list (100 physical branches) |
| `data/branch-hours.json` | Branch hours, keyed by BranchCode |
| `data/routes.json` | Curated walking/transit routes |

`branch-history.json` is RN-only (narrative history content) and stays in `tpl-passport-rn/src/data/`.

## Package setup

No build step. Both Metro (RN) and Nuxt/Vite (web) transpile TypeScript directly:
- `main: "src/index.ts"` — importers get the raw TS source
- `types: "src/index.ts"` — same file serves as type entry

Run `npm install` from the auth repo root to link the workspace.

## RN integration (done)

1. `package.json` — `"@tpl-passport/shared": "file:../tpl-passport-auth/packages/shared"`
2. `metro.config.js` — `watchFolders` + `unstable_enableSymlinks: true`
3. `src/composables/useRegion.ts` → `export * from '@tpl-passport/shared'`
4. `src/composables/useBadges.ts` → imports from `@tpl-passport/shared`
5. `src/composables/useStamp.ts` → `export * from '@tpl-passport/shared'`
6. `src/types/index.ts` → re-exports types from `@tpl-passport/shared`
7. `src/components/BranchDetail.tsx` → imports `branch-hours.json` from `@tpl-passport/shared/data/branch-hours.json`
8. Deleted `src/shared/region.ts`, `src/shared/badges.ts`, `src/shared/stamp.ts`, `src/shared/badges.test.ts`
9. Deleted `src/data/branch-info.json`, `src/data/branch-hours.json`, `src/data/routes.json`

## Web integration (deferred — testers active)

The web app (`tpl-passport`) is largely Vue/JS with some TS. When ready:

1. Add `"@tpl-passport/shared": "file:../tpl-passport-auth/packages/shared"` to web `package.json`
2. In `nuxt.config.ts`: `build: { transpile: ['@tpl-passport/shared'] }`
3. Replace `composables/useRegion.js` with `export * from '@tpl-passport/shared'`
4. Replace `composables/useStamp.js` with `export * from '@tpl-passport/shared'`
5. Replace `composables/useBadges.js` with imports from `@tpl-passport/shared`
6. Update `data/` imports to point to `@tpl-passport/shared/data/`
7. Delete the now-redundant web-side copies of branch-info, routes, etc.

**Note:** The web app still uses old branch codes JD/PE. These have been renamed
to DGH (Daniel G. Hill) and JT (Junction Triangle) in the canonical data. Verify
any hardcoded references in web templates before migrating.

## Updating branch data going forward

The canonical data files live in `packages/shared/data/`. When branch data changes:
- Update `branch-info.json` here (not in either app repo)
- Update `branch-hours.json` here (fetch script lives in `tpl-passport-rn/scripts/`)
- Both apps pick up the change automatically on next `npm install` / Metro restart
