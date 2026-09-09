import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlayerAuthProvider } from '@prisma/client';

export interface PlayerOAuthProfile {
  provider: PlayerAuthProvider;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface PlayerOAuthGateway {
  authorizationUrl(input: {
    provider: PlayerAuthProvider;
    state: string;
    codeChallenge: string;
    callbackUrl: string;
  }): string;
  exchange(input: {
    provider: PlayerAuthProvider;
    code: string;
    codeVerifier: string;
    callbackUrl: string;
  }): Promise<PlayerOAuthProfile>;
}

export const PLAYER_OAUTH_GATEWAY = Symbol('PLAYER_OAUTH_GATEWAY');

type JsonRecord = Record<string, unknown>;

@Injectable()
export class HttpPlayerOAuthGateway implements PlayerOAuthGateway {
  constructor(private readonly config: ConfigService) {}

  authorizationUrl(input: {
    provider: PlayerAuthProvider;
    state: string;
    codeChallenge: string;
    callbackUrl: string;
  }): string {
    const credentials = this.credentials(input.provider);
    const url = new URL(
      input.provider === PlayerAuthProvider.GOOGLE
        ? 'https://accounts.google.com/o/oauth2/v2/auth'
        : 'https://github.com/login/oauth/authorize',
    );
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', input.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set(
      'scope',
      input.provider === PlayerAuthProvider.GOOGLE
        ? 'openid email profile'
        : 'read:user user:email',
    );
    if (input.provider === PlayerAuthProvider.GOOGLE) {
      url.searchParams.set('prompt', 'select_account');
    }
    return url.toString();
  }

  async exchange(input: {
    provider: PlayerAuthProvider;
    code: string;
    codeVerifier: string;
    callbackUrl: string;
  }): Promise<PlayerOAuthProfile> {
    const credentials = this.credentials(input.provider);
    const tokenUrl =
      input.provider === PlayerAuthProvider.GOOGLE
        ? 'https://oauth2.googleapis.com/token'
        : 'https://github.com/login/oauth/access_token';
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: input.code,
        redirect_uri: input.callbackUrl,
        code_verifier: input.codeVerifier,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = await this.json(tokenResponse);
    const accessToken = this.string(tokenBody.access_token);
    if (!tokenResponse.ok || !accessToken) {
      throw new Error('OAuth code exchange failed');
    }

    return input.provider === PlayerAuthProvider.GOOGLE
      ? this.googleProfile(accessToken)
      : this.githubProfile(accessToken);
  }

  private async googleProfile(
    accessToken: string,
  ): Promise<PlayerOAuthProfile> {
    const response = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await this.json(response);
    const id = this.string(body.sub);
    const email = this.string(body.email).toLowerCase();
    if (!response.ok || !id || !email) throw new Error('OAuth profile failed');
    return {
      provider: PlayerAuthProvider.GOOGLE,
      providerUserId: id,
      email,
      emailVerified: body.email_verified === true,
      firstName: this.string(body.given_name),
      lastName: this.string(body.family_name),
    };
  }

  private async githubProfile(
    accessToken: string,
  ): Promise<PlayerOAuthProfile> {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'BJ-Spades',
    };
    const [userResponse, emailsResponse] = await Promise.all([
      fetch('https://api.github.com/user', {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch('https://api.github.com/user/emails', {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    const user = await this.json(userResponse);
    const emailsBody = (await emailsResponse.json().catch(() => [])) as unknown;
    if (!userResponse.ok || !emailsResponse.ok || !Array.isArray(emailsBody)) {
      throw new Error('OAuth profile failed');
    }
    const emails: unknown[] = emailsBody;
    const verified = emails.find(
      (entry): entry is { email: string; primary: true; verified: true } => {
        if (typeof entry !== 'object' || entry === null) return false;
        const item = entry as JsonRecord;
        return (
          item.verified === true &&
          item.primary === true &&
          typeof item.email === 'string'
        );
      },
    );
    const id =
      typeof user.id === 'string' || typeof user.id === 'number'
        ? String(user.id)
        : '';
    const email = this.string(verified?.email).toLowerCase();
    if (!id || !email) throw new Error('A verified provider email is required');
    const name = this.string(user.name).trim().split(/\s+/);
    return {
      provider: PlayerAuthProvider.GITHUB,
      providerUserId: id,
      email,
      emailVerified: true,
      username: this.string(user.login),
      firstName: name[0],
      lastName: name.slice(1).join(' '),
    };
  }

  private credentials(provider: PlayerAuthProvider): {
    clientId: string;
    clientSecret: string;
  } {
    const prefix = provider === PlayerAuthProvider.GOOGLE ? 'google' : 'github';
    const clientId = this.config.get<string>(`playerAuth.${prefix}ClientId`);
    const clientSecret = this.config.get<string>(
      `playerAuth.${prefix}ClientSecret`,
    );
    if (!clientId || !clientSecret) {
      throw new Error(`${prefix} OAuth is not configured`);
    }
    return { clientId, clientSecret };
  }

  private async json(response: Response): Promise<JsonRecord> {
    const body = (await response.json().catch(() => ({}))) as unknown;
    return typeof body === 'object' && body !== null
      ? (body as JsonRecord)
      : {};
  }

  private string(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
