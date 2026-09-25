# DiceCloud API Reference (REST + DDP)

Instance: **https://dice.ardun.me** (hosted on Fly.io, app `dicecloud-ardun`)

This document describes every externally callable action on this DiceCloud
instance: the REST surface (hand-built + the `/api/method/*` bridge) and the
underlying DDP method surface it is built on. It is written for programmatic
clients — Discord bots, Minecraft plugins, scripts. For a walkthrough-style
guide with copy-paste examples, read `docs/CLIENT_GUIDE.md` alongside this.

> Source of truth: this file was generated from the app source at
> commit `4a91fe95`+ (repo `github.com/ardunaline/DiceCloud`, branch `master`).
> If a call behaves differently than documented, check the cited source file
> first, then update this doc.

---

## 1. Architecture in one paragraph

DiceCloud is a Meteor app. Its native RPC is **DDP** (JSON over websocket,
transport at `/sockjs/*`), where the client calls named **methods** and
subscribes to live **publications**. Every method is a `ValidatedMethod`:
it validates its arguments with a schema, checks permissions
(`assertEditPermission` / `assertViewPermission` / owner / admin), and applies
per-method rate limits. On top of that, this instance exposes a **REST
bridge** — `POST /api/method/<name>` — which dispatches to the *same* server
method handlers with your authenticated identity, so validation, permissions,
and rate limits behave identically to a websocket client. Reads of character
data are available as plain GET endpoints.

```
Your bot ──HTTPS──> /api/login ──> Bearer token or apiKey
        ──HTTPS──> POST /api/method/<name>     (writes & actions)
        ──HTTPS──> GET  /api/creatures         (discover characters)
        ──HTTPS──> GET  /api/creature/:id      (full sheet, computed values)
        ──HTTPS──> GET  /api/creature/:id/log  (roll results, recent first)
```

---

## 2. Authentication

Two credential types work as a Bearer token on every `/api/*` endpoint:

| Credential | How to get it | Expires | Best for |
|---|---|---|---|
| **Login token** | `POST /api/login` with username/email + password | ~90 days, and the pool is capped (`limitLoginTokens`) — each new login can evict old tokens | Interactive scripts |
| **API key** | Call method `users.generateApiKey` once (while authenticated), then read it from your user (it is also visible in the web app's account context) | Never (until regenerated) | **Bots / long-lived clients — recommended** |

Both are sent the same way:

```
Authorization: Bearer <token-or-apiKey>
```

- Missing auth is fine on endpoints that allow anonymous reads
  (`/api/status`, public creatures).
- An invalid token returns `403 {"error": "Permission denied", "reason":
  "Invalid authentication token"}`.

`POST /api/login`:

```
POST /api/login
Content-Type: application/json

{"username": "myuser", "password": "secret"}
   — or —
{"email": "me@example.com", "password": "secret"}
```

Response:

```json
{"id": "Kv7KirFDYTp6W34f6", "token": "<token>", "tokenExpires": "2026-12-24T00:00:00.000Z"}
```

Note: wrong username and wrong password return *different* errors on this
route (a legacy quirk). Treat any non-200 as "login failed"; don't branch on
the reason text.

---

## 3. Conventions

**IDs** are 17-character Meteor strings (regex `[23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz]{17}`). Creature IDs, property IDs, user IDs — all the same shape.

**Errors** are always JSON with the shape:

```json
{"error": "<short code>", "reason": "<human readable>", "details": <optional>}
```

HTTP status semantics on the bridge:

| Status | Meaning |
|---|---|
| 200 | Success, `result` holds the method's return value (may be `null`) |
| 400 | Schema validation failure or bad request shape (`error: "validation-error"` or method-specific codes) |
| 403 | Missing/invalid token, or the method's permission check refused you |
| 404 | Unknown resource *or* a method name not on the REST allowlist |
| 429 | Rate limited — `reason` includes `timeToReset` seconds for method limits |
| 500 | Server-side crash (method bug), not your fault; back off and retry once |

**Rate limits** (two layers):

1. Bridge-level: **60 requests / 10 s** per authenticated identity (or per IP
   when anonymous), counted per method domain (the part before the first `.`).
2. Per-method DDP limits — the exact limits each method enforces are listed
   in the catalog below. Exceeding them returns 429 with `reason` containing
   the reset time.

**CORS**: `Access-Control-Allow-Origin: *` — browser-based clients on any
origin can call the API. CORS preflight (`OPTIONS`) is answered on
`/api/login` and `/api/method/:name`.

**Dates** in responses are ISO-8601 strings. When *sending*, pass dates as
ISO strings (EJSON parses them back into `Date`s server-side).

---

## 4. Read endpoints (GET)

### `GET /api/status`
Public. `200 {"status": "ok"}` — proves the app and its DB connection are up.

### `GET /api/creatures`
**Requires auth.** Lists creatures you own, read, or write. Use this to
discover creature IDs.

Response: array of:
```json
{
  "_id": "czGQuMhdD2EqTvM4H",
  "name": "KSO's Fighter",
  "type": "pc",            // pc | npc | monster
  "public": false,
  "owner": "Kv7KirFDYTp6W34f6",
  "readers": [], "writers": [],
  "avatarPicture": "…",
  "denormalizedStats": {"xp": 0, "milestoneLevels": 0}
}
```

### `GET /api/creature/:id`
Public if the creature has `public: true`; otherwise requires Bearer token
with view permission (owner/reader/writer/admin).

Response: an object with the **creature document**, all its **properties**
(the entire sheet: attributes, skills, items, effects, actions…), the
computed **variables** (this is where final values live, e.g. `hp`,
`strength`, skill modifiers), plus the owner's username.

Key fields on the creature document:
`_id, name, type, owner, readers, writers, public, settings.discordWebhook,
denormalizedStats.xp, denormalizedStats.milestoneLevels, deathSave,
computeVersion, computeErrors`.

Key shapes inside properties and variables are described in §6.

### `GET /api/creature/:id/log`
Same permission rules as above. Returns the **20 most recent log entries**
(newest first). **This is where roll results land.**

```json
[
  {
    "_id": "LbYxPfdtmP3p8Jtijm",
    "creatureId": "czGQuMhdD2EqTvM4H",
    "creatureName": "KSO's Fighter",
    "date": "2026-09-25T18:00:00.000Z",
    "content": [
      {"name": "Dexterity save", "value": "1d20 [ 12 ] +3 =  **15**"},
      {"name": "To Hit", "value": "1d20 [ 18 ] +5\n**23**", "inline": true}
    ]
  }
]
```

`content[].value` is Markdown-ish text: dice rolls are shown as
`1d20 [ <rolled> ] <modifier> = **<total>**`, strikethrough marks dropped
dice on advantage/disadvantage, `**bold**` marks totals.

---

## 5. Write & action endpoints — `POST /api/method/<name>`

```
POST /api/method/<method name>
Authorization: Bearer <token-or-apiKey>
Content-Type: application/json

<the method's argument object>
```

The body is the method's **single argument object** (every method below takes
exactly one object; `{}` when it takes nothing). Response:

```json
{"result": <return value or null>}
```

Only the methods in §5.1–§5.9 are reachable over REST. Anything else →
`404 {"error": "not-found", …}`. Deliberately excluded: `admin.migrateTo`
(DB migrations), `icons.write` (admin raw inserts), `docs.*` (documentation
editing), `users.findUserByUsernameOrEmail` (enumeration oracle).

### 5.1 Creatures

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `creatures.insertCreature` | `{name: String, gender?: String, alignment?: String, startingLevel?: Int ≥ 0, allowedLibraries?: [id], allowedLibraryCollections?: [id]}` | new creature id | login | 5/5s |
| `creatures.update` | `{_id, path: [field, …], value}` — `path[0]` must be one of `name, alignment, gender, picture, avatarPicture, color, settings`; `value: null` unsets | — | edit creature | 5/5s |
| `creatures.changeAllowedLibraries` | `{_id, allowedLibraries?: [id], allowedLibraryCollections?: [id]}` | — | edit creature | 10/5s |
| `creatures.removeLibraryLimits` | `{_id, value: Boolean}` | — | edit creature | 10/5s |

### 5.2 Rolls & engine actions (the fun part)

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `creatureProperties.doCheck` | `{propId: id, scope: {"~checkAdvantage": {"value": -1\|0\|1}}}` — propId is a **skill** or **attribute(ability)** property id. Writes a log entry with the roll | — | edit creature | 10/5s |
| `creatureProperties.doAction` | `{actionId: id, targetIds?: [id] (≤20), scope?: object}` — runs the action: attack rolls, damage, resource spending, child properties, triggers. Writes a log entry | — | edit creature + all targets | 10/5s |
| `creatureProperties.doCastSpell` | `{spellId: id, slotId?: id, ritual?: Boolean, targetIds?: [id], scope?: object}` — spends the slot (unless cantrip/ritual), runs the spell's children | — | edit creature + targets | 10/5s |
| `creatureLogs.methods.logForCreature` | `{roll: String, creatureId: id}` — evaluates a dice expression server-side (same parser as the chat box, e.g. `"1d20+5"`, `"2d6+3 [fire]"`) and writes the result to the log | new log id | edit creature | 5/5s |
| `creatureLogs.methods.insert` | `{log: {content: [{name?: String, value?: String, inline?: Boolean}], creatureId: id}}` — writes a raw log entry (also fires the creature's Discord webhook) | new log id | edit creature | 5/5s |

The scope object is how you inject temporary values; the check flow uses
`~checkAdvantage`. Engine actions accept `~attackAdvantage` similarly.
Values are `{value: <any>}` objects.

### 5.3 Creature properties (the sheet's building blocks)

Properties form a tree under the creature: `ancestors: [{id, collection}…]`
with `ancestors[0].id` always the creature id. Property types include:
`attribute, skill, effect, action, spell, item, container, damageMultiplier,
toggle, branch, note, folder, propertySlot, buff, roll, savingThrow, class,
feature, reference, spellList, slotFiller`.

Computed fields (anything the engine writes: `value`, `modifier`, `proficiency`,
`description.value`…) are **recomputed** — write only input fields
(`baseValue.calculation`, `notes`, `equipped`…). Writes mark the property
`dirty` and the engine recomputes within ~100 ms + the time the compute takes.

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `creatureProperties.insert` | `{creatureProperty: {type: String, name?: String, order: Number, …type-specific fields}, parentRef: {id, collection: "creatures"\|"creatureProperties"}}` | new property id | edit creature | 5/5s |
| `creatureProperties.insertAsChildOfTag` | `{creatureProperty: {…}, creatureId: id, tag: String (≤20ch), tagDefaultName?: String}` — inserts under the first folder with that tag (creates it if missing) | new property id | edit creature | 5/5s |
| `creatureProperties.insertPropertyFromLibraryNode` | `{nodeIds: [id] (≤20), parentRef: Ref, order?: Number}` — copies library content onto the creature (how rulesets/spells/items get installed) | — | edit creature | 5/5s |
| `creatureProperties.update` | `{_id: id, path: [String, …], value: any}` — sets `path.join('.')` to value; `null` unsets. `path[0]` may **not** be `type, order, parent, ancestors, damage` | — | edit creature | 5/5s |
| `creatureProperties.duplicate` | `{_id: id}` — deep-copies the property (+≤50 children) with a fresh id and `variableName + "Copy"` | — | edit creature | 5/5s |
| `creatureProperties.softRemove` | `{_id: id}` | — | edit creature | 5/5s |
| `creatureProperties.restore` | `{_id: id}` | — | edit creature | 5/5s |
| `creatureProperties.flipToggle` | `{_id: id}` — toggle only; computed toggles can't be flipped | — | edit creature | 5/5s |
| `creatureProperties.equip` | `{_id: id, equipped: Boolean}` — items only; also re-parents to Equipment/Carried folders | — | edit creature | 5/5s |
| `creatureProperties.damage` | `{_id: id, operation: "set"\|"increment", value: Number}` — HP/damage-bearing attributes & items. For HP, increment with a positive number *deals* damage. Fires `change` triggers and writes a log | damage result | edit creature | 20/5s |
| `creatureProperties.adjustQuantity` | `{_id: id, operation: "set"\|"increment", value: Number}` — quantity-bearing props (items/ammo). For increment, a positive value *consumes* | — | edit creature | 5/5s |
| `creatureProperties.push` | `{_id: id, path: [String, …], value: any}` — push into an array field (respects schema maxCount) | — | edit creature | 5/5s |
| `creatureProperties.pull` | `{_id: id, path: [String, …], itemId: id}` — remove an array element by its `_id` | — | edit creature | 5/5s |
| `creatureProperties.selectAmmoItem` | `{actionId: id, itemId: id, itemConsumedIndex: Number}` — link ammo to an action's consumed-item slot | — | edit creature | 5/5s |
| `creatureProperties.copyPropertyToLibrary` | `{propId: id, parentRef: {id, collection: "libraries"\|"libraryNodes"}, order?: Number}` | — | edit creature + edit library | 1/5s |

Minimal property insert that works (a skill):

```json
POST /api/method/creatureProperties.insert
{
  "creatureProperty": {"type": "skill", "name": "History", "skillType": "check", "order": 5},
  "parentRef": {"id": "<creatureId>", "collection": "creatures"}
}
```

`order` is **required**. Re-use `insertAsChildOfTag` with tag `"inventory"`
etc. to avoid managing folders manually.

### 5.4 Creature folders

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `creatureFolders.methods.insert` | `{}` | new folder id (≤50 per user) | login | 5/5s |
| `creatureFolders.methods.updateName` | `{_id, name}` | — | own folder | 5/5s |
| `creatureFolders.methods.reorder` | `{_id, order: Number}` | — | own folder | 5/5s |
| `creatureFolders.methods.remove` | `{_id}` | — | own folder | 5/5s |
| `creatureFolders.methods.moveCreatureToFolder` | `{creatureId, folderId?}` — omit folderId to unfile | — | own folder | 5/5s |

### 5.5 Experience

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `experiences.insert` | `{experience: {name?: String, xp?: Int ≥ 0, levels?: Int ≥ 0}, creatureIds: [id] (≤12)}` | array of new experience ids | edit each creature | 5/5s |
| `experiences.remove` | `{experienceId: id}` — reverses the XP/levels it granted | removed count | edit creature | 5/5s |
| `experiences.recompute` | `{creatureId: id}` — rebuilds XP totals from the experience list | — | edit creature | 5/5s |

### 5.6 Tabletops & chat

Tabletop creation/management requires the **admin** role on this instance
(the upstream Patreon gate is disabled, admin gate is not). Sending chat
messages requires tabletop membership.

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `tabletops.insert` | `{}` | tabletop id | **admin** | 5/5s |
| `tabletops.addCreatures` | `{tabletopId, creatureIds: [id]}` — only adds creatures you own/write | — | member + **admin** | 10/5s |
| `tabletops.remove` | `{tabletopId}` | removed count | owner + **admin** | 5/5s |
| `messages.send` | `{tabletopId, content: String (≤1000)}` | message id | member | 10/5s |
| `messages.remove` | `{messageId}` | — | logged in (owner checks upstream) | 5/5s |

### 5.7 Sharing

`docRef` = `{id, collection: "creatures" | "libraries" | "libraryNodes" | "libraryCollections"}`.

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `sharing.setPublic` | `{docRef, isPublic: Boolean}` — **makes the doc readable by the whole internet** | — | owner | 5/5s |
| `sharing.setReadersCanCopy` | `{docRef, readersCanCopy: Boolean}` | — | owner | 5/5s |
| `sharing.updateUserSharePermissions` | `{docRef, userId, role: "reader"\|"writer"\|"none"}` — "none" removes; you can remove yourself | — | owner (or self-removal) | 5/5s |
| `sharing.transferOwnership` | `{docRef, userId}` — subject to the target's character-slot tier | — | owner | 5/5s |

### 5.8 Libraries

Libraries are user-owned trees of `libraryNodes` (the content system:
rulesets, monsters, spells…). `showInMarket: true` + `public: true` puts a
library in the public browser. All are permission-checked (library edit
permission) and rate limited 1–10 per 5s:

`libraries.insert` `{name: String, …}` · `libraries.updateName`
`{libraryId, name}` · `libraries.updateDescription` `{libraryId, description}`
· `libraries.updateShowInMarket` `{libraryId, showInMarket: Boolean}` ·
`libraries.remove` `{libraryId}` · `libraryNodes.insert/update/push/pull/
softRemove/restore` (same shapes as their creatureProperties cousins, with
library refs) · `libraryCollections.insert/update/remove` ·
`users.subscribeToLibrary` `{libraryId, subscribe: Boolean}` ·
`users.subscribeToLibraryCollection` `{libraryCollectionId, subscribe: Boolean}` ·
`organize.organizeDoc` `{docRef, parentRef, order?, skipRecompute?}` ·
`organize.reorderDoc` `{docRef, order}` · `icons.find`
`{search: String (≤30)}` → matching icon docs (public).

### 5.9 Users & invites

| Method | Args | Result | Permission | Limit |
|---|---|---|---|---|
| `users.generateApiKey` | `{}` — no-op if a key already exists | — | login (generates *your* key) | 5/5s |
| `users.setUsername` | `{username: String}` — first change / name-pick flow | — | login | 5/5s |
| `users.canPickUsername` | `{username: String}` | availability | login | 5/5s |
| `users.setDarkMode` | `{darkMode: Boolean}` | — | login | 5/5s |
| `users.setPreference` | `{key: String, value: any}` | — | login | 5/5s |
| `users.sendVerificationEmail` | `{address: String}` — must be an address **on your own account** | — | login | 5/5s |
| `invites.getToken` | `{inviteId: id}` — 5-char invite code | token | own invite | 5/5s |
| `invites.acceptToken` | `{inviteToken: String}` — consumes an invite | — | login, not own invite | 5/5s |
| `invites.revokeInvite` | `{inviteId: id}` | — | own invite | 5/5s |

---

## 6. How DiceCloud models things (read this before writing to the sheet)

**Tree structure.** Everything on a character is a `creatureProperty` document
in one flat collection, organized by an `ancestors` array:
`[{id: <creatureId>, collection: "creatures"}, {id: <folderId>, …}, …]`.
`ancestors[0]` is always the creature. Re-parenting is done by the
specialized methods (`equip`, `organize.organizeDoc`), never by editing
`ancestors` directly.

**Computed values live in `variables`.** The compute engine turns property
definitions into a `creatureVariables` document — one entry per
`variableName` (`hp`, `strength`, `ac`, custom names…). `GET
/api/creature/:id` gives you these. **Read computed state from variables;
write intent via property input fields.** If you overwrite a computed field
(`value`, `modifier`…) the engine will stomp it on the next compute.

**The dirty/compute cycle.** Writes set `dirty: true` on affected docs; ~100ms
later (debounced) the server recomputes the whole creature synchronously and
writes new values. Consequences for bots: (a) after a write, wait a beat
(poll the log or re-fetch the creature) before asserting on computed values;
(b) the first subscription/fetch after a *deploy* may trigger one full
recompute (the `computeVersion` mechanism) — this is normal and now bounded.

**HP & damage.** `hp` is an attribute whose `value` = total minus `damage`.
Damage is applied with `creatureProperties.damage` `{operation: "increment",
value: <damage>}`; negative values heal; `"set"` sets the damage value
directly. Damage (and heals) fire triggers and land in the log.

**Rolls.** The dice engine parses expressions like `1d20 + 5`, `2d6 [fire] +
1d4 [magic]`, `max(2, 1d8)` — same syntax as the app's chat box
(`creatureLogs.methods.logForCreature` is your free-form roller). Structured
rolls (skill checks, attacks) are engine actions (`doCheck`, `doAction`,
`doCastSpell`) that assemble their own log entries.

**The log.** Every action writes one `creatureLogs` document with a
`content` array of `{name, value, inline}` fields. Bots should fetch
`GET /api/creature/:id/log` and format `content` — that's exactly what the
web UI and the Discord webhook show. Note the Discord webhook is per-creature
(`settings.discordWebhook`) and fires server-side on every log insert.

**Sharing & visibility.** `owner` > `writers` > `readers` > `public`. Admins
(people with `roles: ["admin"]`) bypass checks. `public: true` makes a
creature/library readable by anyone — including anonymously over the REST
API — so flip it deliberately.

**Soft removal.** Deletes are soft (`removed: true`, restorable) — the
`softRemove`/`restore` methods. Hard deletes don't exist for properties.

**Discord webhook format.** Log content is converted to an embed: each
`content` entry becomes an embed field (`name` → field name, `value` → field
value, ≤25 fields, ≤1024 chars per value), posted as the creature's
name/avatar with mentions stripped. See
`app/imports/api/creature/log/CreatureLogs.js` and
`app/imports/server/discord/sendWebhook.js`.

---

## 7. DDP publications (live subscriptions)

If a client wants push updates instead of polling, speak DDP
(`wss://dice.ardun.me/sockjs/websocket`, SockJS framing, then DDP `sub`):
the app exposes these publications — all permission-checked:

| Publication | Params | Content |
|---|---|---|
| `singleCharacter` | creatureId | creature + properties + variables + last 20 logs + owner username |
| `characterList` | — | your creatures & folders |
| `browseLibraries` | — | public libraries in the market (login required) |
| `library` / `libraryNodes` / `libraryCollections` | ids | library content (public libs readable anonymously) |
| `experiences` | creatureId | creature's experience entries |
| `user` | — | your own user doc (roles, apiKey, preferences) |
| `userPublicProfiles` | [ids] | usernames for given ids (login required) |
| `icons` | — | icon library |
| `tabletops` / `messages`? | — | tabletops you're in; messages per tabletop |
| `slotFillers` | slot | library content that can fill a slot |
| `ownedDocuments` | collection | docs you own |
| `searchLibraryNodes` | term | text search over library nodes |
| `archiveFiles` / `userImages` | — | file listings for the Files page |
| `docs` | — | documentation content |

All subscriptions are rate limited to 50 subs / 10 s per connection.
`mixmax:smart-disconnect` disconnects idle hidden tabs — bots should just use
REST instead of holding a websocket open.

---

## 8. Quick reference — the bot loop

```
1. POST /api/login                      → {token}            (once, or)
   POST /api/method/users.generateApiKey → apiKey            (once)
2. GET  /api/creatures                  → find creatureId
3. GET  /api/creature/:id               → find skill/action/attribute ids,
                                          read variables (hp, modifiers)
4. POST /api/method/creatureProperties.doCheck
   POST /api/method/creatureProperties.doAction
   POST /api/method/creatureLogs.methods.logForCreature {"roll": "1d20+3", …}
5. GET  /api/creature/:id/log           → format content[] for your channel
```
