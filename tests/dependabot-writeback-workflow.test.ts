import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const wf = readFileSync('.github/workflows/dependabot-dist-writeback.yml','utf8');
describe('dependabot-writeback-workflow',()=>{
  it('contains workflow_run trigger',()=>{ expect(wf).toContain('workflow_run'); expect(wf).toContain('workflows: ["CI"]'); });
  it('no pull_request_target',()=>{ expect(wf).not.toContain('pull_request_target'); });
  it('no npm',()=>{ expect(wf).not.toMatch(/\brun: npm\b/); expect(wf).not.toContain('actions/cache'); });
  it('pins checkout and fails closed on artifact digest mismatch',()=>{
    expect(wf).toMatch(/actions\/checkout@(v\d+|[0-9a-f]{40})/);
    expect(wf).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
    expect(wf).toContain('digest-mismatch: error');
  });
  it('permission boundaries',()=>{ expect(wf).toContain('contents: read'); expect(wf).toContain('contents: write'); expect(wf).toContain('pull-requests: write'); expect(wf).toContain('actions: write'); expect(wf).toContain('permissions:'); });
  it('checks author branch PR state allowlist digest git data api',()=>{
    expect(wf).toContain('dependabot[bot]'); expect(wf).toContain('dependabot/npm_and_yarn/'); expect(wf).toContain('state=open'); expect(wf).toContain('node --experimental-strip-types scripts/validate-candidate-dist.ts'); expect(wf).toContain('/git/blobs'); expect(wf).toContain('/git/trees'); expect(wf).toContain('/git/commits'); expect(wf).toContain('/git/refs/heads'); expect(wf).not.toMatch(/\bgit commit\b/); expect(wf).not.toMatch(/\bgit push\b/);
  });
});
