import QRCode from 'qrcode';
import { generateSecret, generateURI, verifySync } from 'otplib';

export function createTotpSecret(username: string): { secret: string; otpauth: string } {
  const secret = generateSecret();
  const otpauth = generateURI({ issuer: 'Ledger AI', label: username, secret });
  return { secret, otpauth };
}

export function verifyTotp(secret: string, token: string): boolean {
  return verifySync({ secret, token }).valid;
}

export function toQrDataUrl(otpauth: string): Promise<string> {
  return QRCode.toDataURL(otpauth);
}
