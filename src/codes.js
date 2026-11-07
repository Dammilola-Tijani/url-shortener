import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Random (not sequential) so codes can't be enumerated by incrementing a counter.
// 62^7 ≈ 3.5 trillion combinations; collisions are handled by retrying on insert.
export function generateCode(length = 7) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// Paths the server uses itself must never be claimable as short codes.
const RESERVED = new Set(['api', 'health']);
const CUSTOM_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function isValidCustomCode(code) {
  return typeof code === 'string' && CUSTOM_CODE_RE.test(code) && !RESERVED.has(code.toLowerCase());
}
