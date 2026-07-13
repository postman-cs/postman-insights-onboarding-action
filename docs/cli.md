# CLI Usage (Non-GitHub CI)

The CLI is available for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems. GitHub Actions users should continue using the `action.yml` interface.

Install globally:

```bash
npm install -g @postman-cse/onboarding-insights
```

Mint a service-account access token first:

```bash
POSTMAN_REGION="${POSTMAN_REGION:-us}"
TOKEN_JSON=$(npx @postman-cse/onboarding-resolve-service-token --postman-api-key "$POSTMAN_API_KEY" --postman-region "$POSTMAN_REGION")
export POSTMAN_ACCESS_TOKEN=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON).token)')
export POSTMAN_TEAM_ID=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON)["team-id"])')
```

Basic usage:

```bash
postman-insights-onboard \
  --project-name af-cards-activation \
  --workspace-id ws_123 \
  --environment-id env_123 \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --postman-team-id "$POSTMAN_TEAM_ID" \
  --postman-api-key "$POSTMAN_API_KEY" \
  --postman-region "$POSTMAN_REGION" \
  --cluster-name my-cluster \
  --repo-url https://gitlab.com/acme/af-cards-activation \
  --poll-timeout-seconds 180 \
  --result-json artifacts/insights-result.json \
  --dotenv-path artifacts/insights.env
```

The CLI auto-detects the CI provider from environment variables and uses that to resolve the repo URL and owner. For non-GitHub repositories, API Catalog git onboarding is skipped because of a backend limitation, but the remaining Insights steps continue normally.

Output is JSON to stdout. `--result-json` is opt-in and writes the same payload only when provided; `--dotenv-path` optionally writes shell-sourceable `KEY=VALUE` pairs with the `POSTMAN_INSIGHTS_` prefix. Output paths must stay inside the current workspace; writes publish atomically. All logs go to stderr, and stdout is reserved for JSON output. `--help` and `--version` exit without credentials, telemetry, network access, or file writes.

CLI flags are canonical and override both inherited `INPUT_FOO-BAR` and `INPUT_FOO_BAR` forms. Without an explicit flag, the two environment forms must match or the command fails before side effects. `POSTMAN_ACCESS_TOKEN` and `POSTMAN_API_KEY` are not implicit aliases: pass them with `--postman-access-token` and `--postman-api-key` as shown above. `POSTMAN_TEAM_ID` remains the documented fallback for `--postman-team-id`.

## GitLab CI

```yaml
onboarding:
  image: node:24
  script:
    - npm install -g @postman-cse/onboarding-insights
    - export POSTMAN_REGION="${POSTMAN_REGION:-us}"
    - TOKEN_JSON=$(npx @postman-cse/onboarding-resolve-service-token --postman-api-key "$POSTMAN_API_KEY" --postman-region "$POSTMAN_REGION")
    - export POSTMAN_ACCESS_TOKEN=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON).token)')
    - export POSTMAN_TEAM_ID=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON)["team-id"])')
    - postman-insights-onboard --project-name af-cards-activation --workspace-id "$WORKSPACE_ID" --environment-id "$ENVIRONMENT_ID" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --postman-team-id "$POSTMAN_TEAM_ID" --postman-api-key "$POSTMAN_API_KEY" --postman-region "$POSTMAN_REGION" --cluster-name "$CLUSTER_NAME" --repo-url "$CI_PROJECT_URL" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
```

## Bitbucket Pipelines

```yaml
image: node:24

pipelines:
  default:
    - step:
        script:
          - npm install -g @postman-cse/onboarding-insights
          - export POSTMAN_REGION="${POSTMAN_REGION:-us}"
          - TOKEN_JSON=$(npx @postman-cse/onboarding-resolve-service-token --postman-api-key "$POSTMAN_API_KEY" --postman-region "$POSTMAN_REGION")
          - export POSTMAN_ACCESS_TOKEN=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON).token)')
          - export POSTMAN_TEAM_ID=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON)["team-id"])')
          - postman-insights-onboard --project-name af-cards-activation --workspace-id "$WORKSPACE_ID" --environment-id "$ENVIRONMENT_ID" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --postman-team-id "$POSTMAN_TEAM_ID" --postman-api-key "$POSTMAN_API_KEY" --postman-region "$POSTMAN_REGION" --cluster-name "$CLUSTER_NAME" --repo-url "$BITBUCKET_GIT_HTTP_ORIGIN" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
```

## Azure DevOps

```yaml
pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '24.x'
  - script: |
      npm install -g @postman-cse/onboarding-insights
      POSTMAN_REGION="${POSTMAN_REGION:-us}"
      TOKEN_JSON=$(npx @postman-cse/onboarding-resolve-service-token --postman-api-key "$(POSTMAN_API_KEY)" --postman-region "$POSTMAN_REGION")
      POSTMAN_ACCESS_TOKEN=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON).token)')
      POSTMAN_TEAM_ID=$(TOKEN_JSON="$TOKEN_JSON" node -e 'process.stdout.write(JSON.parse(process.env.TOKEN_JSON)["team-id"])')
      postman-insights-onboard --project-name af-cards-activation --workspace-id "$(WORKSPACE_ID)" --environment-id "$(ENVIRONMENT_ID)" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --postman-team-id "$POSTMAN_TEAM_ID" --postman-api-key "$(POSTMAN_API_KEY)" --postman-region "$POSTMAN_REGION" --cluster-name "$(CLUSTER_NAME)" --repo-url "$(BUILD_REPOSITORY_URI)" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
    displayName: Run Postman Insights onboarding
```
