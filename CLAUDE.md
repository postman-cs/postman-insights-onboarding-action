# postman-insights-onboarding-action

Links Postman Insights discovered services (from Kubernetes DaemonSet agent) to API Catalog workspaces and git repositories. Polls for service discovery, prepares collections, creates application bindings, and retrieves verification tokens.

## Structure

```
src/
  index.ts              # Main logic: polling, onboarding steps, API key validation/rotation
  lib/
    bifrost-client.ts   # BifrostCatalogClient -- all API Catalog and Akita endpoint calls
    http-error.ts       # Typed HTTP error class
    retry.ts            # Exponential backoff
    secrets.ts          # Secret masking
tests/                  # vitest unit tests
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run check:dist   # build + git diff --exit-code
```

## Onboarding Flow (8 API calls in sequence)

1. `GET discovered-services` -- poll until service appears (configurable timeout/interval)
2. `POST prepare-collection` -- create API Catalog collection entry
3. `POST onboarding/git` -- link service to GitHub repo
4. `GET api-catalog/services` -- resolve Akita `svc_*` service ID
5. `POST services/onboard` -- acknowledge service as managed
6. `POST applications` -- bind workspace to Insights app (direct to `api.observability.postman.com`, NOT Bifrost)
7. `POST onboarding/acknowledge` -- activate Insights project
8. `GET team-verification-token` -- retrieve DaemonSet telemetry token (`tvt_*`)

## Key Behaviors

- **API key auto-creation**: If `postman-api-key` is omitted or fails 401/403 validation, creates a new PMAK from `postman-access-token` via Bifrost identity service
- **Team ID**: Uses explicit `postman-team-id` input; logs when present, notes omission so Bifrost resolves from access token
- **Service matching**: Matches `{cluster-name}/{project-name}` exactly when cluster set; otherwise matches the final service-name segment exactly, then checks for a bracketed Jira/Xray token like `[PROJ-123]`
- **Graceful timeout**: If service not found after polling, sets `status=not-found` with warning (does not fail workflow)

## Gotchas

- Application binding goes to `api.observability.postman.com` directly, NOT through Bifrost proxy
- No CLI entry point yet (unlike bootstrap and repo-sync)
- `@actions/core` version is `^3.0.0` (newer than other actions which use `^1.11.1`)
- Poll timeout clamped to 10-600s, interval clamped to 2-60s
