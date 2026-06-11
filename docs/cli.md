# CLI Usage (Non-GitHub CI)

The CLI is available for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems. GitHub Actions users should continue using the `action.yml` interface.

Install globally:

```bash
npm install -g @postman-cse/onboarding-insights
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

## GitLab CI

```yaml
onboarding:
  image: node:24
  script:
    - npm install -g @postman-cse/onboarding-insights
    - postman-insights-onboard --project-name af-cards-activation --workspace-id "$WORKSPACE_ID" --environment-id "$ENVIRONMENT_ID" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --postman-api-key "$POSTMAN_API_KEY" --cluster-name "$CLUSTER_NAME" --repo-url "$CI_PROJECT_URL" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
```

## Bitbucket Pipelines

```yaml
image: node:24

pipelines:
  default:
    - step:
        script:
          - npm install -g @postman-cse/onboarding-insights
          - postman-insights-onboard --project-name af-cards-activation --workspace-id "$WORKSPACE_ID" --environment-id "$ENVIRONMENT_ID" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --postman-api-key "$POSTMAN_API_KEY" --cluster-name "$CLUSTER_NAME" --repo-url "$BITBUCKET_GIT_HTTP_ORIGIN" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
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
      postman-insights-onboard --project-name af-cards-activation --workspace-id "$(WORKSPACE_ID)" --environment-id "$(ENVIRONMENT_ID)" --postman-access-token "$(POSTMAN_ACCESS_TOKEN)" --postman-api-key "$(POSTMAN_API_KEY)" --cluster-name "$(CLUSTER_NAME)" --repo-url "$(BUILD_REPOSITORY_URI)" --poll-timeout-seconds 180 --result-json insights-result.json --dotenv-path insights.env
    displayName: Run Postman Insights onboarding
```
