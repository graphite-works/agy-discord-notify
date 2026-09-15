import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { formatStopNotification } from "../skill/hook_stop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_STOP_JS = path.join(__dirname, "..", "skill", "hook_stop.js");

describe("formatStopNotification", () => {
  test("formats a successful task completion with green accent", () => {
    const payload = {
      executionNum: 1,
      terminationReason: "model_stop",
      error: "",
      fullyIdle: true,
      workspacePaths: ["/home/blake/project-alpha"],
    };

    const { embed, workspaceName, reason } = formatStopNotification(payload);
    assert.equal(workspaceName, "project-alpha");
    assert.equal(reason, "model_stop");
    assert.match(embed.title, /✅ Antigravity Task Finished/);
    assert.equal(embed.color, 0x57f287);
    assert.deepEqual(embed.fields, [
      { name: "Workspace", value: "project-alpha", inline: true },
      { name: "Reason", value: "model_stop", inline: true },
    ]);
  });

  test("formats an error termination with red accent and error field", () => {
    const payload = {
      executionNum: 2,
      terminationReason: "error",
      error: "Connection timed out during deploy",
      fullyIdle: true,
      workspacePaths: ["/home/blake/backend-api"],
    };

    const { embed, workspaceName } = formatStopNotification(payload);
    assert.equal(workspaceName, "backend-api");
    assert.match(embed.title, /⚠️ Antigravity Task Stopped/);
    assert.equal(embed.color, 0xed4245);
    assert.ok(embed.fields.some((f) => f.name === "Error" && f.value.includes("Connection timed out")));
  });

  test("handles empty workspace path gracefully", () => {
    const payload = {
      terminationReason: "model_stop",
    };

    const { embed, workspaceName } = formatStopNotification(payload);
    assert.equal(workspaceName, "Active Workspace");
    assert.match(embed.description, /Active Workspace/);
  });
});

describe("skill/hook_stop.js execution (child process)", () => {
  function runHook(inputJson, args = ["--dry-run"]) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [HOOK_STOP_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      child.stdin.write(inputJson);
      child.stdin.end();
    });
  }

  test("reads stdin JSON and outputs {} to stdout under --dry-run", async () => {
    const input = JSON.stringify({
      executionNum: 1,
      terminationReason: "model_stop",
      workspacePaths: ["/home/blake/my-app"],
    });

    const { code, stdout, stderr } = await runHook(input);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "{}");
    assert.match(stderr, /\[DRY RUN\] Hook payload parsed/);
    assert.match(stderr, /my-app/);
  });

  test("handles malformed stdin JSON gracefully without crashing", async () => {
    const { code, stdout } = await runHook("invalid-not-json{{{");
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "{}");
  });
});
