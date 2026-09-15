# agy-discord-notify

Discord notifications for Google Antigravity (AGY). A zero-dependency skill, CLI, and lifecycle hook that sends messages, file attachments, and rich embeds to a Discord webhook.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

![Antigravity posting to Discord: test results to the default channel, a screenshot to #work, a silent deploy summary to #alerts, then piped output and a rich embed sent straight from the shell](https://raw.githubusercontent.com/graphite-works/agy-discord-notify/main/docs/demo.gif)

**agy-discord-notify** is an Antigravity (AGY) skill, lifecycle hook, and zero-dependency Node.js CLI tool that sends Discord notifications via webhooks — messages, file attachments, and rich embeds. Long-running autonomous tasks in Antigravity (like `/goal` or heavy builds) mean you shouldn't have to stay tethered to your screen. This skill eliminates the waiting: tell Antigravity *"notify me on Discord when the tests pass"*, or enable the autonomous `Stop` hook to get automatic pings whenever Antigravity finishes working.

## ✨ Features

- **Zero Dependencies**: Pure Node.js ≥18 using built-in `fetch`, `FormData`, and `Blob`. Nothing to audit but the script itself.
- **Dual-Scope Installation**: Install globally (`~/.gemini/config/skills/`) or locally to your repository workspace (`.agents/skills/`) so your entire team shares notifications.
- **Autonomous `Stop` Hook**: Optionally configure an automatic completion ping in `hooks.json` whenever Antigravity finishes a turn or `/goal` session.
- **Natural-Language Usage**: Once installed, just tell Antigravity what to send and where (e.g., *"notify me on Discord when finished"*).
- **Rich Media & Embeds**: Send up to 10 file attachments per message, plus rich embeds with titles, descriptions, custom accent colors, and inline fields.
- **Resilient Delivery**: Retries HTTP 429 and 5xx responses with exponential backoff and automatically splits messages over 2000 characters.

## 📋 Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Examples](#examples)
- [Development](#development)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

## 🚀 Installation

### Prerequisites

Before you begin, ensure you have the following installed:
- [Node.js](https://nodejs.org) (version 18 or higher)
- Google Antigravity (AGY) IDE or CLI
- A Discord webhook URL (from *Server Settings → Integrations → Webhooks → New Webhook*)

### Using npx

```bash
npx agy-discord-notify
```

The interactive installer will prompt you to:
1. Choose between Global (`~/.gemini/config/skills/`) or Local (`.agents/skills/`) installation.
2. Enter your Discord webhook URL.
3. Configure optional named webhooks (e.g. `work`, `alerts`).
4. Enable the Antigravity `Stop` Lifecycle Hook.

### Non-Interactive Installation

```bash
# Install globally without prompts for CI/Docker
npx agy-discord-notify --global --no-hook

# Install into current project workspace (.agents/skills/discord-notify)
npx agy-discord-notify --local

# Install and configure Stop lifecycle hook
npx agy-discord-notify --hook
```

## ⚡ Quick Start

Get up and running in 60 seconds with a simple message:

```bash
# After installation, run directly via the CLI:
node ~/.gemini/config/skills/discord-notify/discord_send.js "Deploy completed successfully!"
```

**Expected output in Discord:** A plain text message saying "Deploy completed successfully!".

## 📖 Usage

### Natural Language Usage in Antigravity

Once installed, you don't need to run CLI commands manually — just speak naturally to Antigravity:

* *"Run the test suite and ping my Discord channel with the results."*
* *"Send that screenshot to Discord."*
* *"Post this diff in the work channel."*
* *"/goal Implement authentication and notify me on Discord when finished."*

### Command Line Interface

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
```

## ⚙️ Configuration

### Configuration File

The installer saves credentials to a secure `chmod 600` `config.json` inside the skill directory:

```json
{
  "webhooks": {
    "default": "https://discord.com/api/webhooks/...",
    "work": "https://discord.com/api/webhooks/..."
  }
}
```

### Antigravity Lifecycle Hook (`hooks.json`)

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

## 💡 Examples

### Example 1: File Attachments

Attach files to your messages using local paths or remote URLs.

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --file ./coverage/badge.png "Coverage report"
```

### Example 2: Rich Embeds

Send structured data using Discord's rich embeds:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js \
  --embed-title "Build Passed" \
  --embed-color "#57F287" \
  --embed-description "All 182 unit tests passed" \
  --embed-field "Branch=main" \
  --embed-field-inline "Duration=4.2s" \
  --embed-field-inline "Commit=a1b2c3d"
```

### Example 3: Dry Run Preview

Validate payload constraints and print exact formatting without hitting Discord:

```bash
node ~/.gemini/config/skills/discord-notify/discord_send.js --dry-run "Previewing message"
```

## 🛠️ Development

### Setting Up Development Environment

```bash
# Clone the repository
git clone https://github.com/graphite-works/agy-discord-notify.git
cd agy-discord-notify

# Install dependencies (none required for production, but needed for tests/dev if added later)
npm install
```

### Project Structure

```
agy-discord-notify/
├── bin/                # CLI entry points (cli.js)
├── skill/              # Skill definition and runtime scripts
│   ├── SKILL.md        # Antigravity skill instructions
│   ├── discord_send.js # Core message sending logic
│   └── hook_stop.js    # Lifecycle hook handler
├── test/               # Comprehensive test suite
├── package.json        # Project metadata
└── README.md           # This documentation
```

## 🧪 Testing

Run the comprehensive test suite (182 unit and integration tests) using the built-in Node.js test runner:

```bash
# Run all tests
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

## 🤝 Contributing

We welcome contributions! Please follow these steps:

### Getting Started

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Ensure all tests pass: `npm test`
5. Commit your changes: `git commit -m 'Add amazing feature'`
6. Push to the branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

### Community

- [GitHub Issues](https://github.com/graphite-works/agy-discord-notify/issues) - Bug reports and feature requests

### Getting Help

If you encounter issues:
1. Search [existing issues](https://github.com/graphite-works/agy-discord-notify/issues)
2. Open a [new issue](https://github.com/graphite-works/agy-discord-notify/issues/new)

## 📊 Project Status

- [x] Stable release v1.0.0

## 👥 Authors and Acknowledgments

### Core Team
- **Blake Daniel** - *Author*

---

**Discord notifications for Google Antigravity (AGY)**

Made with ❤️ by Blake Daniel