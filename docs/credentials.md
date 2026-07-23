# Credentials and Identity

Insights linking requires two credentials for the same workspace-admin human user:

- `postman-api-key`: a human-user PMAK. The action validates it with bounded `GET /me` and uses it only for observability application lookup/create.
- `postman-access-token`: a human-user session access token. The action validates that iapub reports `consumerType=user` and uses it for Bifrost and Akita calls.

Service-account PMAKs and access tokens fail before any linking write. A missing or expired user token also fails: this action does not mint or refresh access tokens from a PMAK.

```yaml
- uses: postman-cs/postman-insights-onboarding-action@v2
  with:
    project-name: core-payments
    workspace-id: ${{ vars.POSTMAN_WORKSPACE_ID }}
    environment-id: ${{ vars.POSTMAN_ENVIRONMENT_ID }}
    postman-api-key: ${{ secrets.POSTMAN_INSIGHTS_USER_PMAK }}
    postman-access-token: ${{ secrets.POSTMAN_INSIGHTS_USER_ACCESS_TOKEN }}
```

`create-api-key=true` is an explicit opt-in to create a durable key. Any created key is validated as a human-user PMAK before linking continues. It does not create or derive a user session token.

## Team scope

Supply `postman-team-id` only for org-mode tokens that require `x-entity-team-id`. Leave it unset for non-org tokens so Bifrost resolves context from the user access token. Team identity is never inferred from `/teams` or PMAK `/me`.
