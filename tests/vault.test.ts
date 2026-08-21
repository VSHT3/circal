import { beforeAll, describe, expect, it } from "vitest";
// Registers the shared matchers, per the suite's floor. No fixture from it is
// used here on purpose: a vault knows nothing about events, days or zones.
import "./helpers";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/base64";
import {
  UnreadablePayload,
  VAULT_VERSION,
  WrongPassphrase,
  derive,
  saltOf,
  unlock,
  vaultOf,
  type Vault,
} from "@/lib/vault";

/* ---------------------------------------------------------------------- *
 * The locked box. Two halves to hold down, and the second is the one that
 * matters: the round trip must return the calendar byte for byte, and
 * every way a box can fail to open has to come back as the *right* one of
 * two names. A caller that cannot tell a mistyped passphrase from a
 * damaged payload tells the user to type it again while their data rots,
 * or the reverse.
 *
 * **No `tests/west/` case.** There is no date arithmetic in the module at
 * all — no `dayKey`, no `startOfDay`, no `addDays`, no instant anywhere —
 * so no zone can change an answer. Stated because the standing rule is the
 * opposite, and a reader should see the exemption was reasoned rather than
 * forgotten.
 *
 * Measured on a 13900K, Node 26: one `unlock` is 78 ms at 600,000 rounds,
 * which is why the vault below is derived once in `beforeAll` and shared
 * by every case that does not specifically need a fresh derivation — the
 * three cases that do are three quarters of this file's runtime. A 392 KB
 * document seals to 1.334× its UTF-8 length, which is base64url's 4/3 and
 * nothing else: the ciphertext is the plaintext plus 45 bytes of envelope
 * and tag, whatever its size.
 * ---------------------------------------------------------------------- */

const PASSPHRASE = "correct horse battery staple";

/** The envelope's fixed prefix: version(1) + salt(16) + iv(12). Written out
 *  rather than imported, because the layout *is* the format's contract and
 *  a test deriving it from the module's own constants would agree with the
 *  module however wrong both were. */
const HEADER_BYTES = 29;

let vault: Vault;

beforeAll(async () => {
  vault = await unlock(PASSPHRASE);
});

/** Payload → bytes, loudly. Every forging case needs the bytes, and a
 *  `?? throw` per case would bury the assertion under the plumbing. */
function bytesOf(payload: string): Uint8Array {
  const bytes = base64UrlToBytes(payload);
  if (!bytes) throw new Error("seal produced something that is not base64url");
  return bytes;
}

/** The same payload with one byte replaced — how a case makes exactly one
 *  thing wrong at a time. */
function forge(payload: string, index: number, byte: number): string {
  const bytes = bytesOf(payload);
  bytes[index] = byte;
  return bytesToBase64Url(bytes);
}

/* -------------------------------- the trip -------------------------------- */

describe("seal / open — the round trip", () => {
  it.each([
    { name: "ascii", text: "Design review, Room 2" },
    { name: "emoji", text: "🎉 launch 🍰 party 👩‍👩‍👧‍👦" },
    { name: "accented", text: "Réunion à Zürich — café crème, naïve, Ægir" },
    { name: "cjk", text: "設計レビュー・会議室二・日本語のカレンダー・中文标题・한국어" },
    { name: "mixed scripts", text: "Встреча · العربية · עברית · ελληνικά · ไทย" },
    { name: "empty", text: "" },
    {
      name: "json document",
      text: JSON.stringify({ rev: 7, events: [{ id: "e1", title: "☕" }] }),
    },
  ])("returns $name exactly", async ({ text }) => {
    // Multi-byte UTF-8 is the case worth the table: a byte-oriented
    // implementation passes ASCII and loses every event title that is not
    // English, which is most calendars.
    expect(await vault.open(await vault.seal(text))).toBe(text);
  });

  it("round-trips a document the size of a real calendar", async () => {
    const plaintext = JSON.stringify({
      version: 2,
      events: Array.from({ length: 2_000 }, (_, i) => ({
        id: `evt-${i}`,
        title: `Standup ${i} · 会議 · réunion`,
        start: 1_772_946_000_000 + i * 3_600_000,
        end: 1_772_949_600_000 + i * 3_600_000,
        notes: "Bring the two mocks and the printout of last week's numbers.",
        updatedAt: 1_772_946_000_000,
      })),
    });
    expect.soft(plaintext.length).toBeGreaterThan(300_000);
    const payload = await vault.seal(plaintext);
    expect.soft(await vault.open(payload)).toBe(plaintext);
    // The whole overhead is base64url's 4/3 over 45 bytes of envelope and
    // tag, so the ratio is a constant a caller can budget a row against.
    expect(payload.length / plaintext.length).toBeLessThan(1.4);
  });

  it("mints a fresh IV per seal, so one plaintext never seals twice the same", async () => {
    const text = "the same document, sealed twice";
    const [first, second] = [await vault.seal(text), await vault.seal(text)];
    // Identical payloads would mean a derived or reused IV, which under one
    // AES-GCM key leaks the XOR of the two plaintexts and the tag subkey.
    expect.soft(first).not.toBe(second);
    expect.soft(bytesOf(first).subarray(17, 29)).not.toEqual(bytesOf(second).subarray(17, 29));
    expect.soft(await vault.open(first)).toBe(text);
    expect(await vault.open(second)).toBe(text);
  });

  it("leads the payload with the version it sealed under", async () => {
    expect(bytesOf(await vault.seal("x"))[0]).toBe(VAULT_VERSION);
  });
});

/* ------------------------------- the refusals ------------------------------ */

describe("open — a wrong passphrase and a damaged payload are different answers", () => {
  it("names a wrong passphrase, and not an unreadable payload", async () => {
    const payload = await vault.seal("private");
    // The one case that must derive its own key: the salt is the sealed
    // one, so only the passphrase differs.
    const wrong = await unlock("correct horse battery stapler", payload);
    await expect(wrong.open(payload)).rejects.toThrow(WrongPassphrase);
    await expect(wrong.open(payload)).rejects.not.toThrow(UnreadablePayload);
  });

  it.each([
    {
      name: "a flipped ciphertext byte",
      why: "GCM's tag is what caught it, and a tag failure has one name",
      damage: (payload: string) => forge(payload, HEADER_BYTES, bytesOf(payload)[HEADER_BYTES] ^ 1),
      expected: WrongPassphrase,
    },
    {
      name: "a truncated tag",
      why: "still envelope-shaped, so the tag is what fails",
      damage: (payload: string) => bytesToBase64Url(bytesOf(payload).subarray(0, -4)),
      expected: WrongPassphrase,
    },
    {
      name: "a payload truncated below an envelope",
      why: "there is no box in there to try a key against",
      damage: (payload: string) => bytesToBase64Url(bytesOf(payload).subarray(0, 20)),
      expected: UnreadablePayload,
    },
    {
      name: "an unknown version",
      why: "a newer build's format, refused rather than attempted",
      damage: (payload: string) => forge(payload, 0, VAULT_VERSION + 1),
      expected: UnreadablePayload,
    },
    {
      name: "version zero",
      why: "nobody wrote a zero, so it is not a payload",
      damage: (payload: string) => forge(payload, 0, 0),
      expected: UnreadablePayload,
    },
    {
      name: "characters outside base64url",
      why: "never was a payload, whatever the passphrase",
      damage: () => "not base64url!! padded=",
      expected: UnreadablePayload,
    },
    {
      name: "nothing at all",
      why: "an empty string is the commonest way a row arrives blank",
      damage: () => "",
      expected: UnreadablePayload,
    },
  ])("refuses $name — $why", async ({ damage, expected }) => {
    const payload = await vault.seal("private");
    // Never a bare `Error`, never `null`, and never an empty document: a
    // caller silently handed `""` writes an empty calendar over a full one.
    await expect(vault.open(damage(payload))).rejects.toThrow(expected);
  });
});

/* --------------------------------- the salt -------------------------------- */

describe("saltOf — reopening without the passphrase yet", () => {
  it("returns the salt the payload was sealed under", async () => {
    const payload = await vault.seal("private");
    expect.soft(saltOf(payload)).toEqual(bytesOf(payload).subarray(1, 17));
    // One vault, one salt: it is the key's, not the box's, so two seals
    // carry the same 16 bytes and a reader can derive once for both.
    expect(saltOf(await vault.seal("other"))).toEqual(saltOf(payload));
  });

  it("hands out a copy, not a window onto the payload", async () => {
    const payload = await vault.seal("private");
    const salt = saltOf(payload);
    salt?.fill(0);
    expect(saltOf(payload)).not.toEqual(salt);
  });

  it.each([
    { name: "junk", payload: "not base64url!!" },
    { name: "an empty string", payload: "" },
    { name: "too few bytes to hold a box", payload: bytesToBase64Url(new Uint8Array(20)) },
    { name: "a version this build has no name for", payload: bytesToBase64Url(forged(9)) },
  ])("returns null for $name", ({ payload }) => {
    expect(saltOf(payload)).toBeNull();
  });

  it("derives the same key across sessions, so an existing box reopens", async () => {
    const payload = await vault.seal("written on the laptop");
    // A second machine, or the same one after a reload: passphrase plus the
    // box, and the salt comes out of the box.
    const reopened = await unlock(PASSPHRASE, payload);
    expect.soft(await reopened.open(payload)).toBe("written on the laptop");
    // And it seals under the same salt, so the row stays openable by both.
    expect(saltOf(await reopened.seal("written on the PC"))).toEqual(saltOf(payload));
  });

  it("refuses to enrol a fresh salt behind an unreadable payload", async () => {
    // The quiet alternative — shrug and generate a salt — returns a vault
    // that opens nothing, reporting `WrongPassphrase` forever for a
    // passphrase that was right. That is the two failures collapsed into
    // the one the user cannot act on.
    await expect(unlock(PASSPHRASE, "not base64url!!")).rejects.toThrow(UnreadablePayload);
  });
});

/* `unlock` is `derive` then `vaultOf`, split so a caller can *name* the key —
 * `cloudLink`'s "remember on this device" keeps the pair in IndexedDB, where a
 * non-extractable key can be persisted and used without ever being readable by
 * script. What is pinned here is that splitting it changed nothing: the same
 * key, the same salt, and still not extractable. */
describe("derive / vaultOf — a key a caller can keep", () => {
  it("builds a vault that opens what the composed unlock sealed", async () => {
    const payload = await vault.seal("written before the reload");
    const keyed = await derive(PASSPHRASE, payload);
    expect(await vaultOf(keyed).open(payload)).toBe("written before the reload");
  });

  it("hands back the salt the payload was sealed under, so seal stamps the same one", async () => {
    const payload = await vault.seal("private");
    const keyed = await derive(PASSPHRASE, payload);
    expect.soft(keyed.salt).toEqual(saltOf(payload));
    expect(saltOf(await vaultOf(keyed).seal("again"))).toEqual(saltOf(payload));
  });

  /* The property the whole feature rests on: it can be stored, and it cannot
   * be read. A key that answered `exportKey` would make remembering one the
   * same thing as writing the passphrase down. */
  it("derives a key that cannot be exported", async () => {
    const { key } = await derive(PASSPHRASE);
    expect.soft(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("carries both usages, which is why remembering one confers writing", async () => {
    const { key } = await derive(PASSPHRASE);
    expect(key.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("refuses an unreadable payload rather than enrolling a fresh salt", async () => {
    await expect(derive(PASSPHRASE, "not base64url!!")).rejects.toThrow(UnreadablePayload);
  });

  it("mints a fresh salt with no payload, which is enrolment", async () => {
    const a = await derive(PASSPHRASE);
    const b = await derive(PASSPHRASE);
    expect.soft(a.salt).toHaveLength(16);
    expect(a.salt).not.toEqual(b.salt);
  });
});

/** A minimum-length envelope carrying a given version byte, and nothing
 *  meaningful after it — enough for the parser to refuse on the version
 *  rather than on the length. */
function forged(version: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes[0] = version;
  return bytes;
}
