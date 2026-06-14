# Postman Onboarding: Insights Linking

[![CI](https://github.com/postman-cs/postman-insights-onboarding-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-insights-onboarding-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-insights-onboarding-action?sort=semver)](https://github.com/postman-cs/postman-insights-onboarding-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-insights)](https://www.npmjs.com/package/@postman-cse/onboarding-insights) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Links Postman Insights discovered services to API Catalog workspaces and git repositories after deployment, so every service the Insights agent finds lands in your catalog with a collection, a repo link, and live telemetry.

Part of the [Postman API Onboarding suite](https://github.com/postman-cs/postman-api-onboarding-action).

## Usage

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # ... deploy your service to Kubernetes ...

      - uses: postman-cs/postman-insights-onboarding-action@v1
        with:
          project-name: af-cards-activation
          workspace-id: ${{ vars.POSTMAN_WORKSPACE_ID }}
          environment-id: ${{ vars.POSTMAN_ENVIRONMENT_ID }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
```

### Prerequisites

- The Postman Insights DaemonSet agent must be running on your cluster in discovery mode.
- The target service must be deployed and running (the agent discovers it from live traffic).
- A Postman workspace and environment must already exist for the service.
- A `postman-access-token` (session token) is required for Bifrost API access. See [Credentials and Identity](docs/credentials.md).

This action does **not** deploy the Insights agent, create workspaces, or manage environments. Use [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action) and [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action) for those concerns.

## Examples

### Standalone after a Kubernetes deploy

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # ... deploy your service to Kubernetes ...

      - uses: postman-cs/postman-insights-onboarding-action@v1
        with:
          project-name: af-cards-activation
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          environment-id: ${{ steps.sync.outputs.environment-uids-json && fromJSON(steps.sync.outputs.environment-uids-json).prod }}
          cluster-name: my-cluster
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          poll-timeout-seconds: 180
```

### Full onboarding pipeline

```yaml
jobs:
  provision:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: postman-cs/postman-bootstrap-action@v1
        id: bootstrap
        with:
          project-name: af-cards-activation
          spec-url: https://example.com/openapi.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}

      # ... deploy service to Kubernetes ...

      - uses: postman-cs/postman-repo-sync-action@v1
        id: sync
        with:
          project-name: af-cards-activation
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          baseline-collection-id: ${{ steps.bootstrap.outputs.baseline-collection-id }}
          smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
          contract-collection-id: ${{ steps.bootstrap.outputs.contract-collection-id }}
          environments-json: '["prod"]'
          env-runtime-urls-json: '{"prod":"https://api.example.com"}'
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}

      - uses: postman-cs/postman-insights-onboarding-action@v1
        with:
          project-name: af-cards-activation
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          environment-id: ${{ fromJSON(steps.sync.outputs.environment-uids-json).prod }}
          cluster-name: my-cluster
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Tuning discovery polling

The Insights agent takes time to discover services after pods start. The action polls the API Catalog discovered-services list until the service appears or the timeout is reached. For services that take longer to appear (cold cluster, large pod startup time), raise the timeout:

```yaml
      - uses: postman-cs/postman-insights-onboarding-action@v1
        with:
          project-name: af-cards-activation
          workspace-id: ${{ vars.POSTMAN_WORKSPACE_ID }}
          environment-id: ${{ vars.POSTMAN_ENVIRONMENT_ID }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          poll-timeout-seconds: 300
          poll-interval-seconds: 15
```

`poll-timeout-seconds` is clamped to 10-600 and `poll-interval-seconds` to 2-60. If the service never appears within the timeout, the action sets `status` to `not-found` and emits a warning without failing the workflow.

### Credential preflight modes

Before any onboarding write, the action can verify that `postman-api-key` and `postman-access-token` resolve to the same parent organization. Set `credential-preflight` to `enforce` to fail fast on mismatched credentials, or `off` to skip the probes (the default `warn` logs and continues):

```yaml
      - uses: postman-cs/postman-insights-onboarding-action@v1
        with:
          project-name: af-cards-activation
          workspace-id: ${{ vars.POSTMAN_WORKSPACE_ID }}
          environment-id: ${{ vars.POSTMAN_ENVIRONMENT_ID }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          credential-preflight: enforce
```

See [Credentials and Identity](docs/credentials.md) for the full policy, API key auto-creation behavior, and how to obtain the access token.

### Non-GitHub CI via the CLI

The same logic ships as a CLI (`postman-insights-onboard`) for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems:

```bash
npm install -g @postman-cse/onboarding-insights
postman-insights-onboard \
  --project-name af-cards-activation \
  --workspace-id ws_123 \
  --environment-id env_123 \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --cluster-name my-cluster
```

See [CLI Usage](docs/cli.md) for provider auto-detection, output formats, and GitLab/Bitbucket/Azure pipeline examples.

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `project-name` | Service name or Jira/Xray project key to match against the final discovered-service segment | Yes |  |
| `workspace-id` | Postman workspace ID to link the discovered service to | Yes |  |
| `environment-id` | Postman environment UID for the onboarding association | Yes |  |
| `system-environment-id` | Postman system environment UUID for service-level Insights acknowledgment | No |  |
| `cluster-name` | Insights cluster name. When set, matches {cluster-name}/{project-name} exactly in discovered services | No |  |
| `repo-url` | Repository URL for Git onboarding. Auto-detected from CI context when omitted. | No |  |
| `postman-access-token` | Postman access token for Bifrost API calls | Yes |  |
| `postman-team-id` | Explicit Postman team ID for org-mode Bifrost request headers. When omitted, x-entity-team-id is not sent. | No |  |
| `github-token` | Optional GitHub token passed as git_api_key when repository auth is required by onboarding/git | No |  |
| `postman-api-key` | Postman API key (PMAK-*) for the application binding call. Auto-created from postman-access-token when omitted or invalid after a clear 401/403 validation failure. | No |  |
| `credential-preflight` | Credential identity preflight policy. warn (default) logs a note and continues when postman-api-key and postman-access-token resolve to different parent orgs; enforce fails the run on that condition before any onboarding write; off skips the identity probes entirely (the reactive error guidance still applies). A rejected or auto-created postman-api-key is never failed on. | No | `warn` |
| `poll-timeout-seconds` | Maximum seconds to wait for the service to appear in the discovered list | No | `120` |
| `poll-interval-seconds` | Seconds between discovery polling attempts | No | `10` |
<!-- inputs-table:end -->

Supply `postman-team-id` only for org-mode tokens that require an explicit team header. For non-org tokens, leave it unset so Bifrost can infer team context from the access token. Credential details, the preflight policy, and API key auto-creation are documented in [Credentials and Identity](docs/credentials.md).

## Outputs

<!-- outputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `discovered-service-id` | Numeric ID from the API Catalog discovered-services list |  |  |
| `discovered-service-name` | Full cluster/service name of the discovered service |  |  |
| `collection-id` | Collection ID returned by the prepare-collection step |  |  |
| `application-id` | Insights application binding ID from the observability API |  |  |
| `verification-token` | Insights team verification token (tvt_*) for DaemonSet telemetry |  |  |
| `status` | Onboarding result: success, not-found, or error |  |  |
<!-- outputs-table:end -->

Failures set `status=error` before the action exits.

## How it works

**Discovery poll.** The action polls the API Catalog discovered-services list (`GET /api/v1/onboarding/discovered-services?status=discovered` on Bifrost api-catalog) at the configured interval until a service matching `{cluster-name}/{project-name}` appears (suffix matching when `cluster-name` is omitted) or the timeout is reached.

**Catalog prep.** It then calls `POST /api/v1/onboarding/prepare-collection` to create the API Catalog collection entry for the discovered service in your workspace.

**Git link.** `POST /api/v1/onboarding/git` with `via_integrations: false` links the service to the GitHub repository (`repo-url` input, auto-detected from CI context when omitted; `github-token` is passed as `git_api_key` only when the endpoint requires repository auth).

**Acknowledgment.** The action resolves the `svc_*` Akita service ID, marks the service as managed (`POST /v2/api-catalog/services/onboard`), and acknowledges the workspace (`POST /v2/workspaces/{id}/onboarding/acknowledge`) to activate the Insights project.

**Binding.** Finally it creates an application binding with the observability API (`POST /v2/agent/api-catalog/workspaces/{id}/applications`, sent directly to `api.observability.postman.com` rather than through Bifrost), which is required for service graph edge generation, and retrieves the team verification token (`tvt_*`) for DaemonSet telemetry.

For local builds, contract smoke monitoring, and release channels, see [Development and Operations](docs/development.md).

## Resources

### The suite

| Action | Role |
| --- | --- |
| [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) | Entry point: chains workspace bootstrap, repo sync, and optional Insights linking |
| [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) | Mints the service-account access token and team ID |
| [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) | Discovers and exports API specs from AWS services |
| [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) | Creates the workspace, uploads the spec, generates collections |
| [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) | Applies a curated flow.yaml to the Smoke collection |
| [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) | Exports artifacts into the repo and wires CI, mocks, and monitors |
| [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) | Links Insights discovered services to the workspace |

- [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action): mints a service-account access token and team ID.
- [postman-api-onboarding-action](https://github.com/postman-cs/postman-api-onboarding-action): composite action that orchestrates the onboarding pipeline.
- [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action): workspace provisioning, spec upload, and collection generation.
- [postman-smoke-flow-action](https://github.com/postman-cs/postman-smoke-flow-action): applies a curated flow.yaml to the canonical Smoke collection.
- [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action): artifact sync, environments, mocks, monitors, and CI templates.
- [postman-aws-spec-discovery-action](https://github.com/postman-cs/postman-aws-spec-discovery-action): discovers API specs from AWS.
- npm package: [@postman-cse/onboarding-insights](https://www.npmjs.com/package/@postman-cse/onboarding-insights)
- [Postman Insights documentation](https://learning.postman.com/docs/insights/insights-overview/)

## License

[MIT](LICENSE)
