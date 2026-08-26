# Labello

A Picolo-style drinking game that starts silly and does not stay that way.
Cards escalate over the course of a game: icebreakers and sips, then bolder
questions and hugs, then flirting, then kissing and clothing.

**Play:** https://samuellabenne.github.io/Labello/

The thing that makes it different from every other party-game app: **the host
matches people up before the game starts, and the deck respects it.** Anything
past a hug is only ever dealt to two people who were matched. Nobody gets a
kiss card with someone else's partner, and nobody gets one with a person they
are not into.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app. Single self-contained file, no build step. **Single source of truth.** |
| `database.rules.json` | Firebase Realtime Database security rules. Paste into the console (see below). |

There is deliberately no build step. Edit `index.html`, `git push`, and GitHub
Pages serves it. React, Babel, Firebase and the QR library all load from pinned
CDN URLs.

> **Keep those versions pinned.** An unpinned `@babel/standalone` is how the
> sister project (TimeLineTunes) once rendered a blank page: unpkg started
> serving Babel 8, whose React preset emits an ESM `import` into a classic
> script. The preset here is also explicitly registered with `runtime:
> "classic"` as a second line of defence.

## The deck

348 cards as `[type, heat, text, ruleDuration?]`.

**Types:** `nhie` (never have I ever), `truth`, `dare`, `phys` (contact),
`drink`, `vote`, `rule`, `game`, `group`.

**Heat** runs 1–5 and is what makes the night escalate:

| | Level | What lands |
|---|---|---|
| 1 | Warm-up | Icebreakers, easy sips, silly dares |
| 2 | Loosening up | Bolder questions, hugs, shoulder rubs, clothing swaps |
| 3 | Spicy | Flirty truths, first kisses between matches |
| 4 | Hot | Kissing, one item of clothing, real confessions |
| 5 | Filthy | Matched pairs only, mostly |

The host caps the level, so a group that wants to stop at 3 simply never sees
levels 4 and 5.

### Placeholders are the consent mechanism

Card text uses placeholders, and **the requirements are derived from them** —
there are no hand-maintained flags to get out of sync:

| Placeholder | Means | Card needs |
|---|---|---|
| `{p}` `{q}` `{r}` | distinct random players | 1 / 2 / 3 players |
| `{m}` `{n}` | **a matched pair** | at least one match |

`{m}`/`{n}` always resolve to a real matched couple. A card that cannot be cast
is never dealt — so with no matches set, every kissing and clothing card stays
in the box and the game tops out at hugs and dares. That behaviour is verified
by the invariant check described below.

Hugs, massages, piggybacks and slow dances use `{p}`/`{q}` and can land on
anyone. Kissing, laps, and removing someone else's clothing use `{m}`/`{n}`.

### Adding cards

Append to `DECK` in `index.html`. Order is not load-bearing — each game
pre-rolls its own `order` array of indices and stores that, so inserting,
reordering and appending are all safe *between* games. (A game already in
flight stores indices into the deck as it was when it started, so avoid
reordering mid-party.)

## How a game is dealt

The whole game is **pre-rolled when the host taps Start**: an `order` array of
card indices plus a `casts` array of player ids. Every phone reads the same
arrays out of the database, so nothing has to agree on randomness at play time.

`heatPlan()` slices the requested length across the allowed heat levels using
weights `[22, 22, 21, 19, 16]`, slightly front-loaded — the warm-up matters,
and the filthy end should feel earned rather than be a long plateau. Rounding
is reconciled against the *hottest* levels first, so shortening a game trims
the tail rather than the warm-up.

Card picking avoids repeating the type of either of the last two cards, so the
deck never serves four Never Have I Evers in a row.

**Rules are derived, never stored.** A `rule` card at position *j* with duration
*d* is live for cards *j+1 … j+d*, computed from `order` and `i`. That keeps the
synced state small and means a restart can never leave a stale rule hanging
around.

### The one setup that under-delivers

There are only 74 level-1 cards, so **Marathon (90) capped at level 1** deals 74
and stops. The lobby shows a warning when the requested length cannot be filled.
Every other combination of roster, length and cap has enough cards.

## Multiplayer

Firebase Realtime Database, one node per room at `rooms/{CODE}`:

- `rooms/{CODE}/state` — the whole game state, written as one object
- `rooms/{CODE}/presence/{playerId}` — who is currently connected

State is pushed over a websocket subscription, not polled. Joining uses a
**transaction**, so simultaneous joins cannot clobber each other. Advancing a
card uses a **compare-and-swap on the index the tapper actually saw**, so four
people tapping the same card only moves the game on by one.

Presence deliberately lives outside `/state`, because `/state` is overwritten on
every card and would otherwise wipe it.

Players are remembered per-room in `localStorage` under `lb:seat:{CODE}`, so
refreshing a phone rejoins the same seat instead of creating a duplicate — and
rejoining works even after the game has started, which is why the join
transaction aborting is not treated as an error.

**Single Phone mode uses none of this.** It runs entirely in React state, so the
app is fully playable with no Firebase at all.

## Firebase setup

### 1. Paste the config

Firebase console → **Project settings** → **General** → **Your apps** → the web
app → **SDK setup and configuration** → **Config**. Copy those values into
`LB_FIREBASE` near the top of `index.html`.

If you have not created a web app yet, click the **`</>`** icon on that page to
register one. You do **not** need Firebase Hosting — GitHub Pages serves the
site.

The config is **meant to be public**. It identifies the project; it does not
authorise anything. Access is controlled by the rules below plus anonymous
auth. (A *service account* key is a completely different thing and must never
go in this repo.)

Until it is pasted, the two online buttons on the home screen are disabled and
say so. Single Phone mode still works.

### 2. Create the Realtime Database

Console → **Build** → **Realtime Database** → **Create Database**.

Pick a region (`europe-west1` if you are in Europe) and start in **test mode** —
you are replacing the rules in step 4 anyway.

> Make sure it is **Realtime Database**, not **Cloud Firestore**. They are
> different products with different SDKs, and this app uses the former. The
> `databaseURL` in your config must be the `...firebasedatabase.app` one.

### 3. Turn on anonymous auth

Console → **Build** → **Authentication** → **Get started** → **Sign-in method**
→ **Anonymous** → enable → **Save**.

Without this, every write is rejected by the rules in step 4 and rooms silently
fail to create.

### 4. Publish the security rules

Test mode is open to the world and expires after 30 days. Replace it:

Console → **Realtime Database** → **Rules**, paste the contents of
`database.rules.json`, then **Publish**.

These rules require an authenticated (anonymous) session, block writes at the
`/rooms` root so nobody can wipe every room at once, and check the shape of what
gets written.

They intentionally let any signed-in client read or write *a room whose code it
knows*. The four-letter code is the only secret. That is proportionate for a
party game played in one room; it is not a security boundary, and nothing
sensitive is stored — only nicknames and card indices.

### 5. Authorised domains — not needed

Firebase's *Authorised domains* list gates OAuth popup and redirect sign-in. It
does **not** gate anonymous sign-in, which is all this app uses. Only add
`samuellabenne.github.io` if you later introduce Google or email sign-in.

## GitHub Pages

Repo → **Settings** → **Pages** → Source: **Deploy from a branch**, branch
`main`, folder `/ (root)`. First build takes a minute or two.

## Design notes

Warm blush paper, candy stickers, chunky pressable everything — deliberately
not the black-background look every other drinking game app uses.

Heat is communicated by **colour** rather than by a number: the card face runs
mint → sky → gold → coral → violet as the night escalates, so the table can feel
the game heating up without reading a label.

The card face uses a **white** sticker border. A translucent dark border over a
gradient reads as a second card peeking out from behind the first, which looked
like a rendering bug.

## Known gaps

- **No card history.** There is no way to go back and re-read the card you just
  passed.
- **Rooms are never deleted**, so the database accumulates finished games. They
  are tiny, but there is no TTL.
- **A player who leaves mid-game stays in the cast.** Cards will keep naming
  them. The host has to restart the game to drop someone.
- **One partner each.** The matcher deliberately does not support matching one
  person with several people, since avoiding exactly that is the point.
- Duplicate names are allowed and get confusing fast.
- No sound, no haptics, no timer for the cards that ask you to count.
