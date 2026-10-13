# Embedding syncchat in Qualtrics

## 1. Survey Flow
Add an **Embedded Data** element at the top of the Survey Flow for every value passed
to the chat, plus the fields written back by the chat:

| Field | Set by | Notes |
|---|---|---|
| `cond` | Randomizer | Put a Randomizer with one Embedded Data element per condition (`cond = cross`, `cond = same`). Names must match `conditions:` in study.yaml. |
| `party`, `top3`, `age`, ... | Questions | Set them from earlier answers, e.g. `party = ${q://QID3/ChoiceGroup/SelectedChoices}`. List fields are one comma-separated string. |
| `chat_outcome`, `chat_match_id`, `chat_reveal`, `chat_message_count`, `chat_met_min_messages`, `chat_waited_ms`, `chat_start_ts`, `chat_end_ts` | The chat | Declare them (leave the value empty) so they appear in your data. |
| `chat_transcript` | The chat | Only filled if `embed.send_transcript_to_parent: true`. |

ResponseID is built in; it becomes the participant ID.

## 2. The chat question
1. Add a **Text/Graphic** question on its own page.
2. In the question text, switch to **HTML View** and paste `<div id="chat-root"></div>`.
3. Open the question's **JavaScript** editor and paste `chat-question.js`.
4. Edit `CHAT_URL` and the `PARAMS` block. The keys must match study.yaml.

## 3. Message flow
- The Next button is hidden while the participant waits and chats.
- The chat page posts messages to Qualtrics. The snippet only accepts messages from
  `CHAT_URL`, and the chat only posts to origins in `embed.allowed_origins`.

| Message | When | Snippet does |
|---|---|---|
| `chat_matched` | a partner is found | saves `chat_match_id`, `chat_reveal`, `chat_waited_ms` |
| `chat_ended` | timer ends, partner leaves, or join error | saves the outcome fields, shows Next |
| `nomatch` | no partner within `match_timeout` | saves the outcome fields, shows Next |
| `chat_continue` | participant clicks Continue in the chat | clicks Next |

Use `chat_outcome` in Display Logic or Branch Logic, for example to route `nomatch`
participants to a different block.

## 4. Test before launch
Preview the survey in two different browsers (or one normal + one private window)
at the same time. Each preview gets its own ResponseID, so they can match.
