#!/usr/bin/env node
/**
 * Antigravity Lifecycle Hook handler for the `Stop` event.
 *
 * Configured in `hooks.json` under the `Stop` event:
 * {
 *   "discord-notify-on-stop": {
 *     "Stop": [
 *       {
 *         "type": "command",
 *         "command": "node ~/.gemini/config/skills/discord-notify/hook_stop.js"
 *       }
 *     ]
 *   }
 * }
 *
 * When Antigravity completes an execution turn or task, it sends a JSON payload
 * to stdin. This script delivers a formatted Discord notification summarizing
 * the completion status, and responds with `{}` on stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { post, loadWebhook } from "./discord_send.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const parts = [];
  for await (const chunk of process.stdin) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

export function formatStopNotification(payload) {
  const reason = payload.terminationReason || "completed";
  const workspacePath = payload.workspacePaths?.[0] || "";
  const workspaceName = workspacePath ? path.basename(workspacePath) : "Active Workspace";
  const hasError = Boolean(payload.error || reason === "error");

  const title = hasError ? "⚠️ Antigravity Task Stopped" : "✅ Antigravity Task Finished";
  const color = hasError ? 0xed4245 : 0x57f287; // Red or Green

  const fields = [
    { name: "Workspace", value: workspaceName, inline: true },
    { name: "Reason", value: reason, inline: true },
  ];

  if (payload.error) {
    fields.push({
      name: "Error",
      value: String(payload.error).slice(0, 1000),
      inline: false,
    });
  }

  const embed = {
    title,
    color,
    fields,
    description: `Antigravity finished execution in \`${workspaceName}\`.`,
  };

  return { embed, workspaceName, reason };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rawStdin = await readStdin();

  let payload = {};
  if (rawStdin.trim()) {
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      payload = { terminationReason: "unknown", raw: rawStdin };
    }
  }

  const { embed } = formatStopNotification(payload);

  if (dryRun) {
    process.stderr.write(`[DRY RUN] Hook payload parsed:\n${JSON.stringify(embed, null, 2)}\n`);
    process.stdout.write("{}\n");
    return;
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const webhookUrl = loadWebhook();
      await post(webhookUrl, {
        username: "Antigravity",
        embeds: [embed],
        quiet: true, // Keep stop hooks quiet by default so they don't ring loud bells on every turn
      });
    }
  } catch (err) {
    // Hooks should never crash or break the agent loop; log to stderr
    process.stderr.write(`hook_stop error: ${err.message || err}\n`);
  }

  // Always output empty JSON object to stdout for Antigravity's hook protocol
  process.stdout.write("{}\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.stdout.write("{}\n");
    process.exit(0);
  });
}
