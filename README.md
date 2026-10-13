# syncchat

Live one-on-one chat between two study participants, embedded in a Qualtrics
survey. You describe who should be paired with whom in one file, `study.yaml`.
The server pairs people as they arrive, tells both people why they were matched
(optional), runs a timed chat, and stores every arrival, match, message, and
outcome.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lirabenjamin/syncchat)

## Quickstart

1. **Download.** Clone or download this repo. You need Node.js 20.12 or newer.
2. **Configure secrets.** Copy `.env.example` to `.env`. Set `ADMIN_TOKEN` to a long
   random string. Set `MONGO_URI` if you have a MongoDB database; otherwise data is
   written to `./data/` as JSONL files.
3. **Edit `study.yaml`.** Declare the fields passed by Qualtrics, your conditions, and
   your matching rules (see below). Check it with `npm run validate`.
4. **Try it locally.** `npm install && npm start`, then open two browser windows:
   `http://localhost:3000/?id=a&cond=cross&party=Democrat&top3=pizza,tacos&age=30` and
   `http://localhost:3000/?id=b&cond=cross&party=Republican&top3=tacos&age=35`.
5. **Deploy.** Click "Deploy to Render" (or create a Render Web Service from your copy
   of the repo; `render.yaml` holds the settings). Set `MONGO_URI` in the Render
   dashboard. Render's disk is wiped on every restart, so JSONL storage loses data there.
6. **Embed.** Follow [`qualtrics/README.md`](qualtrics/README.md): paste
   `qualtrics/chat-question.js` into a Qualtrics question and set your app URL.

The Deploy button only works for repos Render can read. If this repo is private,
fork or copy it into your own account first.

## Matching logic

- Participants only match within their own **condition**, which Qualtrics passes
  in the URL (`cond=cross`). With one condition, the parameter is optional.
- When someone arrives, the server checks everyone waiting in that condition.
  **`require`** rules are hard filters: all must hold. **`prefer`** rules rank the
  remaining candidates. Ties go to whoever has waited longest.
- Someone who finds no valid partner waits. Each new arrival is checked against them.
- **`relax_after`** (optional): once a person has waited this long, require rules
  marked `relaxable: true` are dropped for any pair that includes them, and they
  ignore `prefer` and take the first valid partner.
- After `timing.match_timeout` with no partner, the person gets a "no partner" screen
  and the outcome `nomatch`.
- A participant ID that is already waiting or chatting cannot join a second time.
- If a field is missing from the URL, every rule that uses it fails for that person.

## Writing matching rules

Declare each field under `participant.fields` with a type:

```yaml
participant:
  fields:
    party:  {type: category, values: [Democrat, Republican]}  # values optional; others are rejected
    gender: {type: category}
    top3:   {type: list, sep: ","}    # ?top3=pizza,tacos,sushi
    age:    {type: number}
```

Each rule is one line under `require` or `prefer`:

| Rule | Field types | Holds when | Example |
|---|---|---|---|
| `same: f` | category, number | both have the same value | `- same: party` |
| `differ: f` | category, number | both have a value and they differ | `- differ: party` |
| `equals: {field, value}` | category, number | both have exactly `value` | `- equals: {field: gender, value: Woman}` |
| `overlap: {field, min}` | list | they share at least `min` items (default 1) | `- overlap: {field: top3, min: 2}` |
| `within: {field, max}` | number | values differ by at most `max` | `- within: {field: age, max: 10}` |
| `closest: f` | number | `prefer` only: smaller gap ranks higher | `- closest: age` |

Under `prefer`, `overlap` ranks by the number of shared items, `closest` by the
smallest gap, and the other rules rank pairs that satisfy them above pairs that do
not. When you list several `prefer` rules, the first one decides and later ones only
break ties.

Mark a hard rule as relaxable either way:

```yaml
require:
  - within: {field: age, max: 10, relaxable: true}
```

### Match explanations (`reveal`)

`reveal` is a sentence shown to both people as a banner when the chat starts, or
`false` for no banner. The text shown to each person is stored with the match.

| Placeholder | Becomes |
|---|---|
| `{shared.top3}` | the items listed by both people, e.g. "pizza and sushi" |
| `{partner.party}` | the partner's value |
| `{me.age}` | the viewer's own value |

If a rule involving `{shared.x}` is relaxable, the shared list can be empty after
relaxing, so write the sentence to survive that, or keep that rule strict.

### Other settings

| Setting | Default | Meaning |
|---|---|---|
| `timing.match_timeout` | required | how long to wait for a partner (`60s`, `2m`, `500ms`) |
| `timing.chat_duration` | required | length of the chat |
| `timing.min_messages` | 0 | recorded as `met_min_messages` per person; it does not end the chat early |
| `chat.intro` | none | a line shown at the top of every chat, e.g. the topic; placeholders allowed |
| `on_timeout` | `nomatch` | only `nomatch` in v1; a `bot` fallback partner is planned |
| `embed.allowed_origins` | required | sites allowed to embed the chat and receive its messages |
| `embed.redirect_url` | null | if the chat is opened directly (not in an iframe), Continue goes here; `{id}` and `{outcome}` are filled in |
| `embed.send_transcript_to_parent` | false | also send the transcript to Qualtrics as `chat_transcript` |
| `limits.max_message_length` | 500 | characters per message |
| `limits.messages_per_10s` | 10 | per participant |
| `limits.joins_per_ip_per_minute` | 60 | keep this high for labs where participants share one network |

The validator rejects unknown keys, unknown fields, wrong field types, and bad
durations, and lists every problem at once.

### Example configs

| File | Design |
|---|---|
| [`examples/cross-party.yaml`](examples/cross-party.yaml) | every Democrat chats with a Republican, with a topic intro |
| [`examples/shared-top3.yaml`](examples/shared-top3.yaml) | pair people who share a top-3 choice, prefer more overlap and similar age, reveal the shared items |
| [`examples/same-vs-cross.yaml`](examples/same-vs-cross.yaml) | Qualtrics randomizes `same` vs `cross` party pairing |

Run one with `STUDY_CONFIG=examples/same-vs-cross.yaml npm start`.

## Data

Each record carries `study_id`. With `MONGO_URI`, records go to four collections;
otherwise to four files in `./data/`.

| Record | Contents |
|---|---|
| `arrivals` | participant ID, condition, parsed fields, arrival time |
| `matches` | match ID, both IDs (earlier arrival first), condition, rules satisfied, rules waived by relaxing, `prefer` rules used and their scores, reveal text per person, wait time per person |
| `messages` | match ID, sender ID, sequence number, text, time |
| `outcomes` | one per person: `completed`, `partner_left`, `left`, `nomatch`, or `left_waiting`, plus message count and `met_min_messages` |

Download everything with `GET /export?token=ADMIN_TOKEN` (JSON), or one table as CSV
with `/export?token=ADMIN_TOKEN&format=csv&table=messages`. Merge with Qualtrics on
the participant ID (ResponseID) or `chat_match_id`.

## Privacy, security, and IRB notes

- Participants see no IDs. Their screen only shows the reveal text and messages.
- Anything you put in `reveal` or `chat.intro` with `{partner.x}` discloses that
  attribute to the partner. List this in your consent form.
- Chat text is free text and can contain identifying information. Treat transcripts
  as identifiable data until reviewed.
- The server never prints transcripts or participant IDs to its logs.
- Only sites in `embed.allowed_origins` can frame the page, open a chat connection
  from a browser, or receive its messages. `/export` needs `ADMIN_TOKEN`.
- Keep `.env` out of version control (it is in `.gitignore`).
- Matching state lives in memory. Run a single instance, and avoid redeploying while
  a session is live: a restart ends all active chats.
- If a participant's connection drops mid-chat, the chat ends for both people
  (`left` / `partner_left`).

## Development

```bash
npm install
npm test          # unit tests + an end-to-end socket test
npm run validate  # check study.yaml (or pass file paths)
```

Rule primitives live in `src/rules.js`. A new primitive is one entry there: the
field types it accepts, how to parse its argument, and a check (or score) function.
