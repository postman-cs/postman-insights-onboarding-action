# postman-insights-onboarding-action

GitHub Action that links Postman Insights discovered services to API Catalog workspaces and git repositories. Designed for Kubernetes discovery-mode deployments where the Insights DaemonSet agent automatically finds running services.

## Scope

After the Postman Insights agent discovers a service on your cluster, this action:

- Polls the API Catalog discovered-services list until the service appears (with configurable timeout).
- Prepares an API Catalog collection for the discovered service in your workspace.
- Links the service to a GitHub repository through the API Catalog git onboarding flow.

This action does **not** deploy the Insights agent, create workspaces, or manage environments. Use [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action) and [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action) for those concerns.

## Prerequisites

- The Postman Insights DaemonSet agent must be running on your cluster in discovery mode.
- The target service must be deployed and running (the agent discovers it from live traffic).
- A Postman workspace and environment must already exist for the service.
- A `postman-access-token` (session token) is required for Bifrost API access.

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
          postman-team-id: ${{ secrets.POSTMAN_TEAM_ID }}
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
          postman-team-id: ${{ secrets.POSTMAN_TEAM_ID }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `project-name` | Yes | | Service name to match against discovered service names. Matches `{cluster-name}/{project-name}` in the API Catalog. |
| `workspace-id` | Yes | | Postman workspace ID to link the discovered service to. |
| `environment-id` | Yes | | Postman environment UID for the onboarding association. |
| `cluster-name` | No | | Insights cluster name. When set, the action matches `{cluster-name}/{project-name}` exactly. When omitted, falls back to suffix matching. |
| `git-owner` | No | `$GITHUB_REPOSITORY_OWNER` | GitHub organization or user for the repository URL. |
| `git-repository-name` | No | `project-name` | GitHub repository name. Defaults to the project name. |
| `postman-access-token` | Yes | | Postman session token for Bifrost API calls. See [Obtaining postman-access-token](#obtaining-postman-access-token-open-alpha). |
| `postman-team-id` | Yes | | Postman team ID included in Bifrost request headers. |
| `github-token` | No | `$GITHUB_TOKEN` | GitHub PAT passed as `git_api_key` to the onboarding endpoint. |
| `poll-timeout-seconds` | No | `120` | Maximum seconds to wait for the service to appear in the discovered list. |
| `poll-interval-seconds` | No | `10` | Seconds between polling attempts. |

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
| `status` | Result: `success`, `not-found`, or `error`. |

## Discovery polling

The Insights agent takes time to discover services after pods start. This action polls the API Catalog discovered-services list at the configured interval until the service appears or the timeout is reached.

- Default timeout: 120 seconds (configurable via `poll-timeout-seconds`).
- Default interval: 10 seconds (configurable via `poll-interval-seconds`).
- If the service is not found after the timeout, the action sets `status` to `not-found` and emits a warning (does not fail the workflow).

For services that take longer to appear (cold cluster, large pod startup time), increase `poll-timeout-seconds` to 300 or more.

## How it works

The action calls three Bifrost API Catalog endpoints:

1. **List discovered services** -- `GET /api/v1/onboarding/discovered-services?status=discovered` to find the numeric service ID by matching the service name.
2. **Prepare collection** -- `POST /api/v1/onboarding/prepare-collection` to create the API Catalog collection entry.
3. **Onboard git** -- `POST /api/v1/onboarding/git` with `via_integrations: false` to link the service to the GitHub repository using the provided PAT.

All calls go through the Bifrost proxy at `bifrost-premium-https-v4.gw.postman.com/ws/proxy` using `service: "api-catalog"`.

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
