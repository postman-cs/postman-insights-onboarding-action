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

- `SMOKE_ORG_API_KEY`
- `SMOKE_ORG_ACCESS_TOKEN`

The smoke workflow verifies `/me`, `/teams`, `iapub.postman.co/api/sessions/current`, and Bifrost API key creation so auth or payload drift shows up in CI before it hits production onboarding runs.

## Release strategy (Customer Preview)

- Customer Preview channel tags use `v1.x.y`.
- Consumers can pin immutable tags such as `v1.0.0` for reproducibility.
- Moving tag `v1` is used as the rolling customer preview channel.
