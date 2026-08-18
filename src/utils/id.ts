/**
 * Id generation.
 *
 * `crypto.randomUUID` is the right default: collision-free without coordination,
 * which matters because copy/paste and project duplication both mint ids for
 * elements that already exist elsewhere. A counter would collide the moment two
 * tabs edit the same project, and a timestamp collides within a single paste.
 *
 * The fallback covers non-secure contexts (plain http on a LAN address), where
 * `crypto.randomUUID` is undefined. It is not cryptographically strong, and it
 * doesn't need to be - these ids are document-local, never a security boundary.
 */

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return fallbackId();
}

function fallbackId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Short, human-scannable suffix for auto-generated element names
 * ("Rectangle 3"). Not an identity - never use this as a key.
 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
