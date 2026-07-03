# postman-insights-onboarding-action

Links Postman Insights discovered services to API Catalog workspaces and git repositories after deployment, so every service the Insights agent finds lands in the catalog with a collection, a repo link, and live telemetry. Linking runs through Bifrost. Dual entry: GitHub Action (`dist/index.cjs` / `dist/action.cjs`) and CLI (`dist/cli.cjs`, bin `postman-insights-onboard`).

## Structure

```
src/
  index.ts                     # GitHub Action entry: reads inputs, links services, sets outputs
  main.ts                      # Core orchestration: resolve services -> link workspace + repo
  cli.ts                       # CLI adapter for non-GitHub CI
  contracts.ts                 # Input/output type definitions
  lib/
    bifrost-client.ts          # Bifrost adapter (Insights service linking, workspace/repo association)
    credential-identity.ts     # Session identity (iapub + access token) for team scope
    postman/
      base-urls.ts             # Postman/Bifrost base URL resolution
    http-error.ts              # Typed HTTP error class
    retry.ts                   # Exponential backoff
    secrets.ts                 # Secret masking utility
    error-advice.ts            # User-facing remediation hints
tests/
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run verify:dist  # CI/hook gate: rebuild + git diff (dev runs build)
```

## Key Behaviors

- **Service linking**: Resolves Insights-discovered services and associates each with an API Catalog workspace and the originating git repository via Bifrost.
- **Team scope**: Derived from session identity (`credential-identity.ts`); `POSTMAN_TEAM_ID` is an explicit org-mode override for `x-entity-team-id`, otherwise Bifrost infers team context.
- **Governance credential**: Uses the access token for Bifrost calls (it can expire). `BifrostCatalogClient` takes an `AccessTokenProvider` and re-mints the token once on a 401/UNAUTHENTICATED for the `api-catalog` path. The `akita` (Insights) path is a platform wall for service-account identities: it answers `401 "Postman User not found"` on every route (api-catalog returns 200 with the same token), and `createApplication` 401s on both `x-access-token` and `x-api-key` for a service account — completing the Insights acknowledgment requires a token with a Postman *user* identity. Proof: `scripts/probe-insights-akita.ts`.

## Gotchas

- Build emits three bundles: `index.cjs`, `action.cjs`, and `cli.cjs`. Wire pre-link logic into the shared code path all three entries call, so every bundle picks it up.
- If Bifrost linking fails, verify the proxy service/path and auth headers with curl before changing code.

## CI

`.github/workflows/ci.yml` runs a single `gate` job that fans out lint, typecheck, test, dist, commitlint, and actionlint
as backgrounded shell processes on one runner: wall-clock is `max(gate)`, not
`sum`, setup runs once, and every gate prints its result under a `::group::`
block even when another fails.

See the workspace `docs/CI.md` for the shared rationale.
