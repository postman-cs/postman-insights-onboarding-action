export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
}

export interface ActionOutputContract {
  description: string;
}

export interface AlphaActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
}

export const alphaActionContract: AlphaActionContract = {
  name: 'postman-insights-onboarding-action',
  description: 'Links Postman Insights discovered services to API Catalog workspaces and git repos.',
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
    'cluster-name': {
      description: 'Insights cluster name. Matches {cluster}/{project-name} in discovered services.',
      required: false,
    },
    'git-owner': {
      description: 'GitHub organization or user that owns the repository.',
      required: false,
    },
    'git-repository-name': {
      description: 'GitHub repository name. Defaults to project-name.',
      required: false,
    },
    'postman-access-token': {
      description: 'Postman access token for Bifrost API calls.',
      required: true,
    },
    'postman-team-id': {
      description: 'Postman team ID for Bifrost request headers.',
      required: true,
    },
    'github-token': {
      description: 'GitHub token used as git_api_key for the onboarding/git call.',
      required: false,
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
    'status': {
      description: 'Onboarding result: success, not-found, or error.',
    },
  },
};

export const contractInputNames = Object.keys(alphaActionContract.inputs);
export const contractOutputNames = Object.keys(alphaActionContract.outputs);
