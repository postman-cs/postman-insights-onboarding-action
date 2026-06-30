/** Re-verify the Insights auth wall before deciding the access-token migration.
 *
 * Memory (2026-06-16) + the in-code comment at bifrost-client.ts:339-346 claim
 * the Akita + observability backends reject service-account identities (401
 * "Postman User not found") while the api-catalog backend accepts the same SA
 * token. That claim gates whether insights-onboarding can migrate off PMAK.
 * This probe re-reproduces it live, run-scoped, on the disposable sandbox.
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/probe-insights-akita.ts
 */
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const P = POSTMAN_ENDPOINT_PROFILES.prod;
const BIFROST = `${P.bifrostBaseUrl}/ws/proxy`;
type J = Record<string, unknown>;

async function bifrost(token: string, service: string, method: string, path: string, body: unknown = {}): Promise<{ status: number; text: string }> {
  const r = await fetch(BIFROST, {
    method: 'POST',
    headers: { 'x-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, method, path, body })
  });
  return { status: r.status, text: (await r.text()).slice(0, 200).replace(/\n/g, ' ') };
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no key'); return; }

  // Mint SA access token (same exchange resolve-service-token uses).
  const mint = await fetch(`${P.apiBaseUrl}/service-account-tokens`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey })
  });
  const mintBody = await mint.json().catch(() => ({})) as J;
  const token = String((mintBody as J).token ?? (mintBody as J).accessToken ?? (mintBody as J).access_token ?? '').trim();
  console.log(`[mint] status=${mint.status} hasToken=${Boolean(token)}`);
  if (!token) { console.log(`[mint] body=${JSON.stringify(mintBody).slice(0, 200)}`); return; }

  // Confirm identity type via iapub session.
  const sess = await fetch(`${P.iapubBaseUrl}/api/sessions/current`, { headers: { 'x-access-token': token } });
  const sessBody = await sess.json().catch(() => ({})) as J;
  const session = (sessBody.session as J) ?? sessBody;
  console.log(`[iapub] consumerType=${String((session as J).consumerType ?? 'unknown')} team=${String(((session as J).identity as J)?.team ?? '?')}`);

  const created = new Set<string>();
  try {
    const ws = await fetch(`${P.apiBaseUrl}/workspaces`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: { name: `insights-probe-${Date.now()}`, type: 'team' } })
    }).then((r) => r.json()).catch(() => ({})) as J;
    const wsId = String((ws.workspace as J)?.id ?? '').trim();
    if (wsId) created.add(wsId);
    console.log(`[setup] workspaceId=${wsId || '(none)'}`);

    console.log('\n== api-catalog (control: expect accept) ==');
    const cat = await bifrost(token, 'api-catalog', 'GET', '/api/v1/onboarding/discovered-services?status=discovered');
    console.log(`  [${cat.status}] GET discovered-services :: ${cat.text}`);

    console.log('\n== akita (expect 401 if SA rejected) ==');
    const svc = await bifrost(token, 'akita', 'GET', '/v2/api-catalog/services?status=discovered&page=1&page_size=10');
    console.log(`  [${svc.status}] GET /v2/api-catalog/services :: ${svc.text}`);
    if (wsId) {
      const ack = await bifrost(token, 'akita', 'POST', `/v2/workspaces/${wsId}/onboarding/acknowledge`, {});
      console.log(`  [${ack.status}] POST /v2/workspaces/:id/onboarding/acknowledge :: ${ack.text}`);
      const tvt = await bifrost(token, 'akita', 'GET', `/v2/workspaces/${wsId}/team-verification-token`);
      console.log(`  [${tvt.status}] GET /v2/workspaces/:id/team-verification-token :: ${tvt.text}`);
    }

    console.log('\n== observability createApplication (x-access-token vs x-api-key) ==');
    if (wsId) {
      const obsUrl = `${P.observabilityBaseUrl}/v2/agent/api-catalog/workspaces/${wsId}/applications`;
      for (const [label, hdr] of [['x-access-token', { 'x-access-token': token }], ['x-api-key', { 'x-api-key': apiKey }]] as Array<[string, Record<string, string>]>) {
        const r = await fetch(obsUrl, { method: 'POST', headers: { ...hdr, 'x-postman-env': P.observabilityEnv, 'Content-Type': 'application/json' }, body: JSON.stringify({ system_env: 'probe' }) });
        console.log(`  [${r.status}] ${label} :: ${(await r.text()).slice(0, 160).replace(/\n/g, ' ')}`);
      }
    }
  } finally {
    for (const id of created) {
      const r = await fetch(`${P.apiBaseUrl}/workspaces/${id}`, { method: 'DELETE', headers: { 'x-api-key': apiKey } });
      console.log(`[teardown] ${id} -> ${r.status}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
