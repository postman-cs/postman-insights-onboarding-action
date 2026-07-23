import { describe, expect, it, vi } from 'vitest';

import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

describe('Insights access-token provider', () => {
  it('uses only the supplied human-user token and has no refresh path', async () => {
    const provider = new AccessTokenProvider({ accessToken: 'user-session-token' });

    expect(provider.current()).toBe('user-session-token');
    expect(provider.canRefresh()).toBe(false);
    await expect(provider.refresh()).rejects.toThrow(
      'human-user session access token'
    );
  });

  it('does not call the service-token mint endpoint for a missing token', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new AccessTokenProvider({});

    await expect(provider.refresh()).rejects.toThrow('cannot be minted from a PMAK');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
