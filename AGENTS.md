# postman-insights-onboarding-action

Links Postman Insights discovered services to API Catalog workspaces + git repos after deployment, so every service Insights agent finds lands in catalog w/ collection, repo link, live telemetry. Linking runs through Bifrost. Dual entry: GitHub Action (`dist/index.cjs`/`dist/action.cjs`) + CLI (`dist/cli.cjs`, bin `postman-insights-onboard`).

## Structure

```
src/
  index.ts                     # Action entry: reads inputs, links, sets outputs
  main.ts                      # Core: resolve services -> link workspace + repo
  cli.ts                       # CLI adapter
  contracts.ts                 # I/O types
  lib/
    input.ts                   # Shared Action/CLI INPUT_* adapter
    bifrost-client.ts          # Bifrost adapter (Insights linking, workspace/repo association)
    credential-identity.ts     # Session identity (iapub + access token) for team scope
    postman/base-urls.ts       # Base URL resolution
    http-error.ts, retry.ts, secrets.ts, error-advice.ts
tests/
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run verify:dist:assert  # read-only: shebang/exec/census/builtins + git diff
npm run verify:dist         # rebuild + git diff + assert
```

## Key Behaviors

- **Service linking**: Resolves Insights-discovered services, associates each w/ API Catalog workspace + originating git repo via Bifrost.
- **Team scope**: From session identity (`credential-identity.ts`). `POSTMAN_TEAM_ID` = explicit org-mode override for `x-entity-team-id`; otherwise Bifrost infers team context.
- **Governance credential**: Uses access token for Bifrost calls (can expire). `BifrostCatalogClient` takes `AccessTokenProvider`, re-mints token once on 401/UNAUTHENTICATED for `api-catalog` path. `akita` (Insights) path = platform wall for service-account identities: 401 "Postman User not found" on every route (api-catalog returns 200 w/ same token). `createApplication` 401s on both `x-access-token` + `x-api-key` for SA — completing Insights acknowledgment needs token w/ Postman *user* identity. Proof: `scripts/probe-insights-akita.ts`.

## Gotchas

- Build emits three bundles: `index.cjs`, `action.cjs`, `cli.cjs`. Wire pre-link logic into shared code path all three entries call.
- If Bifrost linking fails, verify proxy service/path + auth headers w/ curl before changing code.
- Never log access tokens, PMAKs, credentials, or secrets; mask sensitive output.

## CI

`.github/workflows/ci.yml` bundles once, queues at most two checks on one runner. Typecheck once. Dist read-only `verify:dist:assert`; no pack race. Every check prints `::group::` result even on failure.

See workspace `../../docs/CI.md` for shared rationale.

## Anti-Patterns

- Never hardcode secrets, tokens, or absolute paths in durable memory
