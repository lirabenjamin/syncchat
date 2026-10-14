# syncchat

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23372978.svg)](https://doi.org/10.5281/zenodo.23372978)

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

The **Setup** tab of the live demo, <https://syncchat-demo.onrender.com/#setup>, walks
through these steps in more detail, with accounts, costs, and every setting.

You need Node.js 20.12 or newer, a GitHub account, a Render account (about $7/month on
the Starter plan while collecting data; free instances sleep and restarts end live chats),
a free MongoDB Atlas database, and a Qualtrics account that can import `.qsf` files.
No AI or LLM API keys are needed.

1. **Install.** Fork <https://github.com/lirabenjamin/syncchat> (or download the ZIP
   and push it to a new repository), clone your copy, then `npm install`.
2. **Write your rules.** Edit `study.yaml` (or start from a file in `examples/`). Run
   `npm run validate` until it prints `OK`.
3. **Read them back.** `npm run explain` prints your matching logic in plain English.
   If a sentence is not what you meant, fix the YAML.
4. **Simulate.** `npm run simulate study.yaml examples/people.csv` runs the real
   matcher on fake arrivals and prints who matched, why, how long they waited, and
   the match rate. Edit `people.csv` to look like your sample.
5. **Deploy.** In MongoDB Atlas, create a free cluster, a database user, and network
   access from `0.0.0.0/0`; copy the connection string from Connect > Drivers and add a
   database name (`.../syncchat?...`). That is `MONGO_URI`. In Render, create a
   Blueprint from your repo (`render.yaml` holds the settings and generates
   `ADMIN_TOKEN`) or click "Deploy to Render", and set `MONGO_URI`. Render wipes its
   disk on restart, so use MongoDB there. Check `https://your-app.onrender.com/healthz`
   shows `"storage":"mongo"`.
6. **Generate the Qualtrics files.** `npm run qualtrics -- --url https://your-app.onrender.com`
   writes `qualtrics/generated/`. The chat URL always includes `study=<study.id>`;
   a single-study server ignores it, so the same files keep working if you later host
   several studies on one server.
7. **Import.** In Qualtrics, create a project from `syncchat_template.qsf`, add your
   own questions before the chat block, and set each matching field from them. The
   generated `CHECKLIST.md` lists every embedded-data field and where its value comes
   from. To add the chat to an existing survey instead, paste `chat-question.html` and
   `chat-question.js` into a Text/Graphic question and follow the same checklist.
8. **Test.** Preview the survey in two browsers at once. Each preview gets its own
   ResponseID, so the two can match.

The Deploy button deploys this public repo as is. To use your own rules, fork it first
and deploy your fork.

## Writing matching rules

The flow: Qualtrics survey → embedded data → chat iframe URL → syncchat matches by your
rules → chat → outcome, match reason, and partner ID back to Qualtrics as embedded data.

Everything syncchat matches on arrives in the iframe URL, which the generated Qualtrics
snippet builds from embedded data, for example `?id=R_abc123&cond=cross&party=Democrat`:

- `id` is the Qualtrics ResponseID.
- `cond` is the condition, set by a randomizer in the survey flow (`participant.condition_param`).
- every other parameter is a field from `participant.fields`, which you collect in the
  survey (or get from a panel) and store as embedded data under the same name.

The gallery page (`/` in multi-study mode) has three tabs: **Examples** (each card shows
the exact URL Qualtrics sends), **Configuration** (an annotated `study.yaml` with a numbered
note on each block, field types, rules, and defaults), and **Setup** (the step-by-step guide).

Declare each field Qualtrics passes in, with a type:

```yaml
participant:
  fields:
    party:  {type: category, values: [Democrat, Republican]}  # values optional; others are rejected
    gender: {type: category}
    top3:   {type: list, sep: ","}    # ?top3=pizza,tacos,sushi
    age:    {type: number}
```

Any field may give a `label:` (the question text on the `/demo` form). A list field may
also give `options: [...]` (and optionally `pick: N`) to set the chips on the form, and a
number field `min:` / `max:`. These only shape the `/demo` form and do not restrict
matching. A condition may give a `label:` for the form's condition dropdown, and the
config may give a top-level `title:` and one-sentence `description:` (shown on the form
and in the gallery).

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
| `timing.chat_duration` | required | length of the chat, or `none` for no time limit (elapsed timer and a Done button) |
| `timing.end_when` | `timer` (`both_done` if untimed) | `timer`, `both_done` (both click Done), or `either_done` |
| `timing.min_messages` | 0 | messages each person must send; with Done, enforced by the server; with `timer`, recorded as `met_min_messages` |
| `timing.max_duration` | 60m | safety cap on an untimed chat |
| `timing.extend_until_min` | 0 | timed chats: run up to this much longer until both have sent `min_messages` |
| `timing.rejoin_timeout` | 3m | chats with stages: how long a returning or reconnecting partner is waited for |
| `conditions.<name>.timing` | none | any `timing` key for this condition; overrides the global value |
| `stages` / `conditions.<name>.stages` | none | several rounds with the same partner (below) |
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

### Timing and stages

Global `timing` applies to every condition; a condition's `timing` overrides it, and a
stage overrides both. Settings that can never apply (e.g. `max_duration` on a timed chat)
are rejected.

```yaml
conditions:
  short:
    timing: {chat_duration: 2m}      # this condition only
  open:
    timing:
      chat_duration: none            # no clock: elapsed timer + Done button
      end_when: both_done            # default when untimed; the first to click sees
                                     # "Waiting for your partner to finish"; or either_done
      min_messages: 3                # Done is rejected (server-side) until you have sent 3;
                                     # the button reads "2 of 3 messages sent"
      max_duration: 20m              # safety cap (default 60m)
  staged:
    reveal: "Your partner is a {partner.party}."   # stage 1 only, unless a stage sets reveal
    stages:                          # or top-level `stages:`, inherited by every condition
      - id: intro                    # letters, numbers, _; stored on messages and records
        prompt: "Get to know each other."          # banner for this stage
        chat_duration: 3m            # stage keys: chat_duration, min_messages, end_when,
                                     # max_duration, extend_until_min
        then: qualtrics              # continue (default): same window, after a divider
                                     # qualtrics: survey moves on; rejoin with stage=discuss
      - id: discuss                  # the last stage has no `then`
        prompt: "Discuss the topic."
        chat_duration: none
        min_messages: 2

timing:
  match_timeout: 120s
  chat_duration: 5m
  extend_until_min: 0                # timed chats: extend until both reach min_messages
  rejoin_timeout: 3m                 # wait this long for a returning partner, then partner_left
```

With `then: qualtrics`, the chat posts `stage_ended` to Qualtrics, which moves to your
between-stage questions. The next chat block's question sends `stage=<id>` with the same
participant ID and rejoins the same partner (the pair stays reserved). Whoever arrives
first waits up to `rejoin_timeout`; if the other never comes, the chat ends with
`partner_left` (and `no_rejoin` for the absent one). A reload or dropped connection
mid-stage reconnects to the same chat with its transcript. `npm run qualtrics` writes one
chat question per Qualtrics stage (`chat-question-2.js`, ...) and a template with one chat
block per stage separated by a placeholder question; later chat questions skip themselves
if the chat already ended. Outside Qualtrics (`/demo`), a `qualtrics` stage shows "In your
study, your Qualtrics survey would show here" and a button that rejoins the same partner.

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

### Several studies on one server (examples gallery)

Point `STUDY_CONFIG` (or `STUDY_DIR`) at a folder and the server hosts every `*.yaml` in
it. Each study keeps its own waiting room and data (records carry its `study_id`), and the
URL parameter `study=<study.id>` picks one: `/demo?study=combo`, `/?study=combo&id=...`,
`/export?token=...&study=combo`. Study ids must be unique across the folder, and `study`
cannot be a field name. `/` and `/gallery` show the tabbed page: the studies as cards with
the description, the `npm run explain` text, the raw YAML, and a "Try it" link, plus the
Configuration and Setup guides. Single-file mode is unchanged and ignores `study=`.

`examples/gallery/` holds nine designs for demos:

| Study | Dynamic |
|---|---|
| `shared-interest` | share at least one of three picked interests; more overlap ranks higher |
| `cross-party` | Democrat meets Republican; reveal names the partner's party |
| `same-vs-cross` | Qualtrics-randomized condition: same party vs. other party |
| `opposing-views` | stances on a 1-7 scale at least 3 apart (`not: {within: ...}`) |
| `similar-age-relax` | within 10 years of age, closest first; the age rule drops after 30s of waiting |
| `advice-pairs` | a seeker meets a giver on the same topic; two seekers never match |
| `combo` | cross-party AND (shared interest OR within 5 years) AND NOT the same gender |
| `untimed-min-messages` | a 2-minute chat vs. an untimed chat that ends when both click Done, after 3 messages each |
| `two-stage` | 3 minutes getting to know each other, survey questions, then the same partner discusses a topic until both are done |

```bash
STUDY_CONFIG=examples/gallery npm start   # then open http://localhost:3000 in two tabs or devices
```

## Qualtrics messages

The chat page talks to the generated question JavaScript with `postMessage`. The
snippet only accepts messages from your app URL, and the app only posts to origins in
`embed.allowed_origins`. The Next button stays hidden until the chat ends.

| Message | When | Embedded data saved |
|---|---|---|
| `chat_matched` | a partner is found | `chat_match_id`, `chat_partner_id`, `chat_match_reason`, `chat_reveal`, `chat_waited_ms` |
| `chat_ended` | timer ends, Done, partner leaves, or join error | `chat_outcome`, `chat_message_count`, `chat_met_min_messages`, `chat_end_ts`; with stages, also the last stage's `chat_<stage>_*` |
| `stage_ended` | a `then: qualtrics` stage ends | `chat_<stage>_end_reason`, `chat_<stage>_message_count`, `chat_<stage>_met_min_messages` (then clicks Next) |
| `nomatch` | no partner within `match_timeout` | same as `chat_ended`, with `chat_outcome = nomatch` |
| `chat_continue` | participant clicks Continue in the chat | (clicks Next) |

Use `chat_outcome` in Display or Branch Logic, for example to route `nomatch`
participants to a different block.

## Data

Each record carries `study_id`. With `MONGO_URI`, records go to five collections;
otherwise to five files in `./data/`.

| Record | Contents |
|---|---|
| `arrivals` | participant ID, condition, parsed fields, arrival time |
| `matches` | match ID, both IDs (earlier arrival first), condition, rules satisfied, rules waived by relaxing, `prefer` rules used and their scores, reveal text per person, wait time per person |
| `messages` | match ID, sender ID, sequence number, text, time, and `stage` in a chat with stages |
| `outcomes` | one per person: `completed`, `partner_left`, `left`, `no_rejoin`, `nomatch`, or `left_waiting`, plus message count, `met_min_messages`, `end_reason` (`timer`, `both_done`, `either_done`, `max_duration`, `min_reached`, `left`, `no_rejoin`), and the last `stage` |
| `stages` | chats with stages: one per stage with start/end time, end reason, per-person message counts and `met_min_messages`, and who clicked Done |

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
LIVE_URL=https://your-app.onrender.com node --test test/live.test.js   # optional smoke test of a deployed gallery
npm run validate [config ...]  # check configs; lists every problem at once
npm run explain  [config ...]
npm run simulate [config] [people.csv]
npm run qualtrics -- [config] --url https://your-app.onrender.com [--out DIR]
```

`qualtrics/generated/` is gitignored: it depends on your app URL, so regenerate it
rather than committing it.

## Citing syncchat

If you use syncchat in published research, please cite it. The citation metadata is in
[`CITATION.cff`](CITATION.cff); GitHub's "Cite this repository" button turns it into
APA or BibTeX. Ready-to-paste APA citation:

> Lira Luttges, B. (2026). *syncchat: Synchronous participant chat with configurable matching for Qualtrics studies* (Version 0.3.0) [Computer software]. Zenodo. https://doi.org/10.5281/zenodo.23372978

The concept DOI above always resolves to the latest version. To cite v0.3.0 specifically,
use the version DOI [10.5281/zenodo.23372979](https://doi.org/10.5281/zenodo.23372979).

## License

MIT. See [`LICENSE`](LICENSE).
