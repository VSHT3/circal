# Auth email templates

The two mails circal sends. They live here because a template that exists only in a dashboard form is one nobody can review, nobody can diff and a rebuilt project loses. Edit the file, run `pnpm verify`, commit, then paste the file's contents back into the dashboard: the dashboard is the thing that actually sends, and nothing in this repo can read it back.

## Where each one goes

Supabase dashboard → **Authentication** → **Emails** → **Templates**:

| File                  | Template           | Sent when                         |
| --------------------- | ------------------ | --------------------------------- |
| `confirm-signup.html` | **Confirm signup** | first-ever sign-in for an address |
| `magic-link.html`     | **Magic Link**     | every sign-in after that          |

Subject line, the same string in both, copy it exactly:

```
Your circal sign-in code
```

Paste the file into the template's **Message body** in the dashboard's source view, not the visual editor.

## Why there are two

`cloud.requestCode` calls one endpoint, `signInWithOtp`. Supabase picks the template for it by whether the address has signed in before: **Confirm signup** the first time, **Magic Link** every time after. Doing only Magic Link is the trap `AGENTS.md`'s `### The cloud row` documents, and it is a trap because it looks finished. Whoever set it up was a returning user by the time they tested, so their own sign-in works while every genuinely new address gets stock Supabase mail with a link in it, in front of a form asking for six digits. That is every user, once.

So the two files are twins. The reader must not be able to tell which one arrived, and there is nothing to say to a new address that is not also true of a returning one. The only difference between the files is the comment at the top naming which dashboard slot it belongs in.

Neither is reachable until custom SMTP is configured: Supabase gates template editing behind a provider. Provider first, templates second.

## The templates Supabase offers that circal does not use

**Invite user**, **Change email address**, **Reset password** and **Reauthentication** are deliberately not provided. circal has no passwords to reset, no invitations to send, and the address is the whole of the account, so there is nothing to change it to and nothing to reauthenticate against. Leave them on Supabase's stock text; nothing sends them.

## Copy, and what it depends on

Both mails say: here is your code, it expires in one hour, ignore this if you did not ask for it. Nothing else. No footer, no unsubscribe, no social links, because this is transactional mail from a product with none of those.

"one hour" is the dashboard's OTP expiry, which defaults to 3600 seconds. Change that setting and change this sentence in both files, or the mail is lying about the only deadline it states.

`{{ .Token }}` is the six digits. It is bare text in its own table cell, wrapped in no element of any kind: people tap and hold to copy it on a phone, and a badge, a border or a span per digit is one more thing a selection catches on.

The preheader is the hidden line the inbox prints beside the subject. Without one, Gmail scavenges the first words of the body, which is how the inbox came to read "Your sign-in link Your circal sign-in code is". It is followed by a run of zero-width non-joiners so there is nothing left to scavenge.

## Why the mail is light and circal is black

circal is black on black and matching it was the tempting move. It loses to the clients. Outlook's dark modes and several webmail clients force-invert a mail whose own colours they do not trust, Gmail on mobile adjusts colours on its own terms, and the result of all that acting on a near-black mail is not circal's black, it is some client's guess at one, arriving as a grey box that reads as a rendering fault rather than a design. A light mail inverts predictably, because a dark rendering of it is one the client generated deliberately and knows how to be consistent about.

It stays recognisably circal by keeping the palette and swapping which end of it does the work: `#131315` (the app's `surface`) as the ink, `#5c5c60` (`ink-3`, ~7:1 on white where `ink-2` is only 3.4:1 and would fail as body text) for the two secondary lines, true black for the code itself, and one hairline rule under the wordmark. Lowercase wordmark, tight tracking, monospace for the numerals, nothing coloured and nothing decorative. The accent stays out: `#a3d9e4` is a stroke colour on black and washes out to nothing on paper.

## Constraints the files are built under

Email clients are a decade behind browsers and a broken sign-in mail is a user who cannot get in.

- Table layout, `role="presentation"`. The content table carries `width="480"` as an attribute, for Outlook, and `width: 100%; max-width: 480px` as style, for everything else: a fixed 480 in the style scrolls a 375px phone sideways, which was measured rather than assumed.
- Inline styles for everything that draws a pixel. The one `<style>` block declares `color-scheme` and nothing else, so a client that strips it renders the mail identically.
- No external CSS, no web fonts, no images. System font stacks only.
- The code is the payload and nothing competes with it: 34px, `0.2em` tracking, its own line. Outlook's Word engine drops the tracking and that is an acceptable degradation, since the digits are still the largest thing in the mail.
- No em dashes. House rule for prose a user reads through, and an email is exactly that.
