/* ------------------------------------------------------------------ *
 * base64url, over bytes.
 *
 * Extracted from `share.ts`, which had it inlined inside its own two
 * string functions, because `vault.ts` needs the same encoding over
 * bytes that are not text at all: a version byte, a salt, an IV and a
 * block of ciphertext. Two spellings of an alphabet swap is two chances
 * for one end of a payload to disagree with the other, and this is the
 * one layer where a disagreement is unrecoverable rather than merely
 * wrong — a box nobody can open has no undo step.
 *
 * base64url and not base64 for `share.ts`'s original reason, which
 * `vault.ts` inherits: the alphabet is `A-Za-z0-9-_`, so nothing in the
 * output needs percent-encoding or survives a transport differently
 * depending on who wrote it.
 *
 * Base tier: imports nothing.
 * ------------------------------------------------------------------ */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // A byte at a time rather than `String.fromCharCode(...bytes)`: the spread
  // is a call with one argument per byte, and a sealed calendar is hundreds
  // of thousands of them — well past the argument limit that makes the spread
  // throw rather than merely allocate.
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `null` for anything that is not base64url — a character outside the
 *  alphabet, or a length no padding can complete. Callers name the failure;
 *  this layer only says whether there were bytes in there.
 *
 *  `Uint8Array<ArrayBuffer>` rather than the default `ArrayBufferLike`
 *  because `BufferSource` excludes a view over a `SharedArrayBuffer`, and
 *  `vault.ts` hands these bytes straight to WebCrypto. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
