import { describe, expect, it } from "vitest";
import "./helpers";
import { ssrfBlockReason } from "../worker/index";

/* ---------------------------------------------------------------------- *
 * `ssrfBlockReason` is the only thing standing between a feed URL a user
 * pastes in and this Worker's own network — every row here is a hostname
 * a hostile (or just malformed) feed link could actually carry.
 * ---------------------------------------------------------------------- */

describe("ssrfBlockReason", () => {
  const cases: { name: string; hostname: string; blocked: boolean }[] = [
    // -- blocked by name --
    { name: "localhost", hostname: "localhost", blocked: true },
    { name: "LOCALHOST (case-insensitive)", hostname: "LOCALHOST", blocked: true },
    { name: "a .localhost subdomain", hostname: "foo.localhost", blocked: true },
    { name: "a .internal subdomain", hostname: "anything.internal", blocked: true },

    // -- blocked IPv4, dotted decimal --
    { name: "127.0.0.1 (loopback)", hostname: "127.0.0.1", blocked: true },
    { name: "127.1.2.3 (loopback /8)", hostname: "127.1.2.3", blocked: true },
    { name: "10.0.0.1 (private)", hostname: "10.0.0.1", blocked: true },
    { name: "172.16.0.1 (private, low end)", hostname: "172.16.0.1", blocked: true },
    { name: "172.31.255.255 (private, high end)", hostname: "172.31.255.255", blocked: true },
    { name: "192.168.1.1 (private)", hostname: "192.168.1.1", blocked: true },
    {
      name: "169.254.169.254 — the cloud metadata endpoint",
      hostname: "169.254.169.254",
      blocked: true,
    },

    // -- allowed IPv4 --
    { name: "172.15.0.1 (just below the private block)", hostname: "172.15.0.1", blocked: false },
    { name: "172.32.0.1 (just above the private block)", hostname: "172.32.0.1", blocked: false },
    { name: "192.169.1.1 (looks like 192.168, isn't)", hostname: "192.169.1.1", blocked: false },
    { name: "8.8.8.8 (public)", hostname: "8.8.8.8", blocked: false },
    { name: "1.1.1.1 (public)", hostname: "1.1.1.1", blocked: false },

    // -- IPv4 literals in non-decimal-dotted forms — a resolver accepts all
    // of these as 127.0.0.1 or 169.254.169.254, so the guard must too, or a
    // feed URL can spell its way past a naive dotted-decimal check.
    {
      name: "2130706433 — 127.0.0.1 as a bare decimal integer",
      hostname: "2130706433",
      blocked: true,
    },
    {
      name: "0177.0.0.1 — 127.0.0.1 with an octal leading octet",
      hostname: "0177.0.0.1",
      blocked: true,
    },
    {
      name: "0x7f000001 — 127.0.0.1 as a full 32-bit hex integer",
      hostname: "0x7f000001",
      blocked: true,
    },
    {
      name: "0x7f.0.0.1 — 127.0.0.1 with a hex leading octet",
      hostname: "0x7f.0.0.1",
      blocked: true,
    },
    {
      name: "2852039166 — the metadata endpoint as a bare decimal integer",
      hostname: "2852039166",
      blocked: true,
    },
    {
      name: "0251.254.169.254 — the metadata endpoint with an octal leading octet",
      hostname: "0251.254.169.254",
      blocked: true,
    },
    {
      name: "0xa9fea9fe — the metadata endpoint as a full 32-bit hex integer",
      hostname: "0xa9fea9fe",
      blocked: true,
    },

    // -- blocked IPv6 --
    { name: "::1 (loopback)", hostname: "::1", blocked: true },
    { name: "[::1] bracketed, as a URL hostname arrives", hostname: "[::1]", blocked: true },
    { name: "fc00::1 (unique local)", hostname: "fc00::1", blocked: true },
    { name: "fd12:3456::1 (unique local)", hostname: "fd12:3456::1", blocked: true },
    { name: "fe80::1 (link-local)", hostname: "fe80::1", blocked: true },
    { name: "[fe80::1] bracketed", hostname: "[fe80::1]", blocked: true },
    {
      name: "::ffff:127.0.0.1 — loopback wearing an IPv4-mapped IPv6 hat",
      hostname: "::ffff:127.0.0.1",
      blocked: true,
    },
    {
      name: "[::ffff:7f00:1] — the same address, hex groups, bracketed",
      hostname: "[::ffff:7f00:1]",
      blocked: true,
    },

    // -- allowed IPv6 --
    { name: "2001:4860:4860::8888 (public)", hostname: "2001:4860:4860::8888", blocked: false },
    { name: "[2606:4700::1111] bracketed, public", hostname: "[2606:4700::1111]", blocked: false },

    // -- allowed hostnames — real feed hosts must keep working --
    { name: "calendar.google.com", hostname: "calendar.google.com", blocked: false },
    { name: "p01-calendars.icloud.com", hostname: "p01-calendars.icloud.com", blocked: false },
  ];

  it.each(cases)("$name", ({ hostname, blocked }) => {
    const reason = ssrfBlockReason(hostname);
    if (blocked) expect(reason).not.toBeNull();
    else expect(reason).toBeNull();
  });
});
