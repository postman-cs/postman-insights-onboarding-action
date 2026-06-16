# Credentials and Identity

This action calls two backend families that demand two different Postman identity classes. The API Catalog surface accepts a service account; the Insights/Akita surface that actually binds the service to the workspace does not. Read the limitation below before wiring credentials, because a service-account-only setup completes the early steps and then fails the link.

- `postman-api-key` (`PMAK-*`): used for the application-binding call to the observability host. This call requires a **user-account PMAK** belonging to a workspace Admin (see the limitation below); a service-account PMAK is rejected. If omitted or rejected with `401`/`403`, the action attempts a short-lived replacement through the Postman identity service, which does not resolve the user-identity requirement.
- `postman-access-token` (required): the access token for the integration calls. The API Catalog calls accept a service-account access token; the Akita onboarding and bind calls require a **user session access token** (see the limitation below).
- `postman-team-id` (recommended): the team ID emitted by the service-token action, used as `x-entity-team-id` for org-mode integration calls.

## Insights linking requires a user identity (current limitation)

The Akita backend behind Postman Insights does not accept service-account identities. A complete link therefore needs a user-account identity in addition to the service-account key:

- The Akita onboarding and binding calls (`POST /v2/api-catalog/services/onboard`, `POST /v2/workspaces/{workspace-id}/onboarding/acknowledge`, and the team-verification-token read) require a **user session access token**. A service-account access token returns `401 "Postman User not found"`; a PMAK returns `403`. A user session token cannot be minted from a PMAK.
- The Insights agent's traffic ingest to `api.observability.postman.com` (`x-api-key`, the `createApplication` binding call) requires a **user-account PMAK** belonging to a workspace Admin. A service-account PMAK returns `401 "Postman User not found"`.
- The agent PMAK and the onboard access token must belong to the same human.

The service-account key still carries the `api-catalog` Bifrost calls and galactus event ingest, so the discovery, prepare-collection, and git-onboard steps succeed on a service account alone. The link then fails at the Akita and observability surfaces, so the Insights service is never bound to the workspace.

Until Akita accepts service-account tokens, supply the service-account key for the api-catalog and bootstrap surfaces, a workspace-Admin user PMAK for the agent secret, and that same human's user session access token for `postman-access-token`. The `Non-service-account warning` below is informational; for the Akita onboard path a user session token is the supported credential.

## Primary path: service-token action

Use [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action) before this action. It mints the access token from a service-account PMAK and emits both the token and team ID.

```yaml
- id: postman_token
  uses: postman-cs/postman-resolve-service-token-action@v1
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- uses: postman-cs/postman-insights-onboarding-action@v1
  with:
    project-name: af-cards-activation
    workspace-id: ${{ vars.POSTMAN_WORKSPACE_ID }}
    environment-id: ${{ vars.POSTMAN_ENVIRONMENT_ID }}
    postman-region: us
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman_token.outputs.token }}
    postman-team-id: ${{ steps.postman_token.outputs.team-id }}
```

`POSTMAN_API_KEY` should be a [Postman service account](https://learning.postman.com/docs/administration/service-accounts/) PMAK from the same parent org as the workspace and environment. A personal user PMAK can fail token minting or trigger the non-service-account warning described below.

This wiring covers the API Catalog steps (discovery, prepare-collection, git onboarding) and stops there. It does not complete the Insights bind: per the limitation above, the Akita onboarding calls need a user session access token in `postman-access-token`, and the observability binding needs a workspace-Admin user PMAK in `postman-api-key`. For a full link, source both from the user identity instead of the service-token output.

## Legacy fallback: Postman CLI credential store

Use this only when service-account token minting is not available yet. The fallback reads the [Postman CLI credential store](https://learning.postman.com/docs/postman-cli/postman-cli-auth/) populated by `postman login`; do not paste copied cookies, DevTools values, or manually harvested session credentials into CI secrets.

```bash
postman login
jq -r '.login._profiles[].accessToken' ~/.postman/postmanrc | gh secret set POSTMAN_ACCESS_TOKEN --repo <owner>/<repo>
```

CLI login tokens are session-scoped and expire. Prefer the service-token action for CI because it mints a service-account token at runtime and avoids long-lived session secrets.

## API key auto-creation

If `postman-api-key` is omitted or the `/me` validation call returns `401` or `403`, the action creates a new API key via the Postman identity service using `postman-access-token`. Network failures and unexpected validation responses fail the action instead of silently rotating credentials.

Auto-created API keys are not used as evidence for a credential mismatch. The preflight can still warn about unresolved identity, but it does not fail only because the original API key was missing or rejected.

## Credential preflight (`credential-preflight`)

Before any onboarding write, the action can probe both credentials and compare the parent organization each one resolves to. Mismatched credentials are a common source of duplicate-link errors and workspaces that are visible to one credential but not the other.

- `warn` (default): logs a note and continues when `postman-api-key` and `postman-access-token` resolve to different parent orgs.
- `enforce`: fails the run on that condition before any onboarding write.

Those are the only public modes. There is no public opt-out. A rejected or auto-created `postman-api-key` is never failed on.

## Non-service-account warning

When the access-token session reports a `consumerType` other than `service_account`, the action logs a warning and continues according to the selected preflight mode. That warning means the run is using a user/session token path, which is exactly what the Akita onboarding and bind calls require (see the limitation above), so the warning is expected on a run that completes the Insights link. Re-mint a service-account token with [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action) only when the run is intentionally limited to the API Catalog steps; a service-account token cannot complete the Insights bind.

## Team scope (`postman-team-id`)

Supply `postman-team-id` for org-mode tokens that require an explicit team header. When set, it is sent as `x-entity-team-id` on integration requests. For non-org tokens, leave it unset so Postman can infer team context from the access token. The `POSTMAN_TEAM_ID` environment variable is honored when the input is empty. Postman's [roles and permissions](https://learning.postman.com/docs/administration/roles-and-permissions/) docs cover the team and workspace role model.
