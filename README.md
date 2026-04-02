# postman-insights-onboarding-action

GitHub Action that links Postman Insights discovered services to API Catalog workspaces and git repositories. Designed for Kubernetes discovery-mode deployments where the Insights DaemonSet agent automatically finds running services.

## Scope

After the Postman Insights agent discovers a service on your cluster, this action:

- Polls the API Catalog discovered-services list until the service appears (with configurable timeout).
- Prepares an API Catalog collection for the discovered service in your workspace.
- Links the service to a GitHub repository through the API Catalog git onboarding flow.
- Acknowledges the service and workspace with the Insights backend (Akita).
- Creates an application binding with the observability API (required for service graph edges).
- Retrieves the team verification token for DaemonSet telemetry.

This action does **not** deploy the Insights agent, create workspaces, or manage environments. Use [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action) and [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action) for those concerns.

## Prerequisites

- The Postman Insights DaemonSet agent must be running on your cluster in discovery mode.
- The target service must be deployed and running (the agent discovers it from live traffic).
- A Postman workspace and environment must already exist for the service.
- A `postman-access-token` (session token) is required for Bifrost API access.

## Service name matching

The action matches discovered services to your Postman `project-name` input using these strategies (in order):

1. **Exact match with cluster:** If `cluster-name` is provided, matches `cluster-name/project-name` exactly.
2. **Final-segment exact match:** Without `cluster-name`, matches only when the final path segment equals `project-name` (e.g., `my-cluster/my-service`).
3. **Bracketed Jira/Xray key match:** Without `cluster-name`, matches when the final path segment contains the exact bracketed token `[project-name]` (e.g., `my-cluster/[PROJ-123] my tests` matches when `project-name` is `PROJ-123`).

This keeps matching explicit for Jira/Xray-style names without allowing unrelated cluster prefixes or partial service names to bind the wrong discovered service.

## Usage

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # ... deploy your service to Kubernetes ...

      - uses: postman-cs/postman-insights-onboarding-action@v0
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

### With the full onboarding pipeline

```yaml
jobs:
  provision:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: postman-cs/postman-bootstrap-action@v0
        id: bootstrap
        with:
          project-name: af-cards-activation
          spec-url: https://example.com/openapi.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}

      # ... deploy service to Kubernetes ...

      - uses: postman-cs/postman-repo-sync-action@v0
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

      - uses: postman-cs/postman-insights-onboarding-action@v0
        with:
          project-name: af-cards-activation
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          environment-id: ${{ fromJSON(steps.sync.outputs.environment-uids-json).prod }}
          cluster-name: my-cluster
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## CLI Usage (Non-GitHub CI)

The CLI is available for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems. GitHub Actions users should continue using the `action.yml` interface.

Install globally:

```bash
npm install -g postman-insights-onboarding-action
```

Basic usage:

```bash
postman-insights-onboard \
  --project-name af-cards-activation \
  --workspace-id ws_123 \
  --environment-id env_123 \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --postman-api-key "$POSTMAN_API_KEY" \
  --cluster-name my-cluster \
  --repo-url https://gitlab.com/acme/af-cards-activation \
  --poll-timeout-seconds 180 \
  --result-json /tmp/insights-result.json \
  --dotenv-path /tmp/insights.env
```

The CLI auto-detects the CI provider from environment variables and uses that to resolve the repo URL and owner. For non-GitHub repositories, API Catalog git onboarding is skipped because of a backend limitation, but the remaining Insights steps continue normally.

Output is JSON to stdout. Use `--result-json` to write the same payload to a file, or `--dotenv-path` to write shell-sourceable `KEY=VALUE` pairs with the `POSTMAN_INSIGHTS_` prefix. All logs go to stderr, and stdout is reserved for JSON output.

### GitLab CI

```yaml
onboarding:
  image: node:24
  script:
    - npm install -g postman-insights-onboarding-action
    - postman-insights-onboard --project-name af-cards-activation --workspace-id "$WORKSPACE_ID" --environment-id "$ENVIRONMENT_ID" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --postman-api-key "$POSTMAN_API_KEY" --cluster-name "$CLUSTER_NAME" --repo-url "$CI_PROJECT_URL" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
```

### Bitbucket Pipelines

```yaml
image: node:24

pipelines:
  default:
    - step:
        script:
          - npm install -g postman-insights-onboarding-action
          - postman-insights-onboard --project-name af-cards-activation --workspace-id "$WORKSPACE_ID" --environment-id "$ENVIRONMENT_ID" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --postman-api-key "$POSTMAN_API_KEY" --cluster-name "$CLUSTER_NAME" --repo-url "$BITBUCKET_GIT_HTTP_ORIGIN" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
```

### Azure DevOps

```yaml
pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'
  - script: |
      npm install -g postman-insights-onboarding-action
      postman-insights-onboard --project-name af-cards-activation --workspace-id "$(WORKSPACE_ID)" --environment-id "$(ENVIRONMENT_ID)" --postman-access-token "$(POSTMAN_ACCESS_TOKEN)" --postman-api-key "$(POSTMAN_API_KEY)" --cluster-name "$(CLUSTER_NAME)" --repo-url "$(BUILD_REPOSITORY_URI)" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
    displayName: Run Postman Insights onboarding
```

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `project-name` | Yes | | Service name or Jira/Xray project key used for strict discovered-service matching. With `cluster-name`, matches `{cluster-name}/{project-name}` exactly. Without `cluster-name`, matches only the final segment exactly or an exact bracketed token such as `[PROJ-123]` in that final segment. |
| `workspace-id` | Yes | | Postman workspace ID to link the discovered service to. |
| `environment-id` | Yes | | Postman environment UID for the onboarding association. |
| `system-environment-id` | No | | Postman system environment UUID for service-level Insights acknowledgment. Falls back to the value from the discovered service record. |
| `cluster-name` | No | | Insights cluster name. When set, the action matches `{cluster-name}/{project-name}` exactly. When omitted, it first checks the final service-name segment for an exact `project-name` match, then for a bracketed Jira/Xray token such as `[PROJ-123]`. |
| `repo-url` | No | Auto-detected from CI when available | Repository URL used for Git onboarding. |
| `postman-access-token` | Yes | | Postman session token for Bifrost API calls. See [Obtaining postman-access-token](#obtaining-postman-access-token-open-alpha). |
| `postman-team-id` | No | | Explicit Postman team ID for org-mode Bifrost requests. When omitted, the action leaves `x-entity-team-id` unset so Bifrost resolves team context from the access token. |
| `github-token` | No | ambient `GITHUB_TOKEN` env when exported by the workflow | Optional GitHub token passed as `git_api_key` only when repository auth is required by the onboarding endpoint. |
| `postman-api-key` | No | | Postman API key (`PMAK-*`) for the application binding call to the observability API. Auto-created from `postman-access-token` when omitted or invalid after a clear 401/403 validation failure. |
| `poll-timeout-seconds` | No | `120` | Maximum seconds to wait for the service to appear in the discovered list. Clamped to 10--600. |
| `poll-interval-seconds` | No | `10` | Seconds between polling attempts. Clamped to 2--60. |

Supply `postman-team-id` only for org-mode tokens that require an explicit team header. For non-org tokens, leave it unset so Bifrost can infer team context from the access token.

If `postman-api-key` is omitted or the `/me` validation call returns `401` or `403`, the action creates a new API key via the Bifrost identity service using the `postman-access-token`. Network failures and unexpected validation responses fail the action instead of silently rotating credentials.

### Obtaining `postman-access-token` (Open Alpha)

> **Open-alpha limitation:** The `postman-access-token` input requires a manually-extracted session token. There is currently no public API to exchange a Postman API key (PMAK) for an access token programmatically. This manual step will be eliminated before GA.

The `postman-access-token` is a Postman session token (`x-access-token`) required for the Bifrost API Catalog onboarding endpoints. Without it, this action cannot function.

**To obtain and configure the token:**

1. **Log in via the Postman CLI** (requires a browser):
   ```bash
   postman login
   ```

2. **Extract the access token:**
   ```bash
   cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
   ```

3. **Set it as a GitHub secret:**
   ```bash
   gh secret set POSTMAN_ACCESS_TOKEN --repo <owner>/<repo>
   ```

> **Important:** This token is session-scoped and will expire. When it does, the action will fail. You will need to repeat the login and secret update process.

## Outputs

| Output | Notes |
| --- | --- |
| `discovered-service-id` | Numeric ID from the API Catalog discovered-services list. |
| `discovered-service-name` | Full `cluster/service` name of the discovered service. |
| `collection-id` | Collection ID returned by the prepare-collection step. |
| `application-id` | Insights application binding ID from the observability API. |
| `verification-token` | Insights team verification token (`tvt_*`) for DaemonSet telemetry. |
| `status` | Result: `success`, `not-found`, or `error`. Failures set `status=error` before the action exits. |

## Discovery polling

The Insights agent takes time to discover services after pods start. This action polls the API Catalog discovered-services list at the configured interval until the service appears or the timeout is reached.

- Default timeout: 120 seconds (configurable via `poll-timeout-seconds`, clamped to 10--600).
- Default interval: 10 seconds (configurable via `poll-interval-seconds`, clamped to 2--60).
- If the service is not found after the timeout, the action sets `status` to `not-found` and emits a warning (does not fail the workflow).

For services that take longer to appear (cold cluster, large pod startup time), increase `poll-timeout-seconds` to 300 or more.

## How it works

The action calls the following API endpoints in order:

1. **List discovered services** -- `GET /api/v1/onboarding/discovered-services?status=discovered` (Bifrost api-catalog) to find the numeric service ID by matching the service name.
2. **Prepare collection** -- `POST /api/v1/onboarding/prepare-collection` (Bifrost api-catalog) to create the API Catalog collection entry.
3. **Onboard git** -- `POST /api/v1/onboarding/git` (Bifrost api-catalog) with `via_integrations: false` to link the service to the GitHub repository.
4. **Resolve provider service ID** -- `GET /v2/api-catalog/services?status=discovered&...` (Bifrost akita) to find the `svc_*` Akita service ID.
5. **Service-level acknowledge** -- `POST /v2/api-catalog/services/onboard` (Bifrost akita) to mark the service as managed.
6. **Application binding** -- `POST /v2/agent/api-catalog/workspaces/{id}/applications` (direct to `api.observability.postman.com`, NOT Bifrost) to bind the workspace to the Insights application. Required for service graph edge generation.
7. **Workspace acknowledge** -- `POST /v2/workspaces/{id}/onboarding/acknowledge` (Bifrost akita) to activate the Insights project.
8. **Team verification token** -- `GET /v2/workspaces/{id}/team-verification-token` (Bifrost akita) to retrieve the DaemonSet telemetry token.

## Contract smoke monitoring

This repo includes `.github/workflows/contract-smoke.yml`, a scheduled live contract check for the upstream APIs used by Insights onboarding.

Configure these repository secrets before enabling the workflow:

- `SMOKE_ORG_API_KEY`
- `SMOKE_ORG_ACCESS_TOKEN`

The smoke workflow verifies `/me`, `/teams`, `iapub.postman.co/api/sessions/current`, and Bifrost API key creation so auth or payload drift shows up in CI before it hits production onboarding runs.

## Local development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` produces `dist/index.cjs`, the bundled action entrypoint referenced by `action.yml`.

## Open-Alpha Release Strategy

- Open-alpha channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.1.0` for reproducibility.
- Moving tag `v0` is used as the rolling open-alpha channel.
