/* ------------------------------------------------------------------ *
 * The locked box.
 *
 * A cloud copy of a calendar is encrypted here, in the browser, before
 * it leaves. The server holds ciphertext and a row id; it never holds a
 * readable calendar, so a breach of it is not somebody's medical
 * appointments — see `SYNC.md`, Phase 2. The passphrase never leaves
 * either, and neither does the key derived from it.
 *
 * `unlock` derives once and hands back a `Vault` that reuses the key.
 * That is the whole reason the module has a handle rather than two free
 * functions: PBKDF2 at 600,000 rounds is 78 ms measured on a 13900K
 * under Node 26, and a browser's WebCrypto is the same OpenSSL-grade
 * primitive on hardware nobody chooses — so a sync that re-derived per
 * write would spend that again on every debounced save.
 *
 * Base tier: imports `./base64` and nothing else. No DOM, no storage,
 * no network — pure over its inputs plus WebCrypto.
 * ------------------------------------------------------------------ */

import { base64UrlToBytes, bytesToBase64Url } from "./base64";

/**
 * The envelope's version, and it leads the payload so a reader knows
 * what it is holding before it has decrypted a byte. A version above
 * this one is refused rather than attempted, for `mirror.ts`'s reason:
 * a reader that guesses at a format it is too old for destroys the
 * fields it has no name for — and here it cannot even see them.
 */
export const VAULT_VERSION = 1;

/**
 * PBKDF2-SHA256 rounds. WebCrypto has PBKDF2 natively where Argon2id
 * would want wasm, so the only defence against an offline guess is the
 * count, and it is deliberately set where the derivation is felt once
 * per session rather than per write. Raising it is a format change in
 * everything but name: an existing box was sealed under a key derived
 * at the old count, so a bump needs a `VAULT_VERSION` bump carrying the
 * old count with it.
 */
export const PBKDF2_ITERATIONS = 600_000;

const VERSION_BYTES = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
/** GCM's authentication tag, appended to the ciphertext by WebCrypto.
 *  Named because it is what makes the shortest possible payload 45 bytes
 *  and a shorter one a truncation rather than an empty calendar. */
const TAG_BYTES = 16;

const HEADER_BYTES = VERSION_BYTES + SALT_BYTES + IV_BYTES;
const MIN_BYTES = HEADER_BYTES + TAG_BYTES;

const utf8 = new TextEncoder();
const utf8Reader = new TextDecoder();

/** A wrong passphrase, which is recoverable: the user types it again.
 *  GCM's tag failing is this and nothing else. */
export class WrongPassphrase extends Error {}

/** A payload that is not one: not base64url, too short to hold a box, or
 *  a version this build does not know. A different problem with a
 *  different remedy, which is why it is a different class — a caller that
 *  cannot tell the two apart tells a user their passphrase is wrong when
 *  their data is damaged, or the reverse. */
export class UnreadablePayload extends Error {}

export interface Vault {
  seal(plaintext: string): Promise<string>;
  open(payload: string): Promise<string>;
}

/** The parsed envelope, minus the ciphertext's meaning. */
interface Envelope {
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  body: Uint8Array<ArrayBuffer>;
}

/**
 * `version(1) || salt(16) || iv(12) || ciphertext-with-tag`, base64url.
 *
 * `null` rather than a throw because `saltOf` answers with `null` too and
 * both callers here name the failure themselves — the caller knows
 * whether it is reading a payload or being handed one.
 */
function parse(payload: string): Envelope | null {
  const bytes = base64UrlToBytes(payload);
  if (!bytes || bytes.length < MIN_BYTES) return null;
  // `0` is not a version anybody wrote, and a version above ours is a box
  // from a newer build; both are refusals rather than attempts.
  if (bytes[0] < 1 || bytes[0] > VAULT_VERSION) return null;
  return {
    salt: bytes.subarray(VERSION_BYTES, VERSION_BYTES + SALT_BYTES),
    iv: bytes.subarray(VERSION_BYTES + SALT_BYTES, HEADER_BYTES),
    body: bytes.subarray(HEADER_BYTES),
  };
}

/**
 * The salt a payload was sealed under, or `null` for anything that is not
 * a payload of a version this build understands.
 *
 * Exported so a caller holding a box can reopen it without knowing the
 * passphrase yet: the salt is in the envelope precisely so a second
 * machine, a second session or a re-prompt derives the same key.
 */
export function saltOf(payload: string): Uint8Array | null {
  const envelope = parse(payload);
  // Copied rather than handed out as a view: the caller must not be able
  // to reach the rest of the payload's bytes through it.
  return envelope ? new Uint8Array(envelope.salt) : null;
}

/**
 * A vault, keyed by `passphrase`.
 *
 * With `payload`, the salt is read from it — that is reopening an
 * existing box, in this session or on another machine. Without one, a
 * fresh 16-byte salt is generated: that is enrolment, and the first
 * `seal` is what commits it.
 *
 * An unreadable `payload` throws rather than quietly enrolling a fresh
 * salt. A vault built on the wrong salt opens nothing, so the quiet
 * version would answer every later `open` with `WrongPassphrase` — the
 * two failures collapsed into the one the user cannot act on.
 */
export async function unlock(passphrase: string, payload?: string): Promise<Vault> {
  let salt: Uint8Array<ArrayBuffer>;
  if (payload === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  } else {
    const envelope = parse(payload);
    if (!envelope) throw new UnreadablePayload("not a vault payload this build can read");
    // Copied off the payload's own bytes, so the key's salt does not keep
    // the whole ciphertext alive for as long as the vault is open.
    salt = new Uint8Array(envelope.salt);
  }

  const material = await crypto.subtle.importKey("raw", utf8.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    // Not extractable: nothing here needs the key's bytes, and a key that
    // cannot be read out cannot be logged, stored or posted by mistake.
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async seal(plaintext: string): Promise<string> {
      // A fresh random IV per seal, never derived and never reused. Under
      // one key, two GCM messages sharing an IV leak the XOR of their
      // plaintexts *and* the authentication subkey, which lets an attacker
      // forge boxes this vault will open — catastrophic rather than merely
      // weak, and a sync seals the same document over and over.
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const cipher = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8.encode(plaintext)),
      );
      const out = new Uint8Array(HEADER_BYTES + cipher.length);
      out[0] = VAULT_VERSION;
      out.set(salt, VERSION_BYTES);
      out.set(iv, VERSION_BYTES + SALT_BYTES);
      out.set(cipher, HEADER_BYTES);
      return bytesToBase64Url(out);
    },

    async open(payload: string): Promise<string> {
      const envelope = parse(payload);
      if (!envelope) throw new UnreadablePayload("not a vault payload this build can read");
      let plain: ArrayBuffer;
      try {
        plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: envelope.iv },
          key,
          envelope.body,
        );
      } catch {
        // The tag did not verify. That is a wrong key — a mistyped
        // passphrase, or a box sealed under a different salt than this
        // vault was unlocked with, which is the same remedy: unlock again
        // with this payload. Tampered ciphertext lands here too, and GCM
        // cannot tell us which, so the recoverable reading is the honest
        // one to offer.
        throw new WrongPassphrase("passphrase does not open this payload");
      }
      // No fatal decoder: the tag verifying proves these are the bytes
      // `seal` wrote, and `seal` wrote UTF-8.
      return utf8Reader.decode(plain);
    },
  };
}
