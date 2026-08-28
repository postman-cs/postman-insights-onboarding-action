import { describe, expect, it } from 'vitest';

import {
  BRANCH_DECISION_ENV,
  resolveEffectiveBranchDecision,
  type BranchDecision,
  type BranchIdentity,
} from '../src/lib/repo-branch-decision.js';

const featureIdentity: BranchIdentity = {
  provider: 'github',
  headBranch: 'feature/untrusted',
  rawRef: 'refs/heads/feature/untrusted',
  defaultBranch: 'main',
  refKind: 'branch',
  isPrContext: false,
  isForkPr: false,
  headSha: 'a'.repeat(40),
};

function decision(overrides: Partial<BranchDecision> = {}): BranchDecision {
  return {
    tier: 'gated',
    strategy: 'publish-gate',
    identity: featureIdentity,
    canonicalBranch: 'main',
    reason: 'feature branch is gated',
    ...overrides,
  };
}

describe('inherited branch decisions', () => {
  it.each(['canonical', 'legacy'] as const)(
    'rejects a forged %s tier that disagrees with local provider context',
    (tier) => {
      const inherited = decision({ tier, strategy: tier === 'legacy' ? 'legacy' : 'publish-gate' });
      expect(() =>
        resolveEffectiveBranchDecision(
          {
            strategy: 'publish-gate',
            identity: featureIdentity,
            canonicalBranch: 'main',
          },
          { [BRANCH_DECISION_ENV]: JSON.stringify(inherited) }
        )
      ).toThrow(/CONTRACT_BRANCH_DECISION_MISMATCH/);
    }
  );

  it('accepts a matching inherited authorization decision and returns local context', () => {
    const inherited = decision({ reason: 'upstream wording may differ' });
    const resolved = resolveEffectiveBranchDecision(
      {
        strategy: 'publish-gate',
        identity: featureIdentity,
        canonicalBranch: 'main',
      },
      { [BRANCH_DECISION_ENV]: JSON.stringify(inherited) }
    );

    expect(resolved.tier).toBe('gated');
    expect(resolved.reason).toContain('publish-gate');
    expect(resolved.identity).toEqual(featureIdentity);
  });
});
