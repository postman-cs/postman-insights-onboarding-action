# CLI Usage (Non-GitHub CI)

The CLI is available for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems. GitHub Actions users should use the `action.yml` interface.

Insights requires two secrets from the same workspace-admin human user:

- `POSTMAN_INSIGHTS_USER_PMAK`: a human-user PMAK used only for `GET /me` and observability application binding.
- `POSTMAN_INSIGHTS_USER_ACCESS_TOKEN`: a human-user session access token used for Bifrost and Akita. Its iapub identity must report `consumerType=user`.

Service-account credentials are rejected. The CLI never mints or refreshes an access token from a PMAK.

```bash
npm install -g @postman-cse/onboarding-insights
postman-insights-onboard \
  --project-name af-cards-activation \
  --workspace-id ws_123 \
  --environment-id env_123 \
  --postman-api-key "$POSTMAN_INSIGHTS_USER_PMAK" \
  --postman-access-token "$POSTMAN_INSIGHTS_USER_ACCESS_TOKEN" \
  --postman-region us \
  --cluster-name my-cluster \
  --repo-url https://gitlab.com/acme/af-cards-activation \
  --poll-timeout-seconds 180 \
  --result-json artifacts/insights-result.json \
  --dotenv-path artifacts/insights.env
```

Output is JSON on stdout. `--result-json` and `--dotenv-path` are opt-in, atomic writes inside the current workspace. Logs go to stderr. `--help` and `--version` exit without credentials, telemetry, network access, or file writes.

CLI flags override inherited `INPUT_FOO-BAR` and `INPUT_FOO_BAR` forms. `POSTMAN_ACCESS_TOKEN` and `POSTMAN_API_KEY` are not implicit aliases: pass the dedicated user credentials with `--postman-access-token` and `--postman-api-key`. `POSTMAN_TEAM_ID` remains the fallback for `--postman-team-id` when an explicit org-mode team header is needed.

## CI example

```yaml
onboarding:
  image: node:24
  script:
    - npm install -g @postman-cse/onboarding-insights
    - postman-insights-onboard --project-name af-cards-activation --workspace-id "$WORKSPACE_ID" --environment-id "$ENVIRONMENT_ID" --postman-api-key "$POSTMAN_INSIGHTS_USER_PMAK" --postman-access-token "$POSTMAN_INSIGHTS_USER_ACCESS_TOKEN" --postman-region us --cluster-name "$CLUSTER_NAME" --repo-url "$CI_PROJECT_URL"
```
