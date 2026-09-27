import QRCode from 'qrcode';
import { generateSecret, generateURI, verifySync } from 'otplib';

export function createTotpSecret(username: string): { secret: string; otpauth: string } {
  const secret = generateSecret();
  const otpauth = generateURI({ issuer: 'Ledger AI', label: username, secret });
  return { secret, otpauth };
}

/** Stateless check. Prefer verifyTotpForUser, which also rejects replayed codes. */
export function verifyTotp(secret: string, token: string): boolean {
  return verifySync({ secret, token }).valid;
}

/**
 * Last accepted RFC 6238 time step per user. In memory is enough for the single
 * production instance; a restart only reopens the (30s) window for the current code.
 */
const lastAcceptedTimeStep = new Map<string, number>();

/**
 * Verifies a TOTP code and rejects any code whose time step is not newer than the last
 * one accepted for this user, so an observed code cannot be replayed.
 */
export function verifyTotpForUser(userId: string, secret: string, token: string, epoch?: number): boolean {
  const afterTimeStep = lastAcceptedTimeStep.get(userId);
  const result = verifySync({
    secret,
    token: token.trim(),
    ...(epoch !== undefined ? { epoch } : {}),
    ...(afterTimeStep !== undefined ? { afterTimeStep } : {}),
  });
  if (!result.valid) return false;
  const timeStep = (result as { timeStep?: number }).timeStep;
  if (typeof timeStep !== 'number') return false;
  if (afterTimeStep !== undefined && timeStep <= afterTimeStep) return false;
  lastAcceptedTimeStep.set(userId, timeStep);
  return true;
}

export function resetTotpReplayCache(): void {
  lastAcceptedTimeStep.clear();
}

export function toQrDataUrl(otpauth: string): Promise<string> {
  return QRCode.toDataURL(otpauth);
}
