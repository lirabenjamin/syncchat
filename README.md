# syncchat

syncchat pairs Qualtrics participants by rules you write in one YAML file and runs a live, timed one-on-one chat between them inside the survey.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lirabenjamin/syncchat)

## Setup compared with SMARTRIQS

SMARTRIQS is the standard tool for interactive Qualtrics studies. It is built for
multi-stage group games and is set up by pasting its JavaScript into Qualtrics
questions and entering its parameters as embedded data. syncchat does one thing,
attribute-based chat pairing, and generates every Qualtrics piece from your config.

| | SMARTRIQS | syncchat |
|---|---|---|
| JavaScript | copy its scripts into each interactive question; set its parameters as embedded data | none to edit; `npm run qualtrics` writes the question JavaScript with your fields, condition parameter, and app URL filled in |
| Qualtrics setup | build the survey flow and questions from its documentation | import one generated `.qsf` (embedded data, randomizer over your conditions, chat block) |
| Who is paired with whom | group size and roles | rules on participant answers, such as `differ: party` or `overlap: {field: top3, min: 1}` |
| Checking the logic before launch | run test sessions | `npm run explain` (plain English) and `npm run simulate` (matcher on fake arrivals) |
| Server | SMARTRIQS server (shared or self-hosted) | your own Render app (one click) or any Node host |

## Quickstart (about 15 minutes)

You need Node.js 20.12 or newer and a Qualtrics account that can import `.qsf` files.

1. **Install.** Clone this repo, then `npm install`.
2. **Write your rules.** Edit `study.yaml` (or start from a file in `examples/`). Run
   `npm run validate` until it prints `OK`.
3. **Read them back.** `npm run explain` prints your matching logic in plain English.
   If a sentence is not what you meant, fix the YAML.
4. **Simulate.** `npm run simulate study.yaml examples/people.csv` runs the real
   matcher on fake arrivals and prints who matched, why, how long they waited, and
   the match rate. Edit `people.csv` to look like your sample.
5. **Deploy.** Copy `.env.example` to `.env` and set `ADMIN_TOKEN`. Click "Deploy to
   Render" (or create a Render Web Service; `render.yaml` holds the settings) and set
   `ADMIN_TOKEN` and `MONGO_URI` in the dashboard. Render wipes its disk on restart,
   so use MongoDB there. Check `https://your-app.onrender.com/healthz`.
6. **Generate the Qualtrics files.** `npm run qualtrics -- --url https://your-app.onrender.com`
   writes `qualtrics/generated/`.
7. **Import.** In Qualtrics, create a project from `syncchat_template.qsf`, add your
   own questions before the chat block, and set each matching field from them. The
   generated `CHECKLIST.md` lists every embedded-data field and where its value comes
   from. To add the chat to an existing survey instead, paste `chat-question.html` and
   `chat-question.js` into a Text/Graphic question and follow the same checklist.
8. **Test.** Preview the survey in two browsers at once. Each preview gets its own
   ResponseID, so the two can match.

The Deploy button only works for repos Render can read. If this repo is private,
fork or copy it into your own account first.

## Writing matching rules

Declare each field Qualtrics passes in, with a type:

```yaml
participant:
  fields:
    party:  {type: category, values: [Democrat, Republican]}  # values optional; others are rejected
    gender: {type: category}
    top3:   {type: list, sep: ","}    # ?top3=pizza,tacos,sushi
    age:    {type: number}
```

A list field may also give `options: [...]` (and optionally `pick: N`) to set the
choices shown as chips on the `/demo` form. They do not restrict matching.

Then list rules under each condition. Every rule has the same shape:
`- rule: field` for the common case, or `- rule: {field: ..., other arguments}`.

```yaml
conditions:
  cross:
    require:                      # hard rules: all must hold
      - differ: party
      - overlap: {field: top3, min: 1}
    prefer:                       # soft rules: rank the valid partners
      - closest: age
    relax_after: 30s
    reveal: "You were matched because you both picked {shared.top3} in your top three."
```

### Cheat sheet

| Rule | Meaning | Example |
|---|---|---|
| `same` | both have the same value | `- same: party` |
| `differ` | both have a value and the values differ | `- differ: party` |
| `equals` | both have exactly this value | `- equals: {field: gender, value: Woman}` |
| `overlap` | lists share at least `min` items (default 1); under `prefer`, more shared ranks higher | `- overlap: {field: top3, min: 2}` |
| `within` | numbers differ by at most `max` | `- within: {field: age, max: 10}` |
| `closest` | `prefer` only: smaller gap ranks higher | `- closest: age` |
| `any_of` | at least one of the listed rules holds (OR) | `- any_of: [{same: party}, {overlap: top3}]` |
| `not` | the rule does not hold | `- not: {equals: {field: gender, value: Man}}` |
| `custom` | your own rule in a JavaScript file | `- custom: {file: ./rules/same_decade.js, field: age}` |

How the rules combine:

- People only match within their own **condition**, which Qualtrics sets in the
  embedded-data field named by `participant.condition_param` (`cond` by default).
- **`require`** rules are filters: all must hold. **`prefer`** rules rank the
  remaining partners. The first `prefer` rule decides and later ones break ties.
  Remaining ties go to whoever has waited longest.
- **Rules apply to every pair in a group.** With dyads (`group_size: 2`, the only size
  supported today) that is the one pair. The matcher already checks rules pairwise,
  so larger groups need only a group-forming step.
- **`relax_after`** (optional): once someone has waited this long, rules marked
  `relaxable: true` are dropped for pairs that include them, and they take the first
  valid partner instead of the best one. Write `relaxable: true` beside the rule or
  inside its arguments: `- within: {field: age, max: 10, relaxable: true}`.
- After `timing.match_timeout` with no partner, the person sees a "no partner" screen
  and gets the outcome `nomatch`.
- A missing field fails every rule that uses it. A duplicate participant ID cannot
  join twice.

### Explain, then simulate

Before you deploy, read your logic back and watch it run.
`npm run explain examples/advanced-rules.yaml` prints:

```
Condition "cross": partners must (1) have different party AND (2) either share at
least 1 item in top3 OR be in the same age decade (e.g. both in their 30s) AND (3) NOT
both have gender = Man. Among valid partners, rank by closest age; ties go to whoever
has waited longest. Participants see: "Your partner is a {partner.party}."
```

`npm run simulate examples/shared-top3.yaml examples/people.csv` replays the arrivals
in `people.csv` (one row per person, with an `arrival_s` column) through the same
matcher the server uses, in simulated time, and ends with a summary:

```
t=10s    MATCH    [shared] p12 + p14
           rules: overlap: top3 (shared: hiking, cooking); within: age
           p12 sees: "You were matched because you both picked hiking and cooking in your top three."
...
Summary
  condition        arrivals  matched  timed out  match rate
  shared                  5        4          1         80%
```

A low match rate in simulation means your rules are too strict for your sample.
Loosen a rule, mark it `relaxable`, or lengthen `match_timeout`.

### Adding a rule type

Every rule type is one entry in the `RULES` table in `src/rules.js`. A rule needs an
argument schema, a plain-English `describe`, and a `test` that checks one pair. Here
is the real entry for `within`:

```js
within: {
  args: { field: { field: ['number'] }, max: { number: true, min: 0 } },
  describe: ({ field, max }) => `have ${field} within ${max} of each other`,
  test: (a, b, { field, max }) => ({
    pass: known(a[field]) && known(b[field]) && Math.abs(a[field] - b[field]) <= max,
  }),
},
```

- `args`: the first key is the shorthand, so `same: party` means `same: {field: party}`.
  `{field: [types]}` must name a declared field of those types; `{number: true}`,
  `{integer: true}`, `min`, and `default` check numbers. The validator enforces these.
- `describe(args)` completes the sentence "partners must ..." in `npm run explain`.
- `test(a, b, args)` gets two participants' parsed fields and returns `{pass}`.
  It may add `score` (higher ranks first under `prefer`) and `shared` (items the pair
  has in common, used by `{shared.x}` in `reveal`).
- Optional: `rank(args)` describes the rule under `prefer`, and `preferOnly: true`
  stops it from being used under `require`.

To keep a rule in your study folder instead of editing syncchat, put the same shape in
a file and use `custom`. See [`examples/rules/same_decade.js`](examples/rules/same_decade.js):

```js
module.exports = {
  args: { field: { field: ['number'] } },
  describe: ({ field }) => `be in the same ${field} decade (e.g. both in their 30s)`,
  test: (a, b, { field }) => ({
    pass: a[field] != null && b[field] != null && Math.floor(a[field] / 10) === Math.floor(b[field] / 10),
  }),
};
```

The path is relative to the config file. At startup syncchat loads the file, checks
that it exports `describe` and `test`, checks its arguments against `args` (if
given), and calls `test` once on participants with every field missing, so a rule
that would crash on missing data fails at `npm run validate` instead of mid-study.

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
| [`examples/advanced-rules.yaml`](examples/advanced-rules.yaml) | `any_of`, `not`, and a `custom` rule file together |

Run one locally with `STUDY_CONFIG=examples/same-vs-cross.yaml npm start`, then open
two windows such as `http://localhost:3000/?id=a&cond=same&party=Democrat&age=30` and
`http://localhost:3000/?id=b&cond=same&party=Democrat&age=35`.

## Live demo without Qualtrics

`GET /demo` is a mobile-friendly form built from your config: category fields with
`values` become dropdowns, list fields with `options` become pick-N chips, numbers become
number inputs, and the condition becomes a dropdown when there is more than one. It
generates a random participant ID and opens the chat page top-level. The bare URL `/`
redirects to `/demo`.

`examples/demo.yaml` is tuned for showing syncchat live: pick three interests, get paired
with anyone who shares one, and see the shared items in the banner.

```bash
STUDY_CONFIG=examples/demo.yaml npm start   # then open http://localhost:3000/demo in two tabs or devices
```

On Render, set the environment variable `STUDY_CONFIG=examples/demo.yaml`. Free instances
sleep after about 15 minutes idle, so open the URL a minute before you demo.

## Qualtrics messages

The chat page talks to the generated question JavaScript with `postMessage`. The
snippet only accepts messages from your app URL, and the app only posts to origins in
`embed.allowed_origins`. The Next button stays hidden until the chat ends.

| Message | When | Embedded data saved |
|---|---|---|
| `chat_matched` | a partner is found | `chat_match_id`, `chat_partner_id`, `chat_match_reason`, `chat_reveal`, `chat_waited_ms` |
| `chat_ended` | timer ends, partner leaves, or join error | `chat_outcome`, `chat_message_count`, `chat_met_min_messages`, `chat_end_ts` |
| `nomatch` | no partner within `match_timeout` | same as `chat_ended`, with `chat_outcome = nomatch` |
| `chat_continue` | participant clicks Continue in the chat | (clicks Next) |

Use `chat_outcome` in Display or Branch Logic, for example to route `nomatch`
participants to a different block.

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
npm test                       # unit tests, command tests, and an end-to-end socket test
LIVE_URL=https://your-app.onrender.com node --test test/live.test.js   # optional smoke test of a deployed demo
npm run validate [config ...]  # check configs; lists every problem at once
npm run explain  [config ...]
npm run simulate [config] [people.csv]
npm run qualtrics -- [config] --url https://your-app.onrender.com [--out DIR]
```

`qualtrics/generated/` is gitignored: it depends on your app URL, so regenerate it
rather than committing it.
