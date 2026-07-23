# Development and Operations

## Local development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` produces `dist/index.cjs` (package entry), `dist/action.cjs` (the bundled action entrypoint referenced by `action.yml`), and `dist/cli.cjs` (the CLI).

Regenerate the README input/output tables after changing `action.yml`:

```bash
npm run docs:tables
```

## Contract smoke monitoring

This repo includes `.github/workflows/contract-smoke.yml`, a scheduled live contract check for the upstream APIs used by Insights onboarding.

Configure these repository secrets before enabling the workflow:

- `SMOKE_ORG_API_KEY`: a human-user PMAK used by the smoke workflow for bounded `/me` validation and observability application binding.

Scheduled and manual smoke runs first execute a secret preflight. If `SMOKE_ORG_API_KEY` is missing, the workflow writes a notice and job summary, sets `run_smoke=false`, and skips the live API contract job without failing the repository.

The smoke workflow verifies the human-user `/me` shape, checks `iapub.postman.co/api/sessions/current` for `consumerType=user`, and verifies API key creation so auth or payload drift shows up in CI before it hits onboarding runs.

## Release strategy

- Immutable release tags use `v1.x.y`.
- Consumers can pin immutable tags such as `v1.0.0` for reproducibility.
- Moving tag `v1` tracks the latest release for convenience.
- See [Release Policy](../RELEASE_POLICY.md) for tag, npm, and validation rules.
