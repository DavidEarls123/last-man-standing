import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20) {
  const buffer = crypto.randomBytes(bytes);
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) secret += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return secret;
}

export function base32Decode(secret) {
  const clean = secret.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP, SHA-1, 6 digits, 30s step. */
export function totpCode(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Accepts codes one step either side of now, to tolerate clock drift. */
export function verifyTotp(secret, token, window = 1) {
  const candidate = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = totpCode(secret, counter + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return true;
  }
  return false;
}

export function otpauthUrl({ secret, account, issuer = 'Last Man Standing' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
