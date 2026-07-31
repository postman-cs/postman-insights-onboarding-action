/**
 * WS4 route-manifest ratchet.
 *
 * Statically extracts every service/method/path triple this action calls out of
 * `src/`, then diffs that surface against `tests/contract/route-manifest.json`
 * in both directions: a route in `src/` with no manifest entry fails, and a
 * manifest entry with no route in `src/` fails. A row claiming `simulated` must
 * name cassette files that exist. Unreadable HTTP call sites fail closed rather
 * than disappearing from the surface.
 *
 * The extractor/validator import is the shared WS4 contract; it moves to
 * `@postman-cse/automation-core/route-manifest` when that subpath publishes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ROUTE_CLASSIFICATIONS,
  extractRoutesFromSource,
  normalizePath,
  validateRouteManifest,
  type RouteManifest,
  type RouteManifestRoute
} from './route-manifest-contract.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const sourceRoot = path.join(repoRoot, 'src');
const manifestPath = path.join(repoRoot, 'tests', 'contract', 'route-manifest.json');

/**
 * Extraction config for this action. Insights never uses
 * AccessTokenGatewayClient: it POSTs Bifrost envelopes through two positional
 * helpers, and calls the observability and Postman API hosts with plain fetch.
 *
 * `serviceAliases` is the fail-closed seam. A base-URL expression with no entry
 * here is reported as an unattributed call site and fails the gate, so a new
 * backend host cannot enter the tree unclassified.
 */
export const EXTRACTION_CONFIG = {
  proxyHelpers: { proxyRequest: 'api-catalog', akitaProxyRequest: 'akita' },
  serviceAliases: {
    'this.observabilityBaseUrl': 'observability',
    apiBase: 'postman-api',
    baseUrl: 'postman-api',
    // credential-identity.ts declares a `baseUrl` parameter in two probes that
    // point at different hosts; scope the iapub one to its function.
    'probeSessionIdentity:baseUrl': 'iapub'
  },
  envelopeCarriers: ['this.bifrostProxyUrl']
} as const;

/** Moves only when the wire surface deliberately changes. */
const EXPECTED_ROUTE_COUNT = 13;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function loadManifest(): RouteManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as RouteManifest;
}

function cloneManifest(): RouteManifest {
  return structuredClone(loadManifest());
}

function verifyMutated(mutate: (manifest: RouteManifest) => void) {
  const manifest = cloneManifest();
  mutate(manifest);
  return validateRouteManifest({ repoRoot, sourceRoot, manifest, ...EXTRACTION_CONFIG });
}

function makeFixture(files: Record<string, string>, manifest: RouteManifest): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'insights-route-manifest-'));
  tempDirs.push(fixtureRoot);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(fixtureRoot, 'src', relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  mkdirSync(path.join(fixtureRoot, 'tests', 'contract'), { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, 'tests', 'contract', 'route-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return fixtureRoot;
}

describe('route manifest contract', () => {
  it('IN-RM-001: the committed manifest is schema 1 and well formed', () => {
    const manifest = loadManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.routes.length).toBe(EXPECTED_ROUTE_COUNT);

    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const route of manifest.routes) {
      expect(ROUTE_CLASSIFICATIONS).toContain(route.classification);
      expect(route.method).toBe(route.method.toUpperCase());
      expect(route.path.startsWith('/')).toBe(true);
      expect(ids.has(route.id), `duplicate id ${route.id}`).toBe(false);
      ids.add(route.id);
      const key = `${route.service} ${route.method} ${route.path}`;
      expect(keys.has(key), `duplicate route key ${key}`).toBe(false);
      keys.add(key);
      if (route.classification === 'simulated') {
        expect(route.cassettes?.length, `${route.id} simulated without cassettes`).toBeGreaterThan(0);
      } else {
        expect(route.reason?.trim().length, `${route.id} missing reason`).toBeGreaterThan(0);
      }
    }
  });

  it('IN-RM-002: the committed manifest matches the extracted surface exactly', () => {
    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: loadManifest(),
      ...EXTRACTION_CONFIG
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.extractedRoutes.length).toBe(EXPECTED_ROUTE_COUNT);
  });

  it('IN-RM-003: extraction reaches every transport this action uses and leaves nothing unattributed', () => {
    const extraction = extractRoutesFromSource({ sourceRoot, ...EXTRACTION_CONFIG });
    expect(extraction.unattributed).toEqual([]);

    // One route per transport class, so a regression in any single shape
    // (envelope literal, positional proxy helper, direct fetch, const-resolved
    // URL, function-scoped alias) surfaces as a named failure.
    const ids = extraction.routes.map((route) => route.id);
    expect(ids).toContain('identity POST /api/keys'); // inline envelope literal
    expect(ids).toContain('api-catalog POST /api/v1/onboarding/prepare-collection'); // proxyRequest helper
    expect(ids).toContain('akita GET /v2/api-catalog/services'); // helper behind a multi-line generic
    expect(ids).toContain('observability POST /v2/agent/api-catalog/workspaces/{workspaceId}/applications');
    expect(ids).toContain('iapub GET /api/sessions/current'); // function-scoped alias + const path
    expect(ids).toContain('postman-api GET /me');

    expect(new Set(extraction.routes.map((route) => route.service))).toEqual(
      new Set(['api-catalog', 'akita', 'identity', 'observability', 'iapub', 'postman-api'])
    );

    // Both discovered-services call sites collapse onto one route rather than
    // forking a phantom key off the interpolated cursor query.
    const discovered = extraction.routes.find(
      (route) => route.id === 'api-catalog GET /api/v1/onboarding/discovered-services'
    );
    expect(discovered?.sources.length).toBe(2);
  });

  it('IN-RM-004: path normalization keys routes on the path, not on interpolated query state', () => {
    expect(normalizePath('/api/v1/onboarding/discovered-services?status=discovered${cursorParam}')).toBe(
      '/api/v1/onboarding/discovered-services'
    );
    expect(normalizePath('/api/v1/onboarding/discovered-services${query}')).toBe(
      '/api/v1/onboarding/discovered-services'
    );
    expect(normalizePath('/v2/workspaces/${workspaceId}/onboarding/acknowledge')).toBe(
      '/v2/workspaces/{workspaceId}/onboarding/acknowledge'
    );
    expect(normalizePath('/v2/agent/workspaces/${this.workspace.id}/applications')).toBe(
      '/v2/agent/workspaces/{id}/applications'
    );
  });
});

describe('route manifest ratchet negatives', () => {
  it('IN-RM-010: a route in src/ with no manifest entry fails the gate', () => {
    const result = verifyMutated((manifest) => {
      manifest.routes = manifest.routes.filter((route) => route.id !== 'api-catalog.onboard-git');
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) => /unmanifested route/i.test(error) && /api-catalog POST \/api\/v1\/onboarding\/git/.test(error)
      )
    ).toBe(true);
  });

  it('IN-RM-011: a manifest entry with no route in src/ fails as stale', () => {
    const result = verifyMutated((manifest) => {
      manifest.routes.push({
        id: 'api-catalog.removed-route',
        service: 'api-catalog',
        method: 'DELETE',
        path: '/api/v1/onboarding/no-longer-called',
        classification: 'live-only',
        reason: 'fixture'
      });
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) => /stale manifest entry/i.test(error) && /no-longer-called/.test(error)
      )
    ).toBe(true);
  });

  it('IN-RM-012: simulated without cassettes fails', () => {
    const result = verifyMutated((manifest) => {
      const route = manifest.routes[0] as RouteManifestRoute;
      route.classification = 'simulated';
      delete route.reason;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /simulated but lists no cassettes/i.test(error))).toBe(true);
  });

  it('IN-RM-013: simulated naming a cassette file that does not exist fails', () => {
    const result = verifyMutated((manifest) => {
      const route = manifest.routes[0] as RouteManifestRoute;
      route.classification = 'simulated';
      route.cassettes = ['tests/contract/cassettes/not-recorded.json'];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /cassette not found/i.test(error))).toBe(true);
  });

  it('IN-RM-014: a non-simulated row without a reason fails', () => {
    const result = verifyMutated((manifest) => {
      delete (manifest.routes[0] as RouteManifestRoute).reason;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /reason is required/i.test(error))).toBe(true);
  });

  it('IN-RM-015: duplicate ids and duplicate route keys fail', () => {
    const duplicateId = verifyMutated((manifest) => {
      manifest.routes.push({ ...(manifest.routes[0] as RouteManifestRoute) });
    });
    expect(duplicateId.ok).toBe(false);
    expect(duplicateId.errors.some((error) => /duplicate id/i.test(error))).toBe(true);
    expect(duplicateId.errors.some((error) => /duplicate route key/i.test(error))).toBe(true);
  });

  it('IN-RM-016: an invalid classification fails', () => {
    const result = verifyMutated((manifest) => {
      (manifest.routes[0] as RouteManifestRoute).classification =
        'mostly-simulated' as RouteManifestRoute['classification'];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /classification must be one of/i.test(error))).toBe(true);
  });

  it('IN-RM-017: a schemaVersion other than 1 fails', () => {
    const result = verifyMutated((manifest) => {
      manifest.schemaVersion = 2;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /schemaVersion must be 1/i.test(error))).toBe(true);
  });

  it('IN-RM-018: a lowercase method fails rather than silently missing its route', () => {
    const result = verifyMutated((manifest) => {
      (manifest.routes[0] as RouteManifestRoute).method = 'get';
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /method must be uppercase/i.test(error))).toBe(true);
  });
});

describe('route manifest ratchet on a fixture tree', () => {
  const manifestFor = (routes: RouteManifestRoute[]): RouteManifest => ({
    schemaVersion: 1,
    routes
  });

  it('IN-RM-020: a throwaway route added to src/ fails as unmanifested', () => {
    const client = [
      'export class Client {',
      '  constructor(private readonly fetchFn: typeof fetch, private readonly apiBase: string) {}',
      '  async listThings(): Promise<Response> {',
      '    return this.fetchFn(`${this.apiBase}/api/v1/things`, { method: "GET" });',
      '  }',
      '}',
      ''
    ].join('\n');

    const manifest = manifestFor([
      {
        id: 'postman-api.things.list',
        service: 'postman-api',
        method: 'GET',
        path: '/api/v1/things',
        classification: 'live-only',
        reason: 'fixture'
      }
    ]);

    const fixtureRoot = makeFixture({ 'client.ts': client }, manifest);
    const clean = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest,
      serviceAliases: { 'this.apiBase': 'postman-api' }
    });
    expect(clean.errors).toEqual([]);
    expect(clean.ok).toBe(true);

    // Add an unmanifested throwaway route to the same fixture source file.
    writeFileSync(
      path.join(fixtureRoot, 'src', 'client.ts'),
      client.replace(
        '}\n',
        [
          '  async throwaway(): Promise<Response> {',
          '    return this.fetchFn(`${this.apiBase}/api/v1/throwaway`, { method: "DELETE" });',
          '  }',
          '}',
          ''
        ].join('\n')
      )
    );

    const ratcheted = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest,
      serviceAliases: { 'this.apiBase': 'postman-api' }
    });
    expect(ratcheted.ok).toBe(false);
    expect(
      ratcheted.errors.some(
        (error) => /unmanifested route/i.test(error) && /DELETE \/api\/v1\/throwaway/.test(error)
      )
    ).toBe(true);
  });

  it('IN-RM-021: a call to an unmapped host fails closed instead of vanishing from the surface', () => {
    const client = [
      'export async function callVendor(fetchFn: typeof fetch, vendorBaseUrl: string): Promise<Response> {',
      '  return fetchFn(`${vendorBaseUrl}/v1/exfiltrate`, { method: "POST" });',
      '}',
      ''
    ].join('\n');

    const manifest = manifestFor([]);
    const fixtureRoot = makeFixture({ 'vendor.ts': client }, manifest);

    const result = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest,
      serviceAliases: { apiBase: 'postman-api' }
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) => /unattributed HTTP call site/i.test(error) && /vendorBaseUrl/.test(error)
      )
    ).toBe(true);
  });

  it('IN-RM-022: prose describing a route never mints one', () => {
    const client = [
      '// Historical note: this client used to POST /api/v1/legacy-onboard with',
      '// { service: "api-catalog", method: "POST", path: "/api/v1/legacy-onboard" }.',
      '/* It also called GET /v2/ghost via fetchFn(`${apiBase}/v2/ghost`). */',
      'export async function current(fetchFn: typeof fetch, apiBase: string): Promise<Response> {',
      '  return fetchFn(`${apiBase}/api/v1/current`, { method: "GET" });',
      '}',
      ''
    ].join('\n');

    const manifest = manifestFor([
      {
        id: 'postman-api.current',
        service: 'postman-api',
        method: 'GET',
        path: '/api/v1/current',
        classification: 'live-only',
        reason: 'fixture'
      }
    ]);
    const fixtureRoot = makeFixture({ 'prose.ts': client }, manifest);

    const result = validateRouteManifest({
      repoRoot: fixtureRoot,
      manifest,
      serviceAliases: { apiBase: 'postman-api' }
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
