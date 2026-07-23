/** Insights accepts an explicitly supplied human-user session token only. */
export interface AccessTokenProviderOptions {
  accessToken?: string;
}

export class AccessTokenProvider {
  private readonly token: string;

  constructor(options: AccessTokenProviderOptions) {
    this.token = String(options.accessToken || '').trim();
  }

  current(): string {
    return this.token;
  }

  canRefresh(): boolean {
    return false;
  }

  async refresh(): Promise<string> {
    throw new Error(
      'Insights requires a human-user session access token. An expired token cannot be minted from a PMAK; provide a fresh human-user access token and rerun.'
    );
  }
}
