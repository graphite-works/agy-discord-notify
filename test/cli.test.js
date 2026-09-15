import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  promptNamedWebhooks,
  buildConfig,
  configureHook,
  mask,
  getSkillDir,
  getHooksPath,
  WEBHOOK_RE,
  NAME_RE,
} from "../bin/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_JS = path.join(__dirname, "..", "bin", "cli.js");

const VALID_URL =
  "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-1234567890";
const VALID_URL_2 =
  "https://discord.com/api/webhooks/987654321098765432/ZyXwVuTsRqPoNmLkJiHgFeDcBa-0987654321";
const VALID_URL_3 =
  "https://discord.com/api/webhooks/111111111111111111/CcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";
const VALID_URL_4 =
  "https://discord.com/api/webhooks/222222222222222222/DdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd";

/** A fake readline interface: `.question()` pops the next scripted answer. */
function fakeRl(answers) {
  const queue = [...answers];
  return {
    question: async () => {
      if (!queue.length) throw new Error("fakeRl: ran out of scripted answers");
      return queue.shift();
    },
  };
}

describe("buildConfig", () => {
  test("omits the webhooks key entirely when there are no named webhooks", () => {
    assert.deepEqual(buildConfig(VALID_URL), { webhookUrl: VALID_URL });
    assert.deepEqual(buildConfig(VALID_URL, {}), { webhookUrl: VALID_URL });
  });

  test("includes the webhooks key when non-empty", () => {
    assert.deepEqual(buildConfig(VALID_URL, { work: VALID_URL_2 }), {
      webhookUrl: VALID_URL,
      webhooks: { work: VALID_URL_2 },
    });
  });
});

describe("mask", () => {
  test("masks the token portion of a webhook URL, leaving the id visible", () => {
    assert.equal(
      mask("https://discord.com/api/webhooks/123/AbCdEfGhIjKl"),
      "https://discord.com/api/webhooks/123/AbCd…IjKl"
    );
  });
});

describe("WEBHOOK_RE", () => {
  test("accepts valid discord.com / discordapp.com / canary / ptb webhook URLs", () => {
    assert.ok(WEBHOOK_RE.test(VALID_URL));
    assert.ok(WEBHOOK_RE.test("https://canary.discordapp.com/api/webhooks/1/abc-def"));
    assert.ok(WEBHOOK_RE.test("https://ptb.discord.com/api/v10/webhooks/1/abc_def"));
  });

  test("rejects non-webhook URLs and non-URLs", () => {
    assert.ok(!WEBHOOK_RE.test("not-a-url"));
    assert.ok(!WEBHOOK_RE.test("http://discord.com/api/webhooks/1/abc")); // http, not https
    assert.ok(!WEBHOOK_RE.test("https://evil.com/api/webhooks/1/abc"));
  });
});

describe("NAME_RE", () => {
  test("accepts letters, digits, underscore, hyphen", () => {
    assert.ok(NAME_RE.test("work"));
    assert.ok(NAME_RE.test("work-2_channel"));
    assert.ok(NAME_RE.test("ABC123"));
  });

  test("rejects spaces, symbols, and empty string", () => {
    assert.ok(!NAME_RE.test("bad name"));
    assert.ok(!NAME_RE.test("bad!"));
    assert.ok(!NAME_RE.test(""));
  });
});

describe("configureHook", () => {
  test("creates hooks.json with Stop event when none exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    try {
      const hooksPath = path.join(tmp, "hooks.json");
      const scriptPath = path.join(tmp, "hook_stop.js");
      configureHook(hooksPath, scriptPath);
      const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      assert.ok(parsed["discord-notify-on-stop"]);
      assert.equal(parsed["discord-notify-on-stop"].enabled, true);
      assert.equal(parsed["discord-notify-on-stop"].Stop[0].type, "command");
      assert.match(parsed["discord-notify-on-stop"].Stop[0].command, /hook_stop\.js/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("preserves existing hooks when configuring Stop hook", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    try {
      const hooksPath = path.join(tmp, "hooks.json");
      fs.writeFileSync(hooksPath, JSON.stringify({ "existing-hook": { enabled: true } }));
      const scriptPath = path.join(tmp, "hook_stop.js");
      configureHook(hooksPath, scriptPath);
      const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      assert.ok(parsed["existing-hook"]);
      assert.ok(parsed["discord-notify-on-stop"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("promptNamedWebhooks (scripted fake readline)", () => {
  test("declining via default-empty answer is a no-op, returns existing unchanged", async () => {
    const rl = fakeRl([""]);
    const result = await promptNamedWebhooks(rl, { work: VALID_URL });
    assert.deepEqual(result, { work: VALID_URL });
  });

  test("declining explicitly with 'n' when nothing exists yet returns {}", async () => {
    const rl = fakeRl(["n"]);
    const result = await promptNamedWebhooks(rl, {});
    assert.deepEqual(result, {});
  });

  test("accepting and adding one webhook", async () => {
    const rl = fakeRl(["y", "work", VALID_URL, "n"]);
    const result = await promptNamedWebhooks(rl, {});
    assert.deepEqual(result, { work: VALID_URL });
  });

  test("adding multiple webhooks in one session", async () => {
    const rl = fakeRl(["y", "work", VALID_URL, "y", "personal", VALID_URL_2, "n"]);
    const result = await promptNamedWebhooks(rl, {});
    assert.deepEqual(result, { work: VALID_URL, personal: VALID_URL_2 });
  });

  test("invalid name is rejected and re-prompted until valid", async () => {
    const rl = fakeRl(["y", "bad name!", "still bad!", "good-name", VALID_URL, "n"]);
    const result = await promptNamedWebhooks(rl, {});
    assert.deepEqual(result, { "good-name": VALID_URL });
  });

  test("invalid webhook URL is rejected and re-prompted until valid", async () => {
    const rl = fakeRl(["y", "work", "not-a-webhook-url", "still-not-one", VALID_URL, "n"]);
    const result = await promptNamedWebhooks(rl, {});
    assert.deepEqual(result, { work: VALID_URL });
  });

  test("re-using an existing name overwrites it; other names are preserved", async () => {
    const rl = fakeRl(["y", "work", VALID_URL_4, "n"]);
    const result = await promptNamedWebhooks(rl, {
      work: VALID_URL,
      personal: VALID_URL_3,
    });
    assert.deepEqual(result, { work: VALID_URL_4, personal: VALID_URL_3 });
  });
});

describe("bin/cli.js end-to-end (child process, scripted stdin, temp $HOME)", () => {
  function tempHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agy-discord-notify-cli-test-"));
  }

  function configPathFor(home) {
    return path.join(home, ".gemini", "config", "skills", "discord-notify", "config.json");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function runCli(home, inputLines, args = ["--global", "--no-hook"], cwd = home) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_JS, ...args], {
        cwd,
        env: { ...process.env, HOME: home },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));

      (async () => {
        for (const line of inputLines) {
          await sleep(40);
          child.stdin.write(line + "\n");
        }
        await sleep(40);
        child.stdin.end();
      })();
    });
  }

  test("fresh $HOME, no config: full decline leaves config.json with NO webhooks key", async () => {
    const home = tempHome();
    try {
      const { code } = await runCli(home, [VALID_URL, "n", "n"]);
      assert.equal(code, 0);
      const cfg = JSON.parse(fs.readFileSync(configPathFor(home), "utf8"));
      assert.deepEqual(cfg, { webhookUrl: VALID_URL });
      assert.equal("webhooks" in cfg, false);
      const mode = fs.statSync(configPathFor(home)).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("fresh $HOME, default-empty answer to the named-webhooks prompt also omits the key", async () => {
    const home = tempHome();
    try {
      const { code } = await runCli(home, [VALID_URL, "", "n"]);
      assert.equal(code, 0);
      const cfg = JSON.parse(fs.readFileSync(configPathFor(home), "utf8"));
      assert.deepEqual(cfg, { webhookUrl: VALID_URL });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("pre-existing single-webhookUrl config: pressing Enter keeps it unchanged (promptWebhook untouched)", async () => {
    const home = tempHome();
    const cfgPath = configPathFor(home);
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ webhookUrl: VALID_URL }));

      const { code, stdout } = await runCli(home, ["", "n", "n"]);
      assert.equal(code, 0);
      assert.match(stdout, /A webhook is already configured/);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.deepEqual(cfg, { webhookUrl: VALID_URL });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("re-running with existing named webhooks displays them masked and preserves ones not replaced", async () => {
    const home = tempHome();
    const cfgPath = configPathFor(home);
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          webhookUrl: VALID_URL,
          webhooks: { work: VALID_URL_2, personal: VALID_URL_3 },
        })
      );

      const { code, stdout } = await runCli(home, ["", "y", "work", VALID_URL_4, "n", "n"]);
      assert.equal(code, 0);
      assert.match(stdout, /Named webhooks already configured/);
      assert.match(stdout, /work:/);
      assert.match(stdout, /personal:/);
      assert.doesNotMatch(stdout, new RegExp(VALID_URL_2)); // masked, not raw
      assert.doesNotMatch(stdout, new RegExp(VALID_URL_3)); // masked, not raw

      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.deepEqual(cfg.webhooks, { work: VALID_URL_4, personal: VALID_URL_3 });
      assert.equal(cfg.webhookUrl, VALID_URL);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("corrupted config (webhooks is a string, not an object) falls back gracefully instead of crashing", async () => {
    const home = tempHome();
    const cfgPath = configPathFor(home);
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ webhookUrl: VALID_URL, webhooks: "not-an-object" })
      );

      const { code, stdout, stderr } = await runCli(home, ["", "n", "n"]);
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stdout, /Named webhooks already configured/);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.deepEqual(cfg, { webhookUrl: VALID_URL });
      assert.equal("webhooks" in cfg, false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("corrupted config (webhooks is null) falls back gracefully instead of crashing", async () => {
    const home = tempHome();
    const cfgPath = configPathFor(home);
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ webhookUrl: VALID_URL, webhooks: null }));

      const { code, stdout, stderr } = await runCli(home, ["", "n", "n"]);
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stdout, /Named webhooks already configured/);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.deepEqual(cfg, { webhookUrl: VALID_URL });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("corrupted config (webhooks is an array) is rejected by the guard and falls back to {}", async () => {
    const home = tempHome();
    const cfgPath = configPathFor(home);
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ webhookUrl: VALID_URL, webhooks: [VALID_URL_2] })
      );

      const { code, stderr } = await runCli(home, ["", "n", "n"]);
      assert.equal(code, 0, stderr);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.equal("webhooks" in cfg, false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("local workspace installation (--local) creates .agents/skills/discord-notify", async () => {
    const home = tempHome();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-workspace-"));
    try {
      const { code, stdout } = await runCli(
        home,
        [VALID_URL, "n", "n"],
        ["--local", "--no-hook"],
        workspace
      );
      assert.equal(code, 0);
      assert.match(stdout, /\.agents\/skills\/discord-notify/);
      const localCfgPath = path.join(workspace, ".agents", "skills", "discord-notify", "config.json");
      assert.ok(fs.existsSync(localCfgPath));
      const cfg = JSON.parse(fs.readFileSync(localCfgPath, "utf8"));
      assert.equal(cfg.webhookUrl, VALID_URL);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("hook installation (--hook) creates hooks.json with Stop hook", async () => {
    const home = tempHome();
    try {
      const { code, stdout } = await runCli(home, [VALID_URL, "n", "n"], ["--global", "--hook"]);
      assert.equal(code, 0);
      assert.match(stdout, /Configured Stop lifecycle hook/);
      const hooksPath = path.join(home, ".gemini", "config", "hooks.json");
      assert.ok(fs.existsSync(hooksPath));
      const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      assert.ok(hooks["discord-notify-on-stop"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
