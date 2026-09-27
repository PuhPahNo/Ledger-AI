import { getEnv } from '../config/env.js';

/**
 * QuickBooks Online Accounting API v3 over plain fetch — OAuth 2.0 (authorization code) and the
 * handful of READ endpoints Ledger uses (query, cdc, companyinfo, attachment download). Nothing
 * here ever writes to QuickBooks.
 */

export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
export const QBO_MINOR_VERSION = '75';
export const QBO_PAGE_SIZE = 1000;
/** Intuit throttles at 500 requests/minute per realm; stay comfortably under it. */
export const QBO_MIN_REQUEST_INTERVAL_MS = Math.ceil(60_000 / 450);
/** Refresh the (1h) access token when it has less than this left. */
export const QBO_ACCESS_TOKEN_SKEW_MS = 5 * 60 * 1000;

const INTUIT_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const INTUIT_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QBO_API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;
const realSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: 'sandbox' | 'production';
  apiBase: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
}

export function isQuickbooksConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.QUICKBOOKS_CLIENT_ID && env.QUICKBOOKS_CLIENT_SECRET && env.QUICKBOOKS_REDIRECT_URI);
}

export function quickbooksConfig(): QboConfig | null {
  const env = getEnv();
  if (!isQuickbooksConfigured()) return null;
  // QUICKBOOKS_AUTH_BASE (local mock only) replaces all three Intuit OAuth hosts.
  const authBase = env.QUICKBOOKS_AUTH_BASE.replace(/\/+$/, '');
  return {
    clientId: env.QUICKBOOKS_CLIENT_ID,
    clientSecret: env.QUICKBOOKS_CLIENT_SECRET,
    redirectUri: env.QUICKBOOKS_REDIRECT_URI,
    environment: env.QUICKBOOKS_ENV,
    apiBase: (env.QUICKBOOKS_API_BASE || QBO_API_BASE[env.QUICKBOOKS_ENV]).replace(/\/+$/, ''),
    authorizeUrl: authBase ? `${authBase}/connect/oauth2` : INTUIT_AUTHORIZE_URL,
    tokenUrl: authBase ? `${authBase}/oauth2/v1/tokens/bearer` : INTUIT_TOKEN_URL,
    revokeUrl: authBase ? `${authBase}/v2/oauth2/tokens/revoke` : INTUIT_REVOKE_URL,
  };
}

export function quickbooksAuthorizeUrl(config: QboConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: QBO_SCOPE,
    redirect_uri: config.redirectUri,
    state,
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// OAuth tokens
// ---------------------------------------------------------------------------------------------

export interface QboTokenSet {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
}

/** The refresh token is dead (revoked, expired, or superseded): only a new consent fixes it. */
export class QboReauthRequiredError extends Error {
  constructor(message = 'QuickBooks authorization expired or was revoked. Reconnect QuickBooks.') {
    super(message);
    this.name = 'QboReauthRequiredError';
  }
}

export class QboApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
    this.name = 'QboApiError';
  }
}

function basicAuth(config: QboConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

export function parseTokenResponse(body: Record<string, unknown>, now: Date): QboTokenSet {
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  if (!accessToken || !refreshToken) throw new QboApiError(502, 'QuickBooks token response was missing tokens');
  const expiresIn = Number(body.expires_in ?? 3600);
  const refreshExpiresIn = Number(body.x_refresh_token_expires_in ?? NaN);
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000),
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresIn) ? new Date(now.getTime() + refreshExpiresIn * 1000) : null,
  };
}

async function tokenRequest(
  config: QboConfig,
  form: Record<string, string>,
  fetchImpl: FetchLike,
  now: Date,
): Promise<QboTokenSet> {
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(config),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    if (body.error === 'invalid_grant' || (response.status === 401 && form.grant_type === 'refresh_token')) {
      throw new QboReauthRequiredError();
    }
    throw new QboApiError(response.status, `QuickBooks token request failed (${response.status}${body.error ? `: ${String(body.error)}` : ''})`);
  }
  return parseTokenResponse(body, now);
}

export function exchangeAuthorizationCode(
  config: QboConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
  now = new Date(),
): Promise<QboTokenSet> {
  return tokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }, fetchImpl, now);
}

export function refreshQuickbooksTokens(
  config: QboConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
  now = new Date(),
): Promise<QboTokenSet> {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl, now);
}

/** Best effort: revoking also invalidates the paired access token at Intuit. */
export async function revokeQuickbooksToken(config: QboConfig, token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(config.revokeUrl, {
      method: 'POST',
      headers: { Authorization: basicAuth(config), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface QboTokenStore {
  /** Current tokens (the implementation should hold a row lock until persist/return). */
  load(): Promise<QboTokenSet>;
  /** Persist a refreshed set — Intuit rotates refresh tokens, so this must run on EVERY refresh. */
  persist(tokens: QboTokenSet): Promise<void>;
}

export function accessTokenNeedsRefresh(tokens: QboTokenSet, now: Date, skewMs = QBO_ACCESS_TOKEN_SKEW_MS): boolean {
  return tokens.accessTokenExpiresAt.getTime() - now.getTime() <= skewMs;
}

/**
 * Returns a usable access token, refreshing (and persisting the rotated refresh token) when the
 * current one is near expiry or `force` is set (after a 401). QboReauthRequiredError propagates
 * so the caller can flag the connection for re-consent.
 */
export async function ensureFreshAccessToken(
  config: QboConfig,
  store: QboTokenStore,
  options: { force?: boolean; fetchImpl?: FetchLike; now?: Date } = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const current = await store.load();
  if (!options.force && !accessTokenNeedsRefresh(current, now)) return current.accessToken;
  const refreshed = await refreshQuickbooksTokens(config, current.refreshToken, options.fetchImpl ?? fetch, now);
  await store.persist(refreshed);
  return refreshed.accessToken;
}

// ---------------------------------------------------------------------------------------------
// Accounting API (read-only)
// ---------------------------------------------------------------------------------------------

export type QboEntity = Record<string, any>;

export interface QboCdcEntityResult {
  entity: string;
  items: QboEntity[];
}

export interface QboCdcResult {
  entities: Map<string, QboEntity[]>;
  time: string | null;
}

/**
 * Parses a ChangeDataCapture response:
 * { CDCResponse: [{ QueryResponse: [{ Purchase: [...] }, { Vendor: [...] }] }], time }.
 * Deleted objects come back as { Id, status: 'Deleted', MetaData }.
 */
export function parseCdcResponse(body: Record<string, any>, entityNames: string[]): QboCdcResult {
  const entities = new Map<string, QboEntity[]>(entityNames.map((name) => [name, []]));
  const cdcResponses: any[] = Array.isArray(body?.CDCResponse) ? body.CDCResponse : [];
  for (const cdc of cdcResponses) {
    const queryResponses: any[] = Array.isArray(cdc?.QueryResponse) ? cdc.QueryResponse : [];
    for (const qr of queryResponses) {
      if (!qr || typeof qr !== 'object') continue;
      for (const [key, value] of Object.entries(qr)) {
        if (!Array.isArray(value)) continue;
        const list = entities.get(key) ?? [];
        list.push(...(value as QboEntity[]));
        entities.set(key, list);
      }
    }
  }
  return { entities, time: typeof body?.time === 'string' ? body.time : null };
}

/** Items from a query response page: { QueryResponse: { Purchase: [...], startPosition, maxResults } }. */
export function parseQueryPage(body: Record<string, any>, entity: string): QboEntity[] {
  const page = body?.QueryResponse?.[entity];
  return Array.isArray(page) ? page : [];
}

function faultMessage(body: any): string | null {
  const errors = body?.Fault?.Error ?? body?.fault?.error;
  if (Array.isArray(errors) && errors.length) {
    const first = errors[0];
    return [first?.Message ?? first?.message, first?.Detail ?? first?.detail].filter(Boolean).join(': ') || null;
  }
  return null;
}

export interface QboApiClientOptions {
  realmId: string;
  apiBase: string;
  getAccessToken: (force: boolean) => Promise<string>;
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  minIntervalMs?: number;
  maxRetries?: number;
}

export class QboApiClient {
  private lastRequestAt = 0;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  requestCount = 0;

  constructor(private readonly options: QboApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.minIntervalMs = options.minIntervalMs ?? QBO_MIN_REQUEST_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? 5;
  }

  private url(pathAndQuery: string): string {
    const separator = pathAndQuery.includes('?') ? '&' : '?';
    return `${this.options.apiBase}/v3/company/${encodeURIComponent(this.options.realmId)}${pathAndQuery}${separator}minorversion=${QBO_MINOR_VERSION}`;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /** GET with auth, per-realm pacing, one forced token refresh on 401 and backoff on 429/5xx. */
  async get(pathAndQuery: string): Promise<Record<string, any>> {
    let forcedRefresh = false;
    for (let attempt = 0; ; attempt += 1) {
      await this.throttle();
      const token = await this.options.getAccessToken(false);
      this.requestCount += 1;
      const response = await this.fetchImpl(this.url(pathAndQuery), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (response.status === 401 && !forcedRefresh) {
        forcedRefresh = true;
        await this.options.getAccessToken(true);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 1000 * 2 ** attempt);
        await response.text().catch(() => '');
        await this.sleep(delay);
        continue;
      }
      const text = await response.text();
      let body: any = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text.slice(0, 200) };
      }
      if (!response.ok) {
        throw new QboApiError(response.status, `QuickBooks API ${response.status}: ${faultMessage(body) ?? 'request failed'}`, body?.Fault);
      }
      if (body?.Fault) throw new QboApiError(400, `QuickBooks API fault: ${faultMessage(body) ?? 'unknown'}`, body.Fault);
      return body;
    }
  }

  /** Runs a query across all pages (STARTPOSITION / MAXRESULTS 1000). */
  async queryAll(entity: string, where = ''): Promise<QboEntity[]> {
    const all: QboEntity[] = [];
    for (let start = 1; ; start += QBO_PAGE_SIZE) {
      const statement = `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ''} STARTPOSITION ${start} MAXRESULTS ${QBO_PAGE_SIZE}`;
      const body = await this.get(`/query?query=${encodeURIComponent(statement)}`);
      const page = parseQueryPage(body, entity);
      all.push(...page);
      if (page.length < QBO_PAGE_SIZE) break;
    }
    return all;
  }

  async cdc(entities: string[], changedSince: Date): Promise<QboCdcResult> {
    const body = await this.get(`/cdc?entities=${encodeURIComponent(entities.join(','))}&changedSince=${encodeURIComponent(changedSince.toISOString())}`);
    return parseCdcResponse(body, entities);
  }

  async companyInfo(): Promise<QboEntity | null> {
    const body = await this.get(`/companyinfo/${encodeURIComponent(this.options.realmId)}`);
    return (body?.CompanyInfo as QboEntity | undefined) ?? null;
  }

  /**
   * Downloads an attachment. The Attachable's TempDownloadUri is a short-lived pre-signed URL (no
   * bearer token is sent to it); when absent, /download/{id} returns a fresh one as text.
   */
  async downloadAttachable(attachable: { Id: string; TempDownloadUri?: string }, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
    let uri = typeof attachable.TempDownloadUri === 'string' ? attachable.TempDownloadUri : '';
    if (!uri) {
      await this.throttle();
      const token = await this.options.getAccessToken(false);
      const response = await this.fetchImpl(this.url(`/download/${encodeURIComponent(attachable.Id)}`), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/plain' },
      });
      if (!response.ok) throw new QboApiError(response.status, `QuickBooks attachment link failed (${response.status})`);
      uri = (await response.text()).trim();
    }
    // Pre-signed links are https; plain http is only accepted from the configured (local mock) API host.
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new QboApiError(502, 'QuickBooks returned an invalid attachment URL');
    }
    const sameHostAsApi = parsed.host === new URL(this.options.apiBase).host;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && sameHostAsApi)) {
      throw new QboApiError(502, 'QuickBooks returned an invalid attachment URL');
    }
    const response = await this.fetchImpl(uri, { method: 'GET' });
    if (!response.ok) throw new QboApiError(response.status, `QuickBooks attachment download failed (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new QboApiError(413, 'QuickBooks attachment is larger than 25 MB');
    return buffer;
  }
}
