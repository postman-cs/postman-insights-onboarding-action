import { toOneLine } from '../secrets.js';

export type PostmanStack = 'prod' | 'beta';
export type PostmanRegion = 'us' | 'eu';

export interface PostmanEndpointProfile {
  apiBaseUrl: string;
  bifrostBaseUrl: string;
  iapubBaseUrl: string;
  observabilityBaseUrl: string;
  observabilityEnv: string;
}

export const POSTMAN_ENDPOINT_PROFILES: Record<PostmanStack, PostmanEndpointProfile> = {
  prod: {
    apiBaseUrl: 'https://api.getpostman.com',
    bifrostBaseUrl: 'https://bifrost-premium-https-v4.gw.postman.com',
    iapubBaseUrl: 'https://iapub.postman.co',
    observabilityBaseUrl: 'https://api.observability.postman.com',
    observabilityEnv: 'production'
  },
  beta: {
    apiBaseUrl: 'https://api.getpostman-beta.com',
    bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com',
    iapubBaseUrl: 'https://iapub.postman.co',
    observabilityBaseUrl: 'https://api.observability.postman-beta.com',
    observabilityEnv: 'beta'
  }
};

export function parsePostmanRegion(value: string | undefined): PostmanRegion {
  const normalized = String(value || 'us').trim().toLowerCase();
  if (normalized === 'us' || normalized === 'eu') {
    return normalized;
  }
  throw new Error(
    `Unsupported postman-region "${toOneLine(value)}". Supported values: us, eu`
  );
}

export function parsePostmanStack(value: string | undefined): PostmanStack {
  const normalized = String(value || 'prod').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'beta') {
    return normalized;
  }
  throw new Error(
    `Unsupported postman-stack "${toOneLine(value)}". Supported values: prod, beta`
  );
}

export function resolvePostmanEndpointProfile(
  stack: PostmanStack,
  region: PostmanRegion = 'us'
): PostmanEndpointProfile {
  if (stack === 'beta' && region !== 'us') {
    throw new Error('postman-region=eu is only supported with postman-stack=prod');
  }
  const profile = POSTMAN_ENDPOINT_PROFILES[stack];
  if (region === 'eu') {
    return {
      ...profile,
      apiBaseUrl: 'https://api.eu.postman.com'
    };
  }
  return profile;
}
