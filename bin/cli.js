#!/usr/bin/env node
/**
 * Interactive installer for the `discord-notify` Antigravity (AGY) skill.
 *
 *   npx agy-discord-notify
 *
 * Prompts for a Discord webhook URL, then installs the skill into
 * ~/.gemini/config/skills/discord-notify/ (or .agents/skills/discord-notify/
 * with --local) and saves the webhook to a chmod-600 config.json.
 * Optionally configures an Antigravity Stop lifecycle hook.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_SKILL_DIR = path.join(__dirname, "..", "skill");

const WEBHOOK_RE =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;
const NAME_RE = /^[A-Za-z0-9_-]+$/;

function log(msg = "") {
  stdout.write(msg + "\n");
}

function stderr_write(msg) {
  process.stderr.write(msg + "\n");
}

async function ask(rl, question) {
  const answer = await rl.question(question);
  return answer.trim();
}

function mask(url) {
  return url.replace(/\/([\w-]+)$/, (_, token) =>
    "/" + token.slice(0, 4) + "…" + token.slice(-4)
  );
}

function getSkillDir(scope = "global") {
  if (scope === "local") {
    return path.join(process.cwd(), ".agents", "skills", "discord-notify");
  }
  return path.join(os.homedir(), ".gemini", "config", "skills", "discord-notify");
}

function getHooksPath(scope = "global") {
  if (scope === "local") {
    return path.join(process.cwd(), ".agents", "hooks.json");
  }
  return path.join(os.homedir(), ".gemini", "config", "hooks.json");
}

/** Build the config object install() writes, given the primary webhook and
 * a (possibly empty) named-webhooks map. */
function buildConfig(webhookUrl, webhooks = {}) {
  return { webhookUrl, ...(Object.keys(webhooks).length ? { webhooks } : {}) };
}

async function promptScope(rl, forcedScope = null) {
  if (forcedScope) return forcedScope;

  // If in an interactive terminal, offer choice between Global and Local workspace
  const hasAgents = fs.existsSync(path.join(process.cwd(), ".agents"));
  const hasGit = fs.existsSync(path.join(process.cwd(), ".git"));
  if (hasAgents || hasGit) {
    log("");
    log("Detected active workspace / repository.");
    log("Install target:");
    log("  [1] Global (~/.gemini/config/skills/discord-notify) — available everywhere [default]");
    log("  [2] Workspace (.agents/skills/discord-notify) — shared with this repository team");
    const choice = await ask(rl, "Choose [1/2] (default 1): ");
    if (choice === "2") return "local";
  }
  return "global";
}

async function promptWebhook(rl, configPath) {
  log("");
  log("This installs the `discord-notify` skill for Google Antigravity (AGY).");
  log("");
  log("Get a webhook URL in Discord:");
  log("  Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL");
  log("(or pick an existing webhook). It looks like:");
  log("  https://discord.com/api/webhooks/123456789/AbCdEf...");
  log("");

  // Show the existing webhook (masked) if re-running.
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf8")).webhookUrl;
  } catch {
    /* none */
  }
  if (existing) {
    log(`A webhook is already configured: ${mask(existing)}`);
    log("Press Enter to keep it, or paste a new one to replace it.");
  }

  while (true) {
    const input = await ask(rl, "Discord webhook URL: ");
    if (!input && existing) return existing;
    if (WEBHOOK_RE.test(input)) return input;
    log("");
    log("⚠️  That doesn't look like a Discord webhook URL. It should start with");
    log("   https://discord.com/api/webhooks/  — please try again.");
    log("");
  }
}

async function promptNamedWebhooks(rl, existingWebhooks = {}) {
  const webhooks = { ...existingWebhooks };

  if (Object.keys(webhooks).length) {
    log("");
    log("Named webhooks already configured:");
    for (const [name, url] of Object.entries(webhooks)) {
      log(`  ${name}: ${mask(url)}`);
    }
  }

  log("");
  const add = (
    await ask(rl, "Add or update a named webhook for --to? [y/N] ")
  ).toLowerCase();
  if (add !== "y" && add !== "yes") return webhooks;

  while (true) {
    let name;
    while (true) {
      name = await ask(rl, "Webhook name (letters, digits, _ or -): ");
      if (NAME_RE.test(name)) break;
      log("");
      log("⚠️  Invalid name — use only letters, digits, underscores, and hyphens.");
      log("");
    }

    let url;
    while (true) {
      url = await ask(rl, `Discord webhook URL for "${name}": `);
      if (WEBHOOK_RE.test(url)) break;
      log("");
      log("⚠️  That doesn't look like a Discord webhook URL. It should start with");
      log("   https://discord.com/api/webhooks/  — please try again.");
      log("");
    }

    webhooks[name] = url;

    const another = (
      await ask(rl, "Add another named webhook? [y/N] ")
    ).toLowerCase();
    if (another !== "y" && another !== "yes") break;
  }

  return webhooks;
}

async function promptHook(rl, forcedHook = null) {
  if (forcedHook === true) return true;
  if (forcedHook === false) return false;

  log("");
  log("Antigravity Lifecycle Hook:");
  log("  AGY can automatically ping Discord when long-running autonomous tasks");
  log("  or turns finish (via the Stop lifecycle hook).");
  const ans = (
    await ask(rl, "Configure an automated completion hook in hooks.json? [y/N] ")
  ).toLowerCase();
  return ans === "y" || ans === "yes";
}

function install(skillDir, webhookUrl, webhooks = {}) {
  fs.mkdirSync(skillDir, { recursive: true });

  for (const file of ["SKILL.md", "discord_send.js", "hook_stop.js"]) {
    const src = path.join(PKG_SKILL_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(skillDir, file));
    }
  }

  const configPath = path.join(skillDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(buildConfig(webhookUrl, webhooks), null, 2) + "\n",
    { mode: 0o600 }
  );
  fs.chmodSync(configPath, 0o600);
}

function configureHook(hooksPath, hookScriptPath) {
  let hooks = {};
  try {
    hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  } catch {
    hooks = {};
  }

  hooks["discord-notify-on-stop"] = {
    enabled: true,
    Stop: [
      {
        type: "command",
        command: `node "${hookScriptPath}"`,
        timeout: 15,
      },
    ],
  };

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
}

async function sendTest(webhookUrl) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "agy-discord-notify/1.0",
    },
    body: JSON.stringify({
      content:
        "👋 `discord-notify` is set up — Antigravity (AGY) can now message you here.",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
  }
}

async function main() {
  const args = process.argv.slice(2);
  let forcedScope = null;
  let forcedHook = null;

  if (args.includes("--help") || args.includes("-h")) {
    log(`agy-discord-notify — installer for the Antigravity Discord skill

Usage:
  npx agy-discord-notify [options]

Options:
  --global, -g    Install globally to ~/.gemini/config/skills/discord-notify
  --local, -l     Install locally to .agents/skills/discord-notify
  --hook          Enable and configure the Antigravity Stop lifecycle hook
  --no-hook       Skip configuring the Stop lifecycle hook
  --help, -h      Show this help message
`);
    process.exit(0);
  }

  if (args.includes("--global") || args.includes("-g")) forcedScope = "global";
  if (args.includes("--local") || args.includes("-l")) forcedScope = "local";
  if (args.includes("--hook")) forcedHook = true;
  if (args.includes("--no-hook")) forcedHook = false;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const scope = await promptScope(rl, forcedScope);
    const skillDir = getSkillDir(scope);
    const configPath = path.join(skillDir, "config.json");

    const webhookUrl = await promptWebhook(rl, configPath);

    let existingWebhooks = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (
        parsed.webhooks &&
        typeof parsed.webhooks === "object" &&
        !Array.isArray(parsed.webhooks)
      ) {
        existingWebhooks = parsed.webhooks;
      }
    } catch {
      /* none */
    }

    const webhooks = await promptNamedWebhooks(rl, existingWebhooks);
    const wantHook = await promptHook(rl, forcedHook);

    install(skillDir, webhookUrl, webhooks);

    log("");
    log(`✅ Installed skill to ${skillDir}`);
    log(`   • SKILL.md, discord_send.js, hook_stop.js`);
    const namedCount = Object.keys(webhooks).length;
    log(
      `   • config.json (webhook saved${namedCount ? ` + ${namedCount} named webhook${namedCount > 1 ? "s" : ""}` : ""}, chmod 600)`
    );

    if (wantHook) {
      const hooksPath = getHooksPath(scope);
      const hookScriptPath = path.join(skillDir, "hook_stop.js");
      configureHook(hooksPath, hookScriptPath);
      log(`✅ Configured Stop lifecycle hook in ${hooksPath}`);
    }

    const test = (await ask(rl, "\nSend a test message to Discord now? [Y/n] "))
      .toLowerCase();
    if (test === "" || test === "y" || test === "yes") {
      try {
        await sendTest(webhookUrl);
        log("✅ Test message sent — check your Discord channel.");
      } catch (e) {
        log(`⚠️  Test send failed: ${e.message}`);
        log("   Double-check the webhook URL and re-run: npx agy-discord-notify");
      }
    }

    log("");
    log("Done! In Antigravity, just say things like:");
    log('  "notify me on discord when the build finishes"');
    log('  "send that summary and diff to my discord"');
    log('  "/goal refactor auth and ping my discord channel when done"');
    log("");
  } finally {
    rl.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    stderr_write(`error: ${e.message || e}`);
    process.exit(1);
  });
}

export {
  promptScope,
  promptWebhook,
  promptNamedWebhooks,
  promptHook,
  buildConfig,
  install,
  configureHook,
  mask,
  getSkillDir,
  getHooksPath,
  WEBHOOK_RE,
  NAME_RE,
};
