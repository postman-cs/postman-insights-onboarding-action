# Security Policy

## Supported Versions

Only the latest `v1.x.y` release (tracked by the rolling `v1` alias) receives security fixes. Older tags remain published for reproducibility and are never retroactively modified.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

- Preferred: use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Alternative: email [security@postman.com](mailto:security@postman.com) and mention the repository name.

You should receive an acknowledgement within five business days. Please include reproduction steps, the action version tag, and any relevant (redacted) workflow logs.

## Scope Notes

- This action handles a human-user PMAK, a human-user session access token, and team verification tokens. These values are masked in logs by the action itself; never echo them in your own workflow steps.
- Insights requires a human-user PMAK and matching human-user session token. It never mints or refreshes tokens from a PMAK; rotate expired user sessions outside the action.
- Reports about secrets you exposed in your own workflow configuration are out of scope; rotate the credential in Postman immediately.
- Include only redacted workflow logs in reports.
