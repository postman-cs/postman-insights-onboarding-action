# Credentials and Identity

This action uses two credentials with different scopes:

- `postman-access-token` (required): a Postman session token used for the Bifrost API Catalog onboarding endpoints.
- `postman-api-key` (optional, `PMAK-*`): used for the application binding call to the observability API.

## Obtaining `postman-access-token` (Customer Preview)

> **Customer Preview limitation:** The `postman-access-token` input requires a manually-extracted session token. There is currently no public API to exchange a Postman API key (PMAK) for an access token programmatically. This manual step will be eliminated before GA.

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

## API key auto-creation

If `postman-api-key` is omitted or the `/me` validation call returns `401` or `403`, the action creates a new API key via the Bifrost identity service using the `postman-access-token`. Network failures and unexpected validation responses fail the action instead of silently rotating credentials.

## Credential preflight (`credential-preflight`)

Before any onboarding write, the action can probe both credentials and compare the parent organization each one resolves to. Mismatched credentials (for example, an API key from a different team than the access token) are a common source of confusing onboarding failures.

- `warn` (default): logs a note and continues when `postman-api-key` and `postman-access-token` resolve to different parent orgs.
- `enforce`: fails the run on that condition before any onboarding write.
- `off`: skips the identity probes entirely. Reactive error guidance still applies when calls fail.

A rejected or auto-created `postman-api-key` is never failed on.

## Team scope (`postman-team-id`)

Supply `postman-team-id` only for org-mode tokens that require an explicit team header. When set, it is sent as `x-entity-team-id` on Bifrost requests. For non-org tokens, leave it unset so Bifrost can infer team context from the access token. The `POSTMAN_TEAM_ID` environment variable is honored when the input is empty.
