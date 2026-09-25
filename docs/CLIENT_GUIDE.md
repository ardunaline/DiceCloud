# DiceCloud Client Guide — building bots & programmatic clients

This is the **how-to** for building automated clients (Discord bots, Minecraft
server plugins, scripts) against the DiceCloud instance at
**https://dice.ardun.me**. The complete endpoint/method reference lives in
[`docs/API.md`](./API.md) — read that for exact argument shapes. This file is
the practical walkthrough: auth setup, call patterns, error handling, and
worked examples you can adapt.

---

## 0. What you can build

- **Discord bot**: `!roll dex`, `!hp`, `!attack longsword` → results posted to
  a channel (either by your bot, or passively via the creature's built-in
  Discord webhook).
- **Minecraft plugin**: a command like `/dnd roll stealth` hitting the same
  REST API from Java.
- **Scripts**: bulk XP grants, HP sync, backups (`GET /api/creature/:id` is a
  full sheet snapshot).

## 1. Setup (do this once, as the bot's own user)

Create a **dedicated account** for the bot (register on the website) rather
than driving your personal account — sharing works per-creature, so you grant
the bot `writer` access on exactly the characters it should control.

```
1. POST /api/login  {"username": "my-bot", "password": "…"}   →  {token, id}
2. POST /api/method/users.generateApiKey    (Authorization: Bearer <token>)
3. Read the apiKey: it's shown in the web UI for the logged-in bot user
   (the `user` DDP publication exposes it to its owner). Store it.
```

The **apiKey never expires** and doesn't evict login tokens — use it as the
Bearer token for everything afterwards. If it leaks, regenerate it
(regenerating is a future feature; for now treat it like a password and keep
it in env vars / secrets, never in the repo).

### The bot's permissions

The bot can only touch characters it owns or was granted access to. Owner >
writer > reader. To let the bot control the party's characters: share each
character to the bot's account as **writer** (website: character → share
dialog; API: `sharing.updateUserSharePermissions`).

## 2. Call format

Every action is:

```
POST https://dice.ardun.me/api/method/<method name>
Authorization: Bearer <apiKey or login token>
Content-Type: application/json

<body = the method's argument object>
```

Response on success: `{"result": …}` (`result` is `null` when the method
doesn't return anything — that's normal; most *effects* show up in the log
or the sheet, not the return value).

Errors are `{"error": code, "reason": text, "details": …}` with meaningful
HTTP status: 400 validation, 403 permission, 404 unknown id/method, 429 rate
limited (`reason` contains the reset seconds — back off), 500 server bug.

```bash
# Example: roll a skill check with disadvantage
curl -s https://dice.ardun.me/api/method/creatureProperties.doCheck \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "propId": "k9EDQFvsyszTStugK",
    "scope": {"~checkAdvantage": {"value": -1}}
  }'
# → {"result": null}   — the RESULT lands in the log (next step)
```

## 3. The core loop

```text
login → GET /api/creatures (find ids) → GET /api/creature/:id (find property
ids + read variables) → POST /api/method/… (act) → GET /api/creature/:id/log
(read the result) → format it for your platform
```

**How to read results:** rolls don't return values; they append to the
creature log. `GET /api/creature/:id/log` returns the 20 newest entries
(newest first). Each entry has `content: [{name, value, inline}]` where
`value` is human-ready Markdown like `1d20 [ 14 ] +3 =  **17**`. Take entry
`[0]` after your call (or diff by `date`/`_id` to be safe against concurrent
rolls).

**How to find property ids:** `GET /api/creature/:id` → the `properties`
array. A skill check needs the `_id` of a document with `type: "skill"`;
an attack needs the `type: "action"` document with `attackRoll`; an HP pool
is the attribute whose `variableName` is `"hp"`.

**Latency note:** writes mark the sheet dirty and the engine recomputes
(~100 ms + compute time). After `damage`/`update`, poll `GET
/api/creature/:id` until the variable you care about moved (typically
< 1 s). Roll logs are written synchronously during the method call — by the
time the HTTP response returns, the log entry exists.

## 4. Worked example — Discord bot (Node.js, no framework assumptions)

```js
// dnd-bot.js — minimal DiceCloud Discord bridge
const BASE = 'https://dice.ardun.me';
const API_KEY = process.env.DICECLOUD_API_KEY;   // bot user's apiKey

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.reason || data.error || res.statusText);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data.result ?? data;
}

// Discover the creature + the skill id once, cache it
const creatures = await api('/api/creatures');
const creature = creatures.find(c => c.name === "KSO's Fighter");
const sheet = await api('/api/creature/' + creature._id);
const stealth = sheet.properties.find(
  p => p.type === 'skill' && p.name === 'Stealth');

// On "!stealth":
await api('/api/method/creatureProperties.doCheck', {
  method: 'POST',
  body: { propId: stealth._id, scope: { '~checkAdvantage': { value: 0 } } },
});
const [log] = await api(`/api/creature/${creature._id}/log`);
const line = log.content.map(f => f.value).filter(Boolean).join(' — ');
// → post "Dexterity save: 1d20 [ 14 ] +3 =  **17**" to Discord
```

Damage / healing:

```js
// hp attribute id from the sheet: properties.find(p => p.variableName === 'hp')
await api('/api/method/creatureProperties.damage', {
  method: 'POST',
  body: { _id: hpId, operation: 'increment', value: 5 }, // 5 damage
});
// heal: value: -5
```

Free-form dice (`/roll 2d6+3`):

```js
await api('/api/method/creatureLogs.methods.logForCreature', {
  method: 'POST',
  body: { creatureId: creature._id, roll: '2d6+3' },
});
```

## 5. Worked example — Minecraft plugin (Java 17+)

Java's built-in `java.net.http.HttpClient` is enough. Same endpoints:

```java
HttpClient http = HttpClient.newHttpClient();
String body = """
    {"propId": "%s", "scope": {"~checkAdvantage": {"value": 0}}}
    """.formatted(propId);

HttpRequest req = HttpRequest.newBuilder()
    .uri(URI.create("https://dice.ardun.me/api/method/creatureProperties.doCheck"))
    .header("Authorization", "Bearer " + apiKey)
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();

HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
// 200 → log entry exists; then GET /api/creature/{id}/log and format content[0]
```

Run the HTTP call **async** (`sendAsync` / off the main thread) — never block
the server tick on the network. Cache creature/property ids at plugin start
and refresh on demand; they never change for existing documents.

## 6. Rate limits & etiquette

- Bridge: 60 requests / 10 s per bot identity (counted per method domain).
- Per-method: e.g. rolls 10/5 s, log inserts 5/5 s, damage 20/5 s. 429
  responses tell you the reset time — honor it.
- Don't poll `/api/creature/:id` faster than ~1×/s; prefer the log endpoint
  after actions and full fetches on demand.
- One apiKey per bot, stored in env/secrets. A leaked key can read and write
  every character shared to the bot — scope the bot's shares accordingly.

## 7. Pitfalls the source will bite you on

- **Computed fields get stomped.** Write input fields (`baseValue.calculation`,
  `name`, `notes`…), never `value`/`modifier` — the engine recomputes them.
- **`order` is required** on `creatureProperties.insert`; the schema rejects
  inserts without it.
- **IDs are 17-char strings**, not ObjectIds. Don't generate them client-side
  except where the method asks for it (none do — let the server assign).
- **`path` arrays are field paths**: `["baseValue", "calculation"]` sets
  `baseValue.calculation`. `path[0]` can't be `type/order/parent/ancestors/
  damage` (update method refuses).
- **Advantage injection**: skill checks read `scope['~checkAdvantage'].value`
  (`-1`/`0`/`1`); attacks read `~attackAdvantage`. Values must be wrapped:
  `{"value": 1}`.
- **HP direction**: `damage` `increment` with a positive number deals damage;
  negative heals. `value` in the log shows remaining HP context via the engine.
- **Public creatures are public**: `sharing.setPublic` exposes the sheet to
  anonymous API readers. Default is private — leave it that way unless the
  user asks for a public sheet.
- **The Discord webhook fires from every log insert** — if a creature has
  `settings.discordWebhook` set, your bot's log entries will ALSO appear in
  Discord. Either account for the double-post or clear the webhook on bot-
  driven creatures.
- **Date fields**: send ISO strings; they arrive as `Date`s server-side.

## 8. Where the source lives (for deeper questions)

| Area | File |
|---|---|
| REST bridge (allowlist, limits) | `app/imports/server/rest/apiMethodBridge.js` |
| Auth (token + apiKey) | `app/imports/server/rest/middleware/authenticateUserByToken.js` |
| REST login | `app/imports/server/rest/restLogin.js` |
| REST reads (creature/log/list) | `app/imports/server/rest/apiPublications/` |
| Engine actions (rolls) | `app/imports/api/engine/actions/doCheck.js`, `doAction.js`, `doCastSpell.js` |
| Dice expression parser | `app/imports/parser/` (nearley grammar), `rollDice.js` |
| Log → Discord embed | `app/imports/api/creature/log/CreatureLogs.js` |
| Property schemas (fields per type) | `app/imports/api/properties/*.js` |
| Permission model | `app/imports/api/sharing/sharingPermissions.js` |
