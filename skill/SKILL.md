---
name: discord-notify
description: Send a message/notification to the user's Discord channel via webhook. Use whenever the user asks you to send, post, notify, ping, or DM them something on Discord (e.g. "send that to discord", "notify me on discord when done", "post the results to my channel").
---

# discord-notify

Sends a message, file attachments, or rich embeds to the user's Discord channel using a saved webhook.

## How to use

Run the sender with the message as an argument:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js "Your message here"
```

*(If installed in the local workspace, use `node .agents/skills/discord-notify/discord_send.js "Your message here"` instead.)*

Pipe content (command output, logs, a file) into it:

```bash
some-command | node ~/.gemini/config/skills/discord-notify/discord_send.js
```

Optional custom sender name shown in Discord:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --username "Build Bot" "Done!"
```

If the message text itself begins with `--` (a markdown rule, a diff hunk), put
it after a bare `--` so it isn't parsed as a flag:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js -- "--- deploy notes ---"
```

## Sending to a specific webhook

`config.json` always has a default `webhookUrl`. It may also have a
`webhooks` object mapping name → URL for additional Discord channels the
user configured during install (e.g. a "work" channel separate from their
default). Target one of these with `--to <name>`:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --to work "deploy finished"
```

- Omit `--to` for the default channel — that's the right choice for most
  requests ("notify me on discord", "send that to my discord").
- Use `--to <name>` only when the user names a specific destination that
  matches a configured webhook (e.g. "post that in the work channel" and
  `work` is configured) or explicitly asks to use a webhook by name.
- If it's ambiguous which named webhook the user means (the name they said
  doesn't clearly match a configured one, or they haven't said which channel
  and more than one non-default option exists), **ask** which one instead of
  guessing — a wrong destination silently leaks messages to the wrong place.
- If `--to <name>` fails because that name isn't configured, the error lists
  the available names — relay that to the user rather than retrying with a
  guess.

## Sending quietly (no notification)

Pass `--quiet` (alias `--silent`) as a plain boolean switch to suppress
Discord's client-side push/desktop notification for the message:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --quiet "background sync finished"
```

- The message still posts and is fully visible in the channel — only the
  notification ping to the client is suppressed.
- This is **not** the same thing as the always-on `allowed_mentions` guard
  (see Notes below): that guard blocks pings caused by `@everyone`/`@here`/
  role/user mentions written *in the message text*. `--quiet`/`--silent`
  suppresses the generic new-message notification regardless of what the
  text contains — they're independent and compose freely.
- Use `--quiet`/`--silent` when the user asks for something low-priority,
  background, or explicitly says not to notify/ping/interrupt them (e.g.
  "log that to discord but don't notify me", "post it quietly").
- `--quiet`/`--silent` may appear anywhere among the other flags/arguments
  and composes with `--to`, `--username`, `--file`, and multi-chunk messages.

## Previewing before sending (`--dry-run`)

Pass `--dry-run` as a plain boolean switch to validate and preview a send
without actually posting to Discord:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --dry-run --file shot.png "preview text"
```

- Use `--dry-run` when the user explicitly asks to **preview, test, or
  check** what would be sent without actually sending it (e.g. "show me
  what that would look like before sending", "test this without actually
  posting", "preview the message"). Do not add it on your own initiative
  for a normal send request — only when the user asks for a preview/test/dry
  run specifically.
- It still runs every validation a real send would: webhook resolution
  (including `--to` lookup), the 10-attachment count check, loading every
  `--file` (local **and** URL — URL attachments are genuinely fetched over
  the network even under `--dry-run`, so a preview accurately reports their
  real size/type), and the 8MB combined-attachment check. If any of those
  would fail on a real send, they fail identically under `--dry-run` — a
  clean exit means the real send would succeed.
- Nothing is posted to Discord: the only thing skipped is the final network
  call(s) to the webhook. The webhook URL is never shown in the output,
  even masked — only a masked form (`.../AbCd…z890`) plus the `--to` name
  or `default` is printed.
- Report the output back to the user rather than re-summarizing it from
  memory — it lists every message chunk (with char count and full text)
  and every attachment (name, MIME type, size, local-vs-URL origin, and
  combined size vs. the 8MB limit).

## Sending a rich embed

Attach one rich, structured embed — title, description, an accent color,
and up to 25 name/value fields — alongside or instead of plain message
text:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --embed-title "Build passed" --embed-color "#57F287" --embed-field "Duration=3m12s" --embed-field-inline "Branch=main" "deploy finished"
```

- `--embed-title <text>` — up to 256 characters.
- `--embed-description <text>` — up to 4096 characters.
- `--embed-color <value>` — accepts `#RRGGBB`, bare `RRGGBB`, or a decimal
  integer `0`-`16777215`. The hex format is checked first: a 6-character
  all-digit value (e.g. `123456`) is read as hex, not decimal — use `#` or a
  non-numeric-looking hex value to be unambiguous.
- `--embed-field <name=value>` — adds a full-width ("block") field; repeatable.
  Splits on the *first* `=` only, so the value may itself contain `=`
  (`"Formula=x=y+z"` → name `Formula`, value `x=y+z`); the name may not.
- `--embed-field-inline <name=value>` — adds an inline field (sits
  side-by-side with other inline fields); repeatable. Block and inline
  fields may be mixed freely; they render in the order the flags are given.

**When to reach for an embed vs. plain content:**

- Use an embed when the content is naturally **structured data** — build or
  test results, a status summary with several named values (duration,
  branch, commit, pass/fail counts), a changelog entry — rather than a
  single sentence. Title + color + fields reads far more clearly in Discord
  than the same data crammed into message text.
- `--embed-color` is a good way to signal outcome at a glance — e.g. green
  (`#57F287`) for success, red (`#ED4245`) for failure, blurple
  (`#5865F2`) for a neutral/informational update. Pick a sensible color
  even if the user doesn't specify one.
- A short one-line message ("build passed") does **not** need an embed —
  reserve embeds for more than one piece of structured info, or when the
  user explicitly asks for something visually organized ("send that as a
  summary card", "give me a status embed").
- An embed can be sent with **no message text at all** (embed-only), or
  alongside `content` — both are valid, and it composes with `--file`,
  `--quiet`/`--silent`, `--to`, and `--dry-run`.
- **Exactly one embed** is supported per invocation. There is no
  `--embed-url`, `--embed-footer`, `--embed-image`/`--embed-thumbnail`,
  `--embed-author`, or `--embed-timestamp` flag, and multiple embeds in one
  message aren't supported — this is a deliberate scope decision, not a
  bug. If the user asks for one of those specifically, say it isn't
  supported rather than improvising a workaround.
- Discord's per-embed limits are enforced locally before anything is sent:
  title ≤256 chars, description ≤4096 chars, ≤25 fields, field name ≤256
  chars, field value ≤1024 chars, and the combined total (title +
  description + all field names/values) ≤6000 chars. If a violation is
  reported back, shorten the offending piece (e.g. summarize a long log
  instead of pasting it whole into a field value) and retry — don't just
  retry unchanged.
- With a multi-chunk message (`content` over 2000 characters), the embed
  attaches to the **last** chunk only — same placement as `--file`.
- Under `--dry-run`, the report shows the embed's title, full description,
  color (as both hex and decimal), and every field's name/value/inline
  state, attached to the message it would actually attach to — relay that
  back to the user rather than re-describing the flags from memory.

## Attachments

To send a file (image, log, screenshot, PDF, …), pass `--file` with a path
**you** supply from the conversation — the user won't type a path, so resolve
"send me that image" to the actual file you produced or are looking at:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --file /path/to/shot.png "here's the screenshot"
```

- `--file` may be repeated, up to **10** attachments per message:

  ```bash
  node ~/.gemini/config/skills/discord-notify/discord_send.js --file a.png --file build.log "results"
  ```

- The value can be a **local path** or an **http(s) URL**. URLs are fetched and
  verified to actually load before uploading; if a URL or path can't be read,
  the send fails with a non-zero exit and nothing is posted.
- A message is optional when attaching files — `--file shot.png` with no text
  is a valid send. With text, the message is posted first and files follow.
- Combined attachment size across all `--file` values is capped at **8MB**
  (Discord's default non-boosted webhook limit). This is checked locally
  after all files are loaded and before any upload attempt — if the total
  is over the limit, the send fails immediately with a clear error and
  nothing is posted.

### Supported file types

The sender assigns a MIME type from the file extension so Discord renders the
attachment correctly (images and video preview inline, audio gets a player,
etc.). Any extension works — unknown ones upload as `application/octet-stream`
(a plain download) — but these are recognized and verified to render in Discord:

| Kind   | Extensions                                  |
|--------|---------------------------------------------|
| Image  | `png` `jpg`/`jpeg` `gif` `webp` `bmp` `svg` |
| Video  | `mp4` `webm` `mov`                          |
| Audio  | `mp3` `wav` `ogg`                           |
| Docs   | `pdf` `txt` `log` `md` `csv` `html` `json`  |
| Archive| `zip`                                       |

Note: Discord previews most of the above inline; a few (e.g. `bmp`, `svg`) may
show as a download depending on the client — the upload itself still succeeds.

## Automated Completion Pings (AGY Lifecycle Hooks)

Antigravity can automatically ping Discord when a long task or `/goal` session completes.
If configured during setup, the `Stop` lifecycle hook in `hooks.json` automatically runs:

```bash
node ~/.gemini/config/skills/discord-notify/hook_stop.js
```

Whenever AGY finishes its loop, a summary alert is dispatched to Discord without needing
to be asked in your prompt.

## Notes

- Messages over Discord's 2000-character limit are split automatically into multiple sends.
- An unrecognized `--flag` is rejected with `error: unknown flag: ...` and exit 1 — it is **not** silently sent as message text. Check the spelling against this file, or run the sender with `--help` for the full flag list. Message text that genuinely starts with dashes goes after `--`.
- Rate limits (429) and transient server errors (5xx) are retried automatically with backoff before failing.
- Discord markdown works: `**bold**`, `` `code` ``, ``` ```code blocks``` ```, multi-line, emoji.
- Mentions (`@everyone`, `@here`, role and user mentions) in message content are suppressed by default — they won't ping anyone.
- `--quiet`/`--silent` suppresses the client-side push/desktop notification for the message (message still posts and is visible) — independent of and composable with the mention guard above.
- `--dry-run` runs all the same validation (including real URL fetches for `--file` URLs) and prints a full preview of what would be sent, but skips the actual Discord post — see "Previewing before sending" above.
- A single rich embed (title/description/color/fields) can be attached via `--embed-title`/`--embed-description`/`--embed-color`/`--embed-field`/`--embed-field-inline` — see "Sending a rich embed" above. Only one embed per message is supported; embed URL/footer/image/thumbnail/author/timestamp and multiple embeds are intentionally out of scope. Discord's per-embed length/count limits are validated locally before any network call.
- The webhook URL (and any named webhooks) live in `config.json` next to the sender (`chmod 600`): `{ "webhookUrl": "...", "webhooks": { "name": "..." } }` — `webhooks` is optional and only present if the user configured named webhooks. Webhook URLs are **secrets** — anyone with one can post to that channel. To change them, re-run `npx agy-discord-notify` or edit `config.json`.
- On success it prints `✅ sent <what> to Discord`, where `<what>` names what went out (`message`, `embed`, `N attachments`, or those joined with ` + `); on failure it prints the HTTP error and exits non-zero.
