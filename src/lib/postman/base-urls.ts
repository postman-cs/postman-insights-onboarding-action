export type PostmanStack = 'prod' | 'beta';

export interface PostmanEndpointProfile {
  apiBaseUrl: string;
  bifrostBaseUrl: string;
  observabilityBaseUrl: string;
  observabilityEnv: string;
}

export const POSTMAN_ENDPOINT_PROFILES: Record<PostmanStack, PostmanEndpointProfile> = {
  prod: {
    apiBaseUrl: 'https://api.getpostman.com',
    bifrostBaseUrl: 'https://bifrost-premium-https-v4.gw.postman.com',
    observabilityBaseUrl: 'https://api.observability.postman.com',
    observabilityEnv: 'production'
  },
  beta: {
    apiBaseUrl: 'https://api.getpostman-beta.com',
    bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com',
    observabilityBaseUrl: 'https://api.observability.postman-beta.com',
    observabilityEnv: 'beta'
  }
};

export function parsePostmanStack(value: string | undefined): PostmanStack {
  const normalized = String(value || 'prod').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'beta') {
    return normalized;
  }
  throw new Error(`Unsupported postman-stack "${value}". Supported values: prod, beta`);
}

export function resolvePostmanEndpointProfile(stack: PostmanStack): PostmanEndpointProfile {
  return POSTMAN_ENDPOINT_PROFILES[stack];
}
