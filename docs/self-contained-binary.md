# Self-contained binary (no npm / no Node)

For CI environments that cannot install npm packages or a Node.js runtime — locked-down Jenkins, Bitbucket Pipelines on a bare agent, boxes with no package-registry access — this action ships as a single self-contained executable. It is a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html): the Node runtime and the entire bundle are baked into one file, so the target needs **no npm, no Node install, and no network access to a package registry**.

"Self-contained" means the *runtime* is bundled — it is not network-isolated. This action links Insights-discovered services to an API Catalog workspace over Postman's Bifrost and observability APIs, so the run needs outbound access to Postman for the whole run (see [Network requirements](#network-requirements)).

The binary is built and smoke-tested natively in CI on every release (`.github/workflows/release.yml`) and attached as a GitHub Release asset. It carries the same code as the `action.yml` and npm CLI paths.

- **Current target:** `linux-x64` (glibc). Other targets (linux-arm64, win-x64, darwin-arm64) are not built yet.
- **First release with the binary:** the first `v*` tag published after this lands. Pin an explicit released version in the examples below.

## Get the binary

Download the release asset and its checksum, verify, then mark it executable. Pin an explicit version:

```bash
VERSION=2.1.8   # set to the release that carries the binary
BASE="https://github.com/postman-cs/postman-insights-onboarding-action/releases/download/v${VERSION}"

# Download under the versioned asset name. The .sha256 records that exact name,
# so `shasum -c` (which opens the filename embedded in the checksum file) only
# resolves if the binary is saved under it.
curl -fsSL -O "${BASE}/postman-insights-onboard-${VERSION}-linux-x64"
curl -fsSL -O "${BASE}/postman-insights-onboard-${VERSION}-linux-x64.sha256"
shasum -a 256 -c "postman-insights-onboard-${VERSION}-linux-x64.sha256"

# Make it executable; rename to the short name used in the examples below.
chmod +x "postman-insights-onboard-${VERSION}-linux-x64"
mv "postman-insights-onboard-${VERSION}-linux-x64" postman-insights-onboard
./postman-insights-onboard --version   # -> matches ${VERSION}
```

If the repository or release is private, the browser-style URL above returns an HTML login page instead of the binary. Fetch it through the GitHub API with a token that has `contents:read`, or — recommended for locked-down environments — **mirror the asset once into your own artifact store** (Artifactory, Nexus, S3) and have CI pull it from there. That keeps the build offline from GitHub entirely and gives you a stable internal URL.

## Prove self-containment

The binary embeds its own runtime and never consults `PATH` for `node`. You can prove that with an empty environment:

```bash
# Reaches the CLI's own input validation with no Node on PATH:
env -i PATH=/nonexistent ./postman-insights-onboard
# -> "project-name is required"
```

This is the same assertion the release workflow runs before publishing the asset.

## What it does

This action links a Postman **Insights**-discovered service to an API Catalog workspace and its originating git repository. It resolves the discovered service, associates it with the workspace, prepares a collection, and binds the observability application. Every operation is an online API call (Bifrost `/ws/proxy`, the public API, and the observability API); it makes **no runtime tool downloads** on any path.

## Credentials

Unlike the sibling onboarding actions, this action does **not** mint its own token, and it requires two **human-user** credentials. Each resolves from three sources, highest precedence first:

1. A CLI flag — `--postman-access-token <token>`, `--postman-api-key <key>`
2. The GitHub Action input env var — `INPUT_POSTMAN_ACCESS_TOKEN`, `INPUT_POSTMAN_API_KEY`
3. A plain environment variable — `POSTMAN_ACCESS_TOKEN`, `POSTMAN_API_KEY`

The plain-env fallback (3) is what makes Jenkins [`withCredentials`](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/) work with no flags: whatever sets `POSTMAN_ACCESS_TOKEN` / `POSTMAN_API_KEY` in the environment, the binary picks it up.

- **`postman-access-token` (required)** — a human-user **session** access token (`x-access-token`). Bifrost and Akita linking calls run on it. **It cannot be minted or refreshed from a PMAK** — if it expires the run fails; provide a fresh one per run. Service-account tokens are rejected. This is the key difference from `postman-bootstrap-action` / `postman-smoke-flow-action`, which mint a short-lived service-account token from a PMAK in-job — do not copy that mint step here.
- **`postman-api-key` (required unless `create-api-key=true`)** — a human-user Postman API key (`PMAK-*`) used to bind the observability application. It must resolve to the **same human user** as the access token; service-account PMAKs are rejected.

Because the access token is a short-lived human-user session token that cannot be re-minted, obtain it out of band, store both credentials in your CI secret store, and run the job promptly. See [Credentials and Identity](credentials.md) for how to obtain the access token and for the `create-api-key` opt-in.

Mint region only affects the public API host — pass `--postman-region us` (default) or `--postman-region eu` for [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/). Credentials issued in one region are not valid against the other.

## Network requirements

The binary bundles its runtime, but the linking run is an online operation. The agent needs outbound access (direct or via an HTTP/HTTPS proxy) to Postman for the entire run. On agents that enforce an outbound allowlist, allow **all** of the following (prod defaults). The region only changes the API host; the Bifrost, iapub, and observability hosts are the same for US and EU:

| Host | Purpose |
| --- | --- |
| `api.getpostman.com` (US) / `api.eu.postman.com` (EU) | Public API — human-user PMAK validation (`GET /me`) and API-key operations |
| `bifrost-premium-https-v4.gw.postman.com` | Bifrost proxy (`/ws/proxy`) — discovered-service resolution, workspace/repo linking, Bifrost API-key creation |
| `iapub.postman.co` | Session identity preflight (`/api/sessions/current`) |
| `api.observability.postman.com` | Observability API — Insights application binding (list/create applications) |

Allowlisting only the API host is **not** enough: the Bifrost linking, identity preflight, and observability binding will all fail even though PMAK validation succeeds. This action makes no runtime tool downloads. (On `postman-stack=beta` the API, Bifrost, and observability hosts change to their `-beta` equivalents; `iapub.postman.co` is unchanged.)

## Run

Inputs are the same kebab-case names as [`action.yml`](../action.yml), passed as `--<input-name> <value>`:

```bash
export POSTMAN_ACCESS_TOKEN="<human-user-session-token>"
export POSTMAN_API_KEY="<human-user-PMAK>"

./postman-insights-onboard \
  --project-name core-payments \
  --workspace-id ws_123 \
  --environment-id env_123 \
  --cluster-name my-cluster \
  --postman-region us
```

- `--project-name` matches the final segment of a discovered Insights service; with `--cluster-name` set it matches `{cluster-name}/{project-name}` exactly.
- The workspace and environment must already exist (this action links to them; `postman-bootstrap-action` / `postman-repo-sync-action` create them).
- The CLI prints the run result as JSON on stdout (logs go to stderr). `--result-json <path>` and `--dotenv-path <path>` are optional file outputs.

## Jenkins pipeline example

The binary must run on a **linux-x64 agent** — it is a Linux ELF and cannot execute on a Windows agent. Both credentials are human-user secrets bound from the Jenkins credential store; there is **no in-job token mint** (the access token cannot be minted from a PMAK).

```groovy
pipeline {
  // Requires a Linux x64 agent. Swap 'linux' for your instance's label.
  agent { label 'linux' }

  environment {
    INSIGHTS_VERSION = '2.1.8'   // set to the release that carries the binary
    POSTMAN_REGION = 'us'        // EU data residency: 'eu'
  }

  stages {
    stage('Fetch binary') {
      steps {
        sh '''
          set -eu
          # Prefer your internal mirror in locked-down environments:
          URL="https://github.com/postman-cs/postman-insights-onboarding-action/releases/download/v${INSIGHTS_VERSION}/postman-insights-onboard-${INSIGHTS_VERSION}-linux-x64"
          curl -fsSL "$URL" -o postman-insights-onboard
          chmod +x postman-insights-onboard
          ./postman-insights-onboard --version
        '''
      }
    }
    stage('Onboard Insights service') {
      steps {
        // Bind BOTH human-user credentials. The access token is a session token
        // (cannot be minted from the PMAK); the PMAK binds the observability app.
        // Both are read from the plain env by the binary -- no flags needed.
        withCredentials([
          string(credentialsId: 'postman-insights-access-token', variable: 'POSTMAN_ACCESS_TOKEN'),
          string(credentialsId: 'postman-insights-pmak', variable: 'POSTMAN_API_KEY'),
        ]) {
          sh '''
            set +x     # Jenkins runs sh with -x by default; disable it BEFORE touching secrets
            set -eu
            ./postman-insights-onboard \
              --project-name core-payments \
              --workspace-id ws_123 \
              --environment-id env_123 \
              --cluster-name my-cluster \
              --postman-region "$POSTMAN_REGION"
          '''
        }
      }
    }
  }
}
```

## Scope and limitations

- **Platform:** linux-x64 (glibc) only. arm64/Windows/macOS targets are not built yet.
- **Network:** not air-gapped — requires outbound access to the Postman API/Bifrost/observability hosts for the whole run. See [Network requirements](#network-requirements).
- **Credentials:** two human-user credentials are required (a session access token and a PMAK). The access token cannot be minted or refreshed from a PMAK; provide a fresh one per run and run promptly.
- **Assets must exist:** this action links to an existing workspace and environment; it does not create them. Run `postman-bootstrap-action` / `postman-repo-sync-action` first.
- **Version:** the embedded `--version` and telemetry version are baked in at build time from the release tag; the versioned filename (`postman-insights-onboard-<version>-linux-x64`) also carries it.
