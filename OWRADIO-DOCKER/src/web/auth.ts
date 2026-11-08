/**
 * @file auth.ts
 * @description Double Authentication Subsystem for OWRadio.
 * Supports:
 * 1. Tier 1: Simple Admin Password from .env with timing-safe comparison.
 * 2. Tier 2: Optional Google OAuth via Supabase JWT token verification.
 * 3. HMAC-SHA256 Signed Session Tokens (7-day validity).
 */

import crypto from 'crypto';
import config from '../config.js';

export interface AuthSession {
  role: 'admin';
  authType: 'password' | 'supabase';
  user?: {
    email?: string;
    name?: string;
    avatar?: string;
  };
  issuedAt: number;
  expiresAt: number;
}

export class AuthService {
  private testAdminPassword?: string;
  private testAuthEnabled?: boolean;

  /**
   * Overrides password for testing suites.
   */
  public setTestPassword(pw?: string): void {
    this.testAdminPassword = pw;
  }

  /**
   * Overrides auth enabled flag for testing suites.
   */
  public setTestAuthEnabled(enabled?: boolean): void {
    this.testAuthEnabled = enabled;
  }

  /**
   * Determines if authentication is actively enforced.
   * Enabled if AUTH_ENABLED === true, or if ADMIN_PASSWORD / SUPABASE_URL are set.
   */
  public isAuthEnabled(): boolean {
    if (this.testAuthEnabled !== undefined) {
      return this.testAuthEnabled;
    }
    if (config.AUTH_ENABLED !== undefined) {
      return config.AUTH_ENABLED;
    }
    return !!(this.getAdminPassword()) ||
           !!(config.SUPABASE_URL && config.SUPABASE_URL.trim().length > 0);
  }

  private getAdminPassword(): string | undefined {
    return this.testAdminPassword || config.ADMIN_PASSWORD;
  }

  /**
   * Returns available authentication modes for frontend UI display.
   */
  public getAuthMode(): 'none' | 'simple' | 'supabase' | 'both' {
    if (!this.isAuthEnabled()) return 'none';
    const hasPassword = !!(this.getAdminPassword() && this.getAdminPassword()!.trim().length > 0);
    const hasSupabase = !!(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
    if (hasPassword && hasSupabase) return 'both';
    if (hasSupabase) return 'supabase';
    return 'simple';
  }

  /**
   * Verifies simple admin password using constant-time comparison to prevent timing attacks.
   */
  public verifyAdminPassword(password: string): boolean {
    const adminPass = this.getAdminPassword();
    if (!adminPass) return false;
    const expected = Buffer.from(adminPass);
    const actual = Buffer.from(password);
    if (expected.length !== actual.length) {
      // Fake compare to preserve timing
      crypto.timingSafeEqual(expected, expected);
      return false;
    }
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Verifies a Supabase Google OAuth access token or user session.
   */
  public async verifySupabaseToken(accessToken: string): Promise<{ valid: boolean; user?: any }> {
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      return { valid: false };
    }

    try {
      // Query Supabase /auth/v1/user endpoint to validate token with the project
      const cleanUrl = config.SUPABASE_URL.replace(/\/+$/, '');
      const res = await fetch(`${cleanUrl}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: config.SUPABASE_ANON_KEY,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return { valid: false };
      }

      const userData = (await res.json()) as any;
      return {
        valid: true,
        user: {
          id: userData.id,
          email: userData.email,
          name: userData.user_metadata?.full_name || userData.user_metadata?.name || userData.email,
          avatar: userData.user_metadata?.avatar_url || userData.user_metadata?.picture,
        },
      };
    } catch (err) {
      console.warn('[AuthService] Supabase token verification failed:', (err as Error).message);
      return { valid: false };
    }
  }

  /**
   * Creates a signed, base64url HMAC session token with 7-day TTL.
   */
  public createSessionToken(authType: 'password' | 'supabase', user?: any): string {
    const now = Math.floor(Date.now() / 1000);
    const session: AuthSession = {
      role: 'admin',
      authType,
      user,
      issuedAt: now,
      expiresAt: now + (7 * 24 * 3600), // 7 days
    };

    const payloadStr = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', config.SESSION_SECRET)
      .update(payloadStr)
      .digest('base64url');

    return `${payloadStr}.${signature}`;
  }

  /**
   * Validates an HMAC session token and ensures it has not expired.
   */
  public verifySessionToken(token: string): { valid: boolean; session?: AuthSession } {
    if (!token || typeof token !== 'string') return { valid: false };
    const parts = token.split('.');
    if (parts.length !== 2) return { valid: false };

    const [payloadStr, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', config.SESSION_SECRET)
      .update(payloadStr)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false };
    }

    try {
      const session = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8')) as AuthSession;
      const now = Math.floor(Date.now() / 1000);
      if (session.expiresAt && session.expiresAt < now) {
        return { valid: false }; // Expired
      }
      return { valid: true, session };
    } catch {
      return { valid: false };
    }
  }
}

export const authService = new AuthService();
export default authService;
