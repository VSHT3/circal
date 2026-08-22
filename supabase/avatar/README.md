# Sender avatar

The profile picture for the Google account on `noreply@send.circal.day`, the address the auth mails in `../templates/` are sent from. Without one, Gmail draws a grey silhouette beside every sign-in code circal sends.

It lives here rather than in `public/` because it is part of the email identity, not part of the site: nothing links to it, no build step touches it, and the service worker's `CACHE` does not need bumping when it changes. It is not a Supabase artefact either, but it is set up in the same sitting as the templates and by the same person.

| File             | What it is                               |
| ---------------- | ---------------------------------------- |
| `avatar.svg`     | source, the only file worth editing      |
| `avatar-512.png` | 512 x 512 PNG, RGB, no alpha, the upload |

## Where it appears, and at what size

Google circle-crops the picture and then shows it small. In a Gmail message list it is about 40px; in a phone notification it is smaller again. The 40px case is the binding constraint and everything below follows from it. Google's minimum is 250 x 250 square; 512 is uploaded instead because Google downsamples on its own terms and a larger source survives that better than one sized exactly to the floor.

## Opaque, not transparent, and full-bleed, not inset

Two decisions, both forced by how the image is shown rather than by taste.

**Opaque.** The mark is black. Gmail's list is white in light mode and near black in dark mode, and alpha in the upload composites onto whichever of those the client is drawing. A transparent PNG carrying a black mark is invisible in dark mode, which is the failure that cannot be noticed by the person who set it up if their own Gmail is in light mode. `rsvg-convert` emits this file with no alpha channel at all, because the source paints a rect over the whole canvas, so there is nothing to composite and nothing to get wrong.

The consequence, stated so nobody treats it as a bug: on a dark background the black disc merges into the list and the mark reads as a white ring floating in the row, while on white it reads as a black disc with a white circumference. Both are the mark, because the ring is the mark. One image that is legible on both beats two images when Google accepts only one.

**Full-bleed.** The mark is already a circle, so a circle crop looks like a gift and is a trap if the disc is inset. An inset disc puts its own antialiased edge just inside the crop's edge, and whatever sat behind it, white, transparent or otherwise, survives as a rim of that colour around the mark. Painting black to the corners means the crop cuts black against black, the corners are thrown away unseen, and the only edge in the result is the one Google antialiased itself.

## The mark, and why it looks like that

A black disc and one thin white circumference. The same mark as `public/favicon.svg` and `public/icon.svg`, because the app is a circle and nothing else.

The proportions are the favicon's, measured against its **disc** rather than its canvas: the favicon's disc is `r=15.5`, so the ring takes `11/15.5` of it at a stroke of `2.4/15.5`, which on a 256 radius is `r=181.7` and `stroke-width=39.6`. Measuring against the disc is the honest transfer here, since the crop makes the disc the entire image.

The favicon's own `r=11` and `stroke-width=2.4` do **not** carry over, and `AGENTS.md` says why: those two numbers were picked by rendering at 16px, to land both stroke edges on whole pixels and to stay white rather than antialiasing to grey. That is a 16px argument. At 40px, 64px and 250px it decides nothing, and the ratio is the only part of it that means anything.

`icon.svg`'s proportions do not carry over either, for a different reason. Its ring is inset to the middle 60% to clear a maskable safe zone, and a circle crop has no safe zone. Copied here it renders a small ring adrift in a large black field, which on a dark background loses the field and leaves a small ring adrift in nothing.

**Verified by looking at it**, circle-cropped at 40px, 64px and 250px, on white and on `#202124`:

- **40px**: the ring is three pixels of white across, peaking at a true 255 rather than the grey the favicon's note warns about. Clearly a ring at true size on both backgrounds. On dark the outer black rim merges with the list and the ring reads on its own, as described above.
- **64px**: five pixels across, comfortable, reads as the favicon does in a tab.
- **250px**: nineteen pixels across, the mark exactly as drawn.

No geometry adjustment was needed for the small size. If either number is ever changed, re-render and look at 40px again before believing it.

## Uploading it

1. Sign in as `noreply@send.circal.day` and go to `myaccount.google.com/personal-info`.
2. Click the profile picture, upload `avatar-512.png`, and leave Google's crop where it lands. There is nothing to frame: the image is a centred circle already.
3. On the same page, open **Profile picture** and set its visibility to **Anyone**.
4. Still on the same page, open **Contacts and other people** or **Profile discovery** and make sure discovery is on with the picture shown.

**Steps 3 and 4 are the ones people miss, and skipping them looks exactly like success.** With the picture private, everyone who has already interacted with the account, which is to say the owner and whoever tested the flow, sees the avatar, while a genuinely new recipient sees the grey silhouette. That is every real user, once, and it is the same shape of trap as the Confirm signup template in `../templates/README.md`: correct for the person checking, broken for everybody else.

Google also takes its time. A newly set avatar can be hours away from appearing in other people's inboxes, so a mail that arrives plain immediately after the upload is not evidence of anything. Check again the next day before changing settings.

## Regenerating the PNG

Edit `avatar.svg`, then:

```
rsvg-convert -w 512 -h 512 supabase/avatar/avatar.svg -o supabase/avatar/avatar-512.png
```

Same tool and same shape of command as the icons in `public/`, so the whole project's raster assets come from one pipeline. Then upload the new file: Google holds its own copy and nothing in this repo can push to it.
