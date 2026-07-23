export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
  allowedValues?: string[];
}

export interface ActionOutputContract {
  description: string;
}

export interface ActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
}

export const insightsActionContract: ActionContract = {
  name: 'Postman Onboarding: Insights Linking',
  description: 'Link Postman Insights discovered services to workspaces and git repos. Part of the Postman API Onboarding suite.',
  inputs: {
    'project-name': {
      description: 'Service name or spec ID to match against discovered service names.',
      required: true,
    },
    'workspace-id': {
      description: 'Postman workspace ID to link the discovered service to.',
      required: true,
    },
    'environment-id': {
      description: 'Postman environment UID for the onboarding association.',
      required: true,
    },
    'system-environment-id': {
      description: 'Postman system environment UUID for service-level Insights acknowledgment.',
      required: false,
    },
    'cluster-name': {
      description: 'Insights cluster name. Matches {cluster}/{project-name} in discovered services.',
      required: false,
    },
    'repo-url': {
      description: 'Repository URL for Git onboarding. Auto-detected from CI context when omitted.',
      required: false,
    },
    'postman-access-token': {
      description: 'Required human-user session access token for Bifrost and Akita calls. It cannot be minted or refreshed from a PMAK.',
      required: false,
    },
    'postman-team-id': {
      description: 'Explicit Postman team ID for org-mode integration request headers. When omitted, x-entity-team-id is not sent.',
      required: false,
    },
    'github-token': {
      description: 'Optional GitHub token passed as git_api_key when repository auth is required by onboarding/git.',
      required: false,
    },
    'postman-api-key': {
      description:
        'Human-user Postman API key (PMAK-*) for observability application binding. Service-account PMAKs are rejected.',
      required: false,
    },
    'create-api-key': {
      description:
        'Explicit opt-in to create a durable Bifrost API key when postman-api-key is omitted or invalid. Default false. Supported values: true, false.',
      required: false,
      default: 'false',
      allowedValues: ['true', 'false'],
    },
    'credential-preflight': {
      description:
        'Credential identity preflight policy. enforce (default) fails before linking writes when postman-api-key and postman-access-token resolve to different parent orgs; warn is an explicit compatibility policy that logs and continues. Supported values are enforce and warn.',
      required: false,
      default: 'enforce',
      allowedValues: ['enforce', 'warn'],
    },
    'service-not-found-policy': {
      description:
        'Behavior when the discovered service is absent after polling. fail (default) aborts full linking; warn returns status=not-found without writes. Supported values: fail, warn.',
      required: false,
      default: 'fail',
      allowedValues: ['fail', 'warn'],
    },
    'poll-timeout-seconds': {
      description: 'Maximum seconds to wait for the service to appear in the discovered list.',
      required: false,
      default: '120',
    },
    'poll-interval-seconds': {
      description: 'Seconds between discovery polling attempts.',
      required: false,
      default: '10',
    },
    'postman-region': {
      description: 'Postman data residency region for public API calls. One of: us or eu.',
      required: false,
      default: 'us',
      allowedValues: ['us', 'eu'],
    },
    'postman-stack': {
      description: 'Postman stack profile. Defaults to the public production stack. Marketplace workflows should leave this as prod.',
      required: false,
      default: 'prod',
      allowedValues: ['prod', 'beta'],
    },
    'branch-strategy': {
      description: 'Branch-aware sync strategy. legacy keeps branch-blind behavior; publish-gate skips non-canonical writes; preview supports branch-scoped asset sets.',
      required: false,
      default: 'legacy',
      allowedValues: ['legacy', 'publish-gate', 'preview'],
    },
    'canonical-branch': {
      description: 'Explicit canonical branch. Defaults to the provider-resolved default branch.',
      required: false,
    },
    channels: {
      description: 'Comma-separated channel map for long-lived promotion branches.',
      required: false,
    },
  },
  outputs: {
    'discovered-service-id': {
      description: 'Numeric ID from the API Catalog discovered-services list.',
    },
    'discovered-service-name': {
      description: 'Full cluster/service name of the discovered service.',
    },
    'collection-id': {
      description: 'Collection ID returned by the prepare-collection step.',
    },
    'application-id': {
      description: 'Insights application binding ID from the observability API.',
    },
    'verification-token': {
      description: 'Insights team verification token (tvt_*) for DaemonSet telemetry.',
    },
    'status': {
      description: 'Onboarding result: success, not-found, or error.',
    },
    'sync-status': {
      description: 'Branch-aware sync status.',
    },
    'branch-decision': {
      description: 'Serialized BranchDecision JSON.',
    },
  },
};

export const contractInputNames = Object.keys(insightsActionContract.inputs);
export const contractOutputNames = Object.keys(insightsActionContract.outputs);
