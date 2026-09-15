#!/usr/bin/env node
/**
 * Send a message (and optional file attachments or rich embed) to the user's
 * Discord channel via webhook.
 *
 * Usage:
 *   node discord_send.js "your message here"
 *   echo "piped content" | node discord_send.js
 *   node discord_send.js --username "Build Bot" "message"
 *   node discord_send.js --file ./shot.png "here's the screenshot"
 *   node discord_send.js --file a.png --file b.log "two files"
 *   node discord_send.js --file https://example.com/img.png "remote image"
 *   node discord_send.js --to work "message for the work channel"
 *   node discord_send.js --quiet "no push notification for this one"
 *   node discord_send.js --silent "same as --quiet, just an alias"
 *   node discord_send.js --dry-run --file shot.png "preview before sending"
 *   node discord_send.js --embed-title "Build passed" --embed-color "#5865F2" \
 *     --embed-description "All 42 tests green" --embed-field "Duration=3m12s" \
 *     --embed-field-inline "Branch=main"
 *   node discord_send.js --help
 *   node discord_send.js -- "--- message text starting with dashes ---"
 *
 * The webhook URL is read from `config.json` sitting next to this file
 * (written by the installer, chmod 600). By default the top-level
 * `webhookUrl` is used; pass `--to <name>` to send to one of the named
 * webhooks under `config.json`'s optional `webhooks` object instead.
 * Messages longer than Discord's 2000-char limit are split into multiple
 * sends. Attachments are uploaded as multipart/form-data alongside the
 * (final) message.
 *
 * `--file` takes a local path or an http(s) URL and may be repeated, up to
 * Discord's limit of 10 attachments per message. With no message text,
 * attachments are sent on their own.
 *
 * Mentions (@everyone/@here/roles/users) in message content are suppressed
 * by default — every outgoing payload sets `allowed_mentions: { parse: [] }`.
 *
 * `--quiet` (alias `--silent`) suppresses Discord's client-side push/desktop
 * notification for the message (sets the `SUPPRESS_NOTIFICATIONS` message
 * flag). The message still posts and is visible in the channel as normal —
 * only the notification is suppressed. This is independent of and composable
 * with the always-on `allowed_mentions` guard above: that guard blocks pings
 * from @everyone/@here/mentions *in the text*, while --quiet/--silent
 * suppresses the generic new-message notification regardless of content.
 *
 * `--dry-run` runs every validation a real send performs — flag parsing,
 * the MAX_FILES count check, loadWebhook(--to) resolution, loadFile() for
 * every `--file` ref (including http(s):// URLs — those are STILL fetched
 * over the network under --dry-run, since real bytes are needed to report
 * accurate size/type and to exercise the size-limit check meaningfully),
 * and the combined MAX_ATTACHMENT_BYTES check — but skips only the final
 * post() call(s) to Discord. It prints a full report of what would have
 * been sent (messages, chunking, attachments, flags) and exits 0. The
 * webhook URL is never printed unmasked in this output — only a masked
 * version (see maskWebhookUrl) plus the --to name (or "default").
 *
 * Exactly one embed per invocation is supported, built from up to 4 flags:
 * `--embed-title <text>`, `--embed-description <text>`, `--embed-color
 * <#RRGGBB|RRGGBB|decimal>`, and `--embed-field <name=value>` /
 * `--embed-field-inline <name=value>` (repeatable, in the order given).
 * NOT supported: --embed-url, --embed-footer, --embed-image/--embed-thumbnail,
 * --embed-author, --embed-timestamp, or multiple embeds. All embed pieces
 * are validated locally against Discord's documented per-embed limits
 * (title 256, description 4096, 25 fields, field name 256 / value 1024,
 * 6000 combined) before any webhook lookup or network call. An embed with
 * no message text is a valid send on its own; with a multi-chunk message
 * the embed is attached to the final chunk only, exactly like `--file`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const MAX = 2000; // Discord per-message content limit
const MAX_FILES = 10; // Discord per-message attachment limit
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // Discord's default (non-boosted) combined webhook attachment limit
const MAX_RETRIES = 5; // retries for 429 / 5xx before giving up
const BASE_DELAY_MS = 500; // backoff base when Discord gives no retry_after
const MAX_DELAY_MS = 30_000; // cap on any single retry wait
const SUPPRESS_NOTIFICATIONS = 1 << 12; // Discord message flag 4096, suppresses the client-side push/desktop notification for this message

const USAGE = `discord_send.js — send a message, attachments, or an embed to a Discord webhook.

usage:
  node discord_send.js [flags] [message...]
  <command> | node discord_send.js [flags]

flags:
  --file, --attach <path|url>   attach a file; repeatable, up to ${MAX_FILES} per message
  --to <name>                   send to a named webhook from config.json (default: the default webhook)
  --username <name>             override the display name the message is posted under
  --quiet, --silent             deliver without triggering a push notification
  --dry-run                     validate and report what would be sent, without sending
  --embed-title <text>          embed title
  --embed-description <text>    embed description
  --embed-color <color>         embed accent color: #RRGGBB, RRGGBB, or 0-16777215
  --embed-field <name=value>    full-width embed field; repeatable
  --embed-field-inline <n=v>    side-by-side embed field; repeatable
  --help, -h                    show this help and exit
  --                            stop parsing flags; everything after is message text

message text:
  Any non-flag arguments are joined with spaces to form the message. With no
  message, no --file, and no embed, the message is read from stdin instead.

examples:
  node discord_send.js "build finished"
  node discord_send.js --file shot.png "here's the screenshot"
  node discord_send.js --to work --quiet "nightly backup finished"
  npm test 2>&1 | node discord_send.js --username "Test Runner"
  node discord_send.js -- "--- release notes ---"

config:
  Webhooks are read from config.json next to this script. Run
  \`npx agy-discord-notify\` to create or update it.
`;

// Discord's documented limits for a single embed (see buildEmbed below —
// exactly one embed per invocation is supported; no url/footer/image/
// thumbnail/author/timestamp/multi-embed).
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const EMBED_FIELD_NAME_MAX = 256;
const EMBED_FIELD_VALUE_MAX = 1024;
const EMBED_FIELDS_MAX = 25;
const EMBED_TOTAL_MAX = 6000;

// Minimal extension → MIME map so Discord renders common files inline
// (images especially) instead of treating everything as octet-stream.
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".zip": "application/zip",
};

function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
}

/** Sum the byte length of every loaded file's data (0 for an empty array). */
function totalFileBytes(files) {
  return files.reduce((sum, f) => sum + f.data.length, 0);
}

/** Format a byte count as a human-readable megabyte string, e.g. "8.00MB". */
function formatBytes(n) {
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * Mask the token portion of a webhook URL for safe display (e.g. in
 * --dry-run output), keeping the numeric id visible but masking the
 * secret token. Mirrors bin/cli.js's own `mask()` — duplicated rather
 * than imported since this file must keep running standalone as a CLI
 * skill with no dependency on bin/cli.js.
 */
function maskWebhookUrl(url) {
  return url.replace(/\/([\w-]+)$/, (_, token) => "/" + token.slice(0, 4) + "…" + token.slice(-4));
}

/** Format an embed color as both hex and decimal, e.g. "#5865F2 (5793266)". */
function formatEmbedColor(color) {
  return `#${color.toString(16).padStart(6, "0").toUpperCase()} (${color})`;
}

/**
 * Parse a `--embed-color` value into a decimal 0..0xFFFFFF integer, or
 * return null if the input doesn't match any of the 3 accepted formats:
 * `#RRGGBB`, bare `RRGGBB`, or a decimal integer literal in range.
 */
function parseEmbedColor(input) {
  const hex = input.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
  if (/^\d+$/.test(input) && Number(input) <= 0xffffff) return Number(input);
  return null;
}

/**
 * Parse a `--embed-field`/`--embed-field-inline` value of the form
 * `name=value`, splitting on the FIRST `=` (so values may themselves
 * contain `=`). Trims whitespace from both sides. Returns null when
 * there's no `=`, or the trimmed name or value is empty.
 */
function parseEmbedField(raw) {
  const eq = raw.indexOf("=");
  if (eq < 0) return null;
  const name = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();
  if (!name || !value) return null;
  return { name, value };
}

/**
 * Build the single embed for this send from CLI-provided pieces, or return
 * null when nothing embed-related was passed (no embed requested).
 * Otherwise builds `{ title?, description?, color?, fields? }` (omitting
 * absent keys) and validates against Discord's documented embed limits,
 * calling fail() on the FIRST violation found. Pure and zero-I/O — callers
 * must run this before any webhook lookup or network fetch.
 */
function buildEmbed({ title, description, color, fields } = {}) {
  if (title === undefined && description === undefined && color === undefined && (!fields || !fields.length)) {
    return null;
  }

  const embed = {};
  if (title !== undefined) embed.title = title;
  if (description !== undefined) embed.description = description;
  if (color !== undefined) embed.color = color;
  if (fields && fields.length) embed.fields = fields;

  if (embed.title && embed.title.length > EMBED_TITLE_MAX) {
    fail(`embed title too long: ${embed.title.length} chars (Discord's limit is ${EMBED_TITLE_MAX})`);
  }
  if (embed.description && embed.description.length > EMBED_DESCRIPTION_MAX) {
    fail(
      `embed description too long: ${embed.description.length} chars (Discord's limit is ${EMBED_DESCRIPTION_MAX})`
    );
  }
  if (embed.fields && embed.fields.length > EMBED_FIELDS_MAX) {
    fail(`too many embed fields: ${embed.fields.length} (Discord allows ${EMBED_FIELDS_MAX} per embed)`);
  }
  if (embed.fields) {
    for (const f of embed.fields) {
      if (f.name.length > EMBED_FIELD_NAME_MAX) {
        fail(
          `embed field name too long: "${f.name}" is ${f.name.length} chars (Discord's limit is ${EMBED_FIELD_NAME_MAX})`
        );
      }
      if (f.value.length > EMBED_FIELD_VALUE_MAX) {
        fail(
          `embed field value too long: field "${f.name}" value is ${f.value.length} chars (Discord's limit is ${EMBED_FIELD_VALUE_MAX})`
        );
      }
    }
  }

  const total =
    (embed.title ? embed.title.length : 0) +
    (embed.description ? embed.description.length : 0) +
    (embed.fields ? embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0) : 0);
  if (total > EMBED_TOTAL_MAX) {
    fail(
      `embed too large: ${total} chars combined across title/description/fields (Discord's limit is ${EMBED_TOTAL_MAX} per embed)`
    );
  }

  return embed;
}

/**
 * Build the full multi-line report printed by `--dry-run`. Pure function:
 * given exactly what a real send would have computed by this point (the
 * resolved target, the already-chunked message parts, and the
 * already-loaded file objects), it describes what *would* be posted to
 * Discord without posting anything. Mirrors main()'s real-send logic
 * message-for-message so the report is an accurate preview.
 */
function buildDryRunReport({ to, webhookUrl, quiet, username, parts, files, embeds = [] }) {
  const lines = [];
  lines.push("DRY RUN — nothing was sent. All validation a real send performs has passed.");
  lines.push("");
  lines.push(`target: ${to !== undefined ? to : "default"} (${maskWebhookUrl(webhookUrl)})`);
  if (username) lines.push(`username: ${username}`);
  lines.push(
    quiet
      ? "quiet/silent: ON — flags: 4096 (SUPPRESS_NOTIFICATIONS) would be included on every message"
      : "quiet/silent: off — no flags key would be included"
  );
  lines.push("allowed_mentions: { parse: [] } is always included, regardless of --quiet/--silent");
  lines.push("");

  const total = parts.length;
  if (total === 0) {
    const label =
      files.length && embeds.length
        ? "files + embed-only send"
        : embeds.length
          ? "embed-only send"
          : "files-only send";
    lines.push(`messages: none (${label})`);
  } else {
    parts.forEach((part, i) => {
      lines.push(`message ${i + 1}/${total} — ${part.length} char${part.length === 1 ? "" : "s"}:`);
      lines.push(part);
      lines.push("");
    });
  }

  if (files.length) {
    const totalBytes = totalFileBytes(files);
    const carrierLabel =
      total === 0
        ? "attachments (posted on their own, no message text)"
        : `attachments — carried on message ${total}/${total}`;
    lines.push(`${carrierLabel}, ${files.length} file${files.length === 1 ? "" : "s"}:`);
    for (const f of files) {
      lines.push(`  - ${f.name} (${f.type}, ${formatBytes(f.data.length)}, origin: ${f.origin})`);
    }
    lines.push(`  combined: ${formatBytes(totalBytes)} / ${formatBytes(MAX_ATTACHMENT_BYTES)} limit`);
    lines.push("");
  }

  if (embeds.length) {
    const embed = embeds[0];
    const carrierLabel =
      total === 0 ? "embed (posted on its own, no message text)" : `embed — attached to message ${total}/${total}`;
    lines.push(`${carrierLabel}:`);
    if (embed.title) lines.push(`  title: ${embed.title}`);
    if (embed.description) lines.push(`  description: ${embed.description}`);
    if (embed.color !== undefined) lines.push(`  color: ${formatEmbedColor(embed.color)}`);
    if (embed.fields && embed.fields.length) {
      lines.push(`  fields (${embed.fields.length}):`);
      for (const f of embed.fields) {
        lines.push(`    - ${f.name}: ${f.value} (inline: ${f.inline ? "true" : "false"})`);
      }
    }
    lines.push("");
  }

  const messageCount = total === 0 ? (files.length || embeds.length ? 1 : 0) : total;
  lines.push(
    `DRY RUN SUMMARY: ${messageCount} Discord API call${messageCount === 1 ? "" : "s"} would have ` +
      `been made — none were. Re-run without --dry-run to actually deliver this.`
  );

  return lines.join("\n") + "\n";
}

function loadWebhook(to) {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    fail(
      `no config found at ${CONFIG_PATH}\n` +
        `run the installer to set your webhook: npx agy-discord-notify`
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    fail(`config at ${CONFIG_PATH} is not valid JSON`);
  }

  if (to === undefined) {
    if (!cfg.webhookUrl) {
      fail(`config at ${CONFIG_PATH} is missing "webhookUrl"`);
    }
    return cfg.webhookUrl;
  }

  const url = cfg.webhooks?.[to];
  if (url) return url;

  const names = cfg.webhooks ? Object.keys(cfg.webhooks) : [];
  if (names.length) {
    fail(
      `no webhook named "${to}" in config.json (available: ${names.join(", ")} — or omit --to for the default)`
    );
  } else {
    fail(
      `no webhook named "${to}" in config.json (no named webhooks configured — only the default is available; add one via: npx agy-discord-notify)`
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute a retry delay (ms) for a failed response. Prefers Discord's own
 * `retry_after` (seconds, in the JSON body or the `Retry-After` header) so
 * we wait exactly as long as asked; falls back to exponential backoff for
 * transient 5xx errors that carry neither.
 */
function retryDelayMs(res, bodyText, attempt) {
  let retryAfterSec;
  try {
    const data = JSON.parse(bodyText);
    if (typeof data.retry_after === "number") retryAfterSec = data.retry_after;
  } catch {
    /* not JSON */
  }
  if (retryAfterSec == null) {
    const header = res.headers.get("retry-after");
    if (header != null) retryAfterSec = Number(header);
  }
  const base =
    retryAfterSec != null && Number.isFinite(retryAfterSec)
      ? retryAfterSec * 1000
      : BASE_DELAY_MS * 2 ** attempt;
  return Math.min(Math.round(base) + Math.floor(Math.random() * 50), MAX_DELAY_MS);
}

async function post(
  webhookUrl,
  { content, username, files = [], quiet = false, embeds = [] } = {},
  attempt = 0
) {
  const payload = {};
  if (content) payload.content = content;
  if (username) payload.username = username;
  // Suppress @everyone/@here/role/user pings by default; this is a
  // default-safety guard, not configurable via CLI flag.
  payload.allowed_mentions = { parse: [] };
  // Suppress the client-side push/desktop notification for this message
  // when --quiet/--silent was passed. Omitted entirely (not `flags: 0`)
  // when not requested.
  if (quiet) payload.flags = SUPPRESS_NOTIFICATIONS;
  // A single embed, omitted entirely (not `embeds: []`) when none was
  // requested. See buildEmbed for validation/shape.
  if (embeds.length) payload.embeds = embeds;

  // A browser-like UA avoids Cloudflare bot blocks (1010) seen with
  // default library user-agents. With files we send multipart/form-data
  // and let fetch set the Content-Type (incl. boundary) itself.
  const headers = { "User-Agent": "agy-discord-notify/1.0" };
  let body;
  if (files.length) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    files.forEach((f, i) => {
      form.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name);
    });
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }

  const res = await fetch(webhookUrl, { method: "POST", headers, body });
  if (res.ok) return;

  const text = await res.text().catch(() => "");
  // 429 = rate limited, 5xx = transient server-side failure — both worth
  // retrying. Anything else (bad webhook, bad payload) is permanent.
  const retryable = res.status === 429 || res.status >= 500;
  if (retryable && attempt < MAX_RETRIES) {
    await sleep(retryDelayMs(res, text, attempt));
    return post(webhookUrl, { content, username, files, quiet, embeds }, attempt + 1);
  }
  const suffix = retryable
    ? ` (gave up after ${attempt} retr${attempt === 1 ? "y" : "ies"})`
    : "";
  throw new Error(`HTTP ${res.status} ${res.statusText} ${text}`.trim() + suffix);
}

/**
 * Resolve a `--file` value (local path or http(s) URL) into
 * { name, type, data, origin }, where origin is "url" or "local" (used by
 * --dry-run's report). URLs are fetched and verified to actually load
 * before we attempt to upload them — including under --dry-run, where the
 * real fetch still happens so the reported size/type reflect actual bytes.
 */
async function loadFile(ref) {
  if (/^https?:\/\//i.test(ref)) {
    let res;
    try {
      res = await fetch(ref, {
        headers: { "User-Agent": "agy-discord-notify/1.0" },
      });
    } catch (e) {
      fail(`could not load ${ref}: ${e.message || e}`);
    }
    if (!res.ok) {
      fail(`could not load ${ref}: HTTP ${res.status} ${res.statusText}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) fail(`${ref} loaded but was empty`);
    // Prefer a filename from the URL path; fall back to a generic one.
    let name = path.basename(new URL(ref).pathname) || "download";
    const type =
      res.headers.get("content-type")?.split(";")[0].trim() || mimeFor(name);
    if (!path.extname(name)) name += extFor(type);
    return { name, type, data, origin: "url" };
  }

  // Local path.
  let data;
  try {
    data = fs.readFileSync(ref);
  } catch (e) {
    if (e.code === "ENOENT") fail(`file not found: ${ref}`);
    if (e.code === "EISDIR") fail(`not a file (it's a directory): ${ref}`);
    fail(`could not read ${ref}: ${e.message || e}`);
  }
  return { name: path.basename(ref), type: mimeFor(ref), data, origin: "local" };
}

/** Guess an extension from a MIME type for URLs that have none. */
function extFor(type) {
  for (const [ext, mime] of Object.entries(MIME)) {
    if (mime === type) return ext;
  }
  return "";
}

/** Split text into <=n-char pieces, preferring newline boundaries. */
function chunks(text, n = MAX) {
  const out = [];
  let cur = "";
  for (let line of text.split("\n")) {
    while (line.length > n) {
      // a single line longer than the limit
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(line.slice(0, n));
      line = line.slice(n);
    }
    const candidate = cur ? cur + "\n" + line : line;
    if (candidate.length > n) {
      out.push(cur);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const parts = [];
  for await (const chunk of process.stdin) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

async function main() {
  const rest = [];
  const fileRefs = [];
  let username;
  let to;
  let quiet = false;
  let dryRun = false;
  let embedTitle;
  let embedDescription;
  let embedColor;
  const embedFields = [];

  // Flags may appear in any order; everything else is message text.
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--username") {
      if (i + 1 >= args.length) fail("--username needs a value");
      username = args[++i];
    } else if (a === "--file" || a === "--attach") {
      if (i + 1 >= args.length) fail(`${a} needs a path or URL`);
      fileRefs.push(args[++i]);
    } else if (a === "--to") {
      if (i + 1 >= args.length) fail("--to needs a webhook name");
      to = args[++i];
    } else if (a === "--quiet" || a === "--silent") {
      quiet = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--embed-title") {
      if (i + 1 >= args.length) fail("--embed-title needs a value");
      embedTitle = args[++i];
    } else if (a === "--embed-description") {
      if (i + 1 >= args.length) fail("--embed-description needs a value");
      embedDescription = args[++i];
    } else if (a === "--embed-color") {
      if (i + 1 >= args.length) fail("--embed-color needs a value");
      const raw = args[++i];
      const parsed = parseEmbedColor(raw);
      if (parsed === null) {
        fail(`invalid --embed-color: "${raw}" (expected #RRGGBB, RRGGBB, or a decimal integer 0-16777215)`);
      }
      embedColor = parsed;
    } else if (a === "--embed-field") {
      if (i + 1 >= args.length) fail("--embed-field needs a value");
      const raw = args[++i];
      const parsed = parseEmbedField(raw);
      if (!parsed) fail(`invalid --embed-field: "${raw}" (expected name=value)`);
      embedFields.push({ ...parsed, inline: false });
    } else if (a === "--embed-field-inline") {
      if (i + 1 >= args.length) fail("--embed-field-inline needs a value");
      const raw = args[++i];
      const parsed = parseEmbedField(raw);
      if (!parsed) fail(`invalid --embed-field-inline: "${raw}" (expected name=value)`);
      embedFields.push({ ...parsed, inline: true });
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === "--") {
      // Everything after `--` is message text, so a message can start with
      // dashes (e.g. a markdown rule) without looking like a flag.
      rest.push(...args.slice(i + 1));
      break;
    } else if (a.startsWith("--")) {
      // Without this, a typo like `--fiel shot.png` silently became message
      // text and got delivered to Discord as-is.
      fail(
        `unknown flag: ${a}\n` +
          `  run with --help to see the available flags\n` +
          `  if that is message text, put it after --: discord_send.js -- "${a}"`
      );
    } else {
      rest.push(a);
    }
  }

  if (fileRefs.length > MAX_FILES) {
    fail(`too many attachments: ${fileRefs.length} (Discord allows ${MAX_FILES} per message)`);
  }

  // Pure/zero-I/O — must run (and fail(), if invalid) before any webhook
  // lookup or network fetch below.
  const embed = buildEmbed({
    title: embedTitle,
    description: embedDescription,
    color: embedColor,
    fields: embedFields,
  });

  let msg = rest.join(" ").trim();
  // Only fall back to stdin for the message when no attachments and no
  // embed were given; an attachment or embed with no text is a valid send
  // on its own.
  if (!msg && !fileRefs.length && !embed) msg = (await readStdin()).trim();
  if (!msg && !fileRefs.length && !embed) {
    process.stderr.write("error: no message or attachment provided\n");
    process.exit(2);
  }

  const webhookUrl = loadWebhook(to);
  const files = [];
  for (const ref of fileRefs) files.push(await loadFile(ref));

  const totalBytes = totalFileBytes(files);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    fail(
      `attachments too large: ${formatBytes(totalBytes)} combined ` +
        `(Discord's webhook limit is ${formatBytes(MAX_ATTACHMENT_BYTES)} per message)`
    );
  }

  try {
    const parts = msg ? chunks(msg).filter((p) => p.trim() !== "") : [];
    const embeds = embed ? [embed] : [];

    if (dryRun) {
      process.stdout.write(buildDryRunReport({ to, webhookUrl, quiet, username, parts, files, embeds }));
      return;
    }

    if (!parts.length) {
      // Files/embed only (or empty message): a single post carrying them.
      await post(webhookUrl, { content: msg, username, files, quiet, embeds });
    } else {
      // Send text first; attach files and the embed to the final message so
      // they appear after the content. Every chunk gets `quiet`
      // unconditionally — it's a per-message flag, and each chunk is its
      // own Discord message.
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        await post(webhookUrl, {
          content: parts[i],
          username,
          files: last ? files : [],
          embeds: last ? embeds : [],
          quiet,
        });
      }
    }
    const sent = [];
    if (msg) sent.push("message");
    if (embed) sent.push("embed");
    if (files.length) sent.push(`${files.length} attachment${files.length > 1 ? "s" : ""}`);
    const what = sent.length ? sent.join(" + ") : "message";
    process.stdout.write(`✅ sent ${what} to Discord\n`);
  } catch (e) {
    fail(e.message || String(e));
  }
}

// Only run as a CLI when invoked directly (`node discord_send.js ...`), not
// when imported — e.g. by the test suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  chunks,
  mimeFor,
  extFor,
  post,
  loadFile,
  loadWebhook,
  MAX_RETRIES,
  MAX_ATTACHMENT_BYTES,
  totalFileBytes,
  formatBytes,
  maskWebhookUrl,
  buildDryRunReport,
  parseEmbedColor,
  parseEmbedField,
  buildEmbed,
  formatEmbedColor,
  EMBED_TITLE_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_TOTAL_MAX,
};
