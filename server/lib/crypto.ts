import crypto from 'node:crypto';
import { getEnv } from '../config/env.js';

function keyBytes(): Buffer {
  const raw = getEnv().APP_ENCRYPTION_KEY;
  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === 32) return base64;
  const utf8 = Buffer.from(raw, 'utf8');
  if (utf8.length === 32) return utf8;
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptText(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptText(value: string): string {
  const payload = Buffer.from(value, 'base64url');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
