# agy-discord-notify

> Send **Discord notifications** from **[Google Antigravity (AGY)](https://github.com/graphite-works/agy-discord-notify)** — build results, summaries, screenshots, and autonomous completion pings, posted directly to a Discord webhook you own.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

**agy-discord-notify** is an Antigravity (AGY) skill, lifecycle hook, and zero-dependency Node.js CLI tool that sends Discord notifications via webhooks — messages, file attachments, and rich embeds.

Long-running autonomous tasks in Antigravity (like `/goal` or heavy builds) mean you shouldn't have to stay tethered to your screen. This skill eliminates the waiting: tell Antigravity *"notify me on Discord when the tests pass"*, or enable the autonomous `Stop` hook to get automatic pings whenever Antigravity finishes working.

---

## ✨ Features

- **Zero dependencies** — pure Node.js ≥18 using built-in `fetch`, `FormData`, and `Blob`. Nothing to audit but the script itself.
- **Dual-scope installation** — install globally (`~/.gemini/config/skills/`) or locally to your repository workspace (`.agents/skills/`) so your entire team shares notifications.
- **Autonomous `Stop` Hook (`hooks.json`)** — optionally configure an automatic completion ping whenever Antigravity finishes a turn or `/goal` session.
- **Progressive disclosure** — uses Antigravity's YAML frontmatter convention in `SKILL.md` so the skill costs **zero tokens** until activated.
- **Natural-language usage** — once installed, just tell Antigravity what to send and where.
- **File attachments** — up to 10 files per message (images, video, audio, PDFs, logs) with automatic MIME detection for inline Discord rendering.
- **Rich embeds** — title, description, accent color (`#RRGGBB` or decimal), and up to 25 inline/block fields, with Discord's limits validated locally before sending.
- **Multiple channels** — configure named webhooks and target them with `--to <name>` (e.g. `--to work`), keeping a default channel for general notifications.
- **Safe by default** — `@everyone`/`@here` pings are suppressed by default; `--quiet` suppresses client-side push alerts for low-priority updates.
- **`--dry-run` previews** — validates payload constraints and prints exact formatting without hitting Discord.
- **Resilient delivery** — retries HTTP 429 and 5xx responses with exponential backoff honoring Discord's `retry_after`. Automatically splits long messages (>2000 chars) on line boundaries.

---

## 🚀 Installation

### Prerequisites

- **Node.js 18 or higher** (`node --version`).
- **Google Antigravity (AGY)** IDE or CLI.
- **A Discord webhook URL** from Discord (*Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL*).

### One-Command Setup

```bash
npx agy-discord-notify
```

The interactive installer will:
1. Ask whether to install **Globally** (`~/.gemini/config/skills/`) or **Locally** to the active workspace (`.agents/skills/`).
2. Prompt for your Discord webhook URL.
3. Optionally add **named webhooks** (e.g. `work`, `alerts`) for `--to <name>`.
4. Optionally configure an **Antigravity `Stop` Lifecycle Hook** (`hooks.json`) for automatic completion alerts.
5. Save credentials to a secure `chmod 600` `config.json`.
6. Offer to send a test ping to verify your channel.

### Non-Interactive / Scripted Flags

```bash
# Install globally without prompts for CI/Docker
npx agy-discord-notify --global --no-hook

# Install into current project workspace (.agents/skills/discord-notify)
npx agy-discord-notify --local

# Install and configure Stop lifecycle hook
npx agy-discord-notify --hook
```

---

## 💬 Natural Language Usage in Antigravity

Once installed, you don't need to run CLI commands manually — just speak naturally to Antigravity:

* *"Run the test suite and ping my Discord channel with the results."*
* *"Send that screenshot to Discord."*
* *"Post this diff in the work channel."*
* *"/goal Implement authentication and notify me on Discord when finished."*

---

## 💻 CLI & Skill Reference

You can also run the sender directly from terminal scripts, Makefiles, or CI pipelines:

```bash
# Basic message
node ~/.gemini/config/skills/discord-notify/discord_send.js "Deploy completed successfully"

# Piped output
npm test 2>&1 | node ~/.gemini/config/skills/discord-notify/discord_send.js --username "Test Runner"

# Send to a named webhook
node ~/.gemini/config/skills/discord-notify/discord_send.js --to work "Review requested"

# Quiet delivery (no push notification ping)
node ~/.gemini/config/skills/discord-notify/discord_send.js --quiet "Nightly backup finished"

# Attachments (local path or remote URL)
node ~/.gemini/config/skills/discord-notify/discord_send.js --file ./coverage/badge.png "Coverage report"

# Rich structured embed
node ~/.gemini/config/skills/discord-notify/discord_send.js \
  --embed-title "Build Passed" \
  --embed-color "#57F287" \
  --embed-description "All 182 unit tests passed" \
  --embed-field "Branch=main" \
  --embed-field-inline "Duration=4.2s" \
  --embed-field-inline "Commit=a1b2c3d"

# Preview before sending
node ~/.gemini/config/skills/discord-notify/discord_send.js --dry-run "Previewing message"
```

---

## 🤖 Antigravity Lifecycle Hook (`hooks.json`)

If enabled during install, `agy-discord-notify` configures a `Stop` hook in your Antigravity `hooks.json`:

```json
{
  "discord-notify-on-stop": {
    "enabled": true,
    "Stop": [
      {
        "type": "command",
        "command": "node ~/.gemini/config/skills/discord-notify/hook_stop.js",
        "timeout": 15
      }
    ]
  }
}
```

Whenever an Antigravity agent finishes its execution loop (or encounters a terminal error), the hook dispatches a quiet summary card to your Discord channel:
> 🤖 **Antigravity Task Finished**  
> **Workspace:** `my-project`  
> **Reason:** `model_stop`

---

## 🧪 Testing

Run the comprehensive test suite (182 unit and integration tests):

```bash
npm test
```

Tests exercise:
- Message chunking and boundary limits (2000 chars)
- Single and multi-attachment limits (up to 10 files, 8MB max combined)
- Rich embed validations (title, description, hex/decimal color, 25 fields, 6000 chars total)
- Local and remote URL file loading
- Secure config creation and permissions (`chmod 600`)
- Dual-scope global and workspace installation logic
- `Stop` lifecycle hook parsing and delivery

---

## 📄 License

MIT © Blake Daniel