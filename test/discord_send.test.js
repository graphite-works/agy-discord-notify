import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import http from "node:http";
import {
  chunks,
  mimeFor,
  extFor,
  post,
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
} from "../skill/discord_send.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, "..", "skill");
const SEND_JS = path.join(SKILL_DIR, "discord_send.js");
const CONFIG_PATH = path.join(SKILL_DIR, "config.json");

describe("chunks", () => {
  test("returns a single chunk for short text", () => {
    assert.deepEqual(chunks("hello"), ["hello"]);
  });

  test("returns [''] for empty text", () => {
    assert.deepEqual(chunks(""), [""]);
  });

  test("packs multiple short lines into one chunk when they fit", () => {
    assert.deepEqual(chunks("a\nb\nc", 10), ["a\nb\nc"]);
  });

  test("splits on newline boundaries once the limit is exceeded", () => {
    const text = "a".repeat(10) + "\n" + "b".repeat(10);
    assert.deepEqual(chunks(text, 15), ["a".repeat(10), "b".repeat(10)]);
  });

  test("hard-splits a single line longer than the limit", () => {
    const line = "x".repeat(25);
    assert.deepEqual(chunks(line, 10), [
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
  });

  test("never produces a chunk longer than the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    for (const c of chunks(text, 20)) {
      assert.ok(c.length <= 20, `chunk exceeds limit: ${JSON.stringify(c)}`);
    }
  });

  test("defaults to Discord's 2000-char limit", () => {
    const text = "a".repeat(2500);
    const out = chunks(text);
    assert.equal(out.length, 2);
    assert.equal(out[0].length, 2000);
  });
});

describe("mimeFor", () => {
  test("maps known extensions", () => {
    assert.equal(mimeFor("shot.png"), "image/png");
    assert.equal(mimeFor("clip.mp4"), "video/mp4");
    assert.equal(mimeFor("notes.md"), "text/markdown");
  });

  test("is case-insensitive", () => {
    assert.equal(mimeFor("SHOT.PNG"), "image/png");
  });

  test("falls back to octet-stream for unknown or missing extensions", () => {
    assert.equal(mimeFor("archive.xyz"), "application/octet-stream");
    assert.equal(mimeFor("no-extension"), "application/octet-stream");
  });
});

describe("parseEmbedColor", () => {
  test("accepts #RRGGBB", () => {
    assert.equal(parseEmbedColor("#5865F2"), 0x5865f2);
  });

  test("accepts bare RRGGBB (no #)", () => {
    assert.equal(parseEmbedColor("5865F2"), 0x5865f2);
  });

  test("accepts a lowercase hex value", () => {
    assert.equal(parseEmbedColor("#abcdef"), 0xabcdef);
  });

  test("accepts a decimal integer within range", () => {
    assert.equal(parseEmbedColor("5793266"), 5793266);
  });

  test("accepts decimal 0", () => {
    assert.equal(parseEmbedColor("0"), 0);
  });

  test("accepts the decimal upper bound 16777215 (0xFFFFFF)", () => {
    assert.equal(parseEmbedColor("16777215"), 16777215);
  });

  test("rejects a decimal value one over the upper bound", () => {
    assert.equal(parseEmbedColor("16777216"), null);
  });

  test("rejects non-hex, non-decimal garbage", () => {
    assert.equal(parseEmbedColor("not-a-color"), null);
  });

  test("rejects a too-short hex value", () => {
    assert.equal(parseEmbedColor("#FFF"), null);
  });

  test("rejects a too-long hex value", () => {
    assert.equal(parseEmbedColor("#5865F2AA"), null);
  });

  test("rejects a negative number", () => {
    assert.equal(parseEmbedColor("-5"), null);
  });

  test("rejects an empty string", () => {
    assert.equal(parseEmbedColor(""), null);
  });
});

describe("parseEmbedField", () => {
  test("splits on the first '=' only", () => {
    assert.deepEqual(parseEmbedField("Key=a=b=c"), { name: "Key", value: "a=b=c" });
  });

  test("trims whitespace from both name and value", () => {
    assert.deepEqual(parseEmbedField("  Name  =  Value  "), { name: "Name", value: "Value" });
  });

  test("rejects input with no '='", () => {
    assert.equal(parseEmbedField("noequalshere"), null);
  });

  test("rejects an empty name", () => {
    assert.equal(parseEmbedField("=value"), null);
  });

  test("rejects a whitespace-only name (empty after trim)", () => {
    assert.equal(parseEmbedField("   =value"), null);
  });

  test("rejects an empty value", () => {
    assert.equal(parseEmbedField("name="), null);
  });

  test("rejects a whitespace-only value (empty after trim)", () => {
    assert.equal(parseEmbedField("name=   "), null);
  });
});

describe("formatEmbedColor", () => {
  test("formats hex (uppercase, zero-padded) alongside decimal", () => {
    assert.equal(formatEmbedColor(0x5865f2), "#5865F2 (5793266)");
    assert.equal(formatEmbedColor(0), "#000000 (0)");
    assert.equal(formatEmbedColor(255), "#0000FF (255)");
    assert.equal(formatEmbedColor(16777215), "#FFFFFF (16777215)");
  });
});

describe("buildEmbed (pure, unit — valid inputs; fail()-triggering invalid inputs are tested via child process below)", () => {
  test("returns null when nothing embed-related was provided", () => {
    assert.equal(buildEmbed({}), null);
    assert.equal(buildEmbed(), null);
    assert.equal(buildEmbed({ fields: [] }), null);
  });

  test("builds only the provided keys, omitting absent ones", () => {
    assert.deepEqual(buildEmbed({ title: "T" }), { title: "T" });
    assert.deepEqual(buildEmbed({ description: "D" }), { description: "D" });
    assert.deepEqual(buildEmbed({ color: 123 }), { color: 123 });
  });

  test("fields alone (no title/description/color) still counts as an embed request", () => {
    const fields = [{ name: "A", value: "B", inline: false }];
    assert.deepEqual(buildEmbed({ fields }), { fields });
  });

  test("builds the full shape when title/description/color/fields are all given", () => {
    const fields = [{ name: "A", value: "B", inline: true }];
    assert.deepEqual(buildEmbed({ title: "T", description: "D", color: 5793266, fields }), {
      title: "T",
      description: "D",
      color: 5793266,
      fields,
    });
  });

  test("color: 0 is a valid, provided value (not treated as absent)", () => {
    assert.deepEqual(buildEmbed({ color: 0 }), { color: 0 });
  });

  test("exactly EMBED_TITLE_MAX chars is accepted, not rejected", () => {
    const title = "a".repeat(EMBED_TITLE_MAX);
    assert.deepEqual(buildEmbed({ title }), { title });
  });

  test("exactly EMBED_DESCRIPTION_MAX chars is accepted, not rejected", () => {
    const description = "b".repeat(EMBED_DESCRIPTION_MAX);
    assert.deepEqual(buildEmbed({ description }), { description });
  });

  test("exactly EMBED_FIELDS_MAX fields is accepted, not rejected", () => {
    const fields = Array.from({ length: EMBED_FIELDS_MAX }, (_, i) => ({
      name: `n${i}`,
      value: `v${i}`,
      inline: false,
    }));
    assert.deepEqual(buildEmbed({ fields }), { fields });
  });
});

describe("extFor", () => {
  test("finds an extension for a known mime type", () => {
    assert.equal(extFor("image/png"), ".png");
  });

  test("returns '' for an unknown mime type", () => {
    assert.equal(extFor("application/x-nonsense"), "");
  });
});

describe("post retry/backoff", () => {
  const originalFetch = global.fetch;

  function mockFetch(responses) {
    const calls = [];
    let i = 0;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    };
    return calls;
  }

  function res({ ok, status = 200, statusText = "", bodyText = "", retryAfter } = {}) {
    return {
      ok,
      status,
      statusText,
      text: async () => bodyText,
      headers: {
        get: (name) =>
          name.toLowerCase() === "retry-after" ? retryAfter ?? null : null,
      },
    };
  }

  test("resolves without retrying on success", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi" });
    assert.equal(calls.length, 1);
  });

  test("retries a 429 using the JSON retry_after and then succeeds", async (t) => {
    const calls = mockFetch([
      res({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        bodyText: JSON.stringify({ retry_after: 0.01, global: false }),
      }),
      res({ ok: true, status: 204 }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi" });
    assert.equal(calls.length, 2);
  });

  test("retries a 5xx using the Retry-After header and then succeeds", async (t) => {
    const calls = mockFetch([
      res({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        retryAfter: "0",
      }),
      res({ ok: true, status: 204 }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi" });
    assert.equal(calls.length, 2);
  });

  test("does not retry a non-retryable 4xx error", async (t) => {
    const calls = mockFetch([
      res({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        bodyText: "bad payload",
      }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await assert.rejects(
      () => post("https://example.com/webhook", { content: "hi" }),
      /HTTP 400 Bad Request bad payload/
    );
    assert.equal(calls.length, 1);
  });

  test("gives up after exhausting retries and reports the final error", async (t) => {
    const calls = mockFetch([
      res({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        bodyText: JSON.stringify({ retry_after: 0.001 }),
      }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await assert.rejects(
      () => post("https://example.com/webhook", { content: "hi" }),
      new RegExp(`HTTP 429.*gave up after ${MAX_RETRIES} retries`, "s")
    );
    assert.equal(calls.length, MAX_RETRIES + 1);
  });
});

describe("allowed_mentions", () => {
  const originalFetch = global.fetch;

  function mockFetch(responses) {
    const calls = [];
    let i = 0;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    };
    return calls;
  }

  function res({ ok, status = 200, statusText = "", bodyText = "" } = {}) {
    return {
      ok,
      status,
      statusText,
      text: async () => bodyText,
      headers: { get: () => null },
    };
  }

  test("JSON body sends allowed_mentions: { parse: [] } alongside content", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hey @everyone" });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.content, "hey @everyone");
    assert.deepEqual(body.allowed_mentions, { parse: [] });
  });

  test("multipart payload_json also carries allowed_mentions: { parse: [] }", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", {
      content: "hey <@&123> <@456>",
      files: [{ name: "a.txt", type: "text/plain", data: Buffer.from("hi") }],
    });
    assert.equal(calls.length, 1);
    const form = calls[0].init.body;
    const payload = JSON.parse(form.get("payload_json"));
    assert.equal(payload.content, "hey <@&123> <@456>");
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  });

  test("every chunk of a multi-chunk (>2000 char) message carries allowed_mentions", async (t) => {
    // Respond ok to any number of calls.
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return res({ ok: true, status: 204 });
    };
    t.after(() => {
      global.fetch = originalFetch;
    });

    // Build a message well over Discord's 2000-char limit, with an
    // @everyone mention thrown into a later line so it's not just the
    // first chunk that matters.
    const lines = [];
    for (let i = 0; i < 400; i++) {
      lines.push(i === 250 ? "@everyone line " + i : "line " + i + " ".repeat(5));
    }
    const longText = lines.join("\n");
    const parts = chunks(longText);
    assert.ok(parts.length > 1, "test setup should produce multiple chunks");

    // Mirror how main() drives post() across chunks: one post per chunk,
    // files only attached to the final one.
    const files = [{ name: "a.txt", type: "text/plain", data: Buffer.from("hi") }];
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await post("https://example.com/webhook", {
        content: parts[i],
        files: last ? files : [],
      });
    }

    assert.equal(calls.length, parts.length);
    assert.ok(calls.length > 1, "expected more than one post() call");
    for (const [idx, call] of calls.entries()) {
      const isMultipart = call.init.body instanceof FormData;
      const payload = isMultipart
        ? JSON.parse(call.init.body.get("payload_json"))
        : JSON.parse(call.init.body);
      assert.deepEqual(
        payload.allowed_mentions,
        { parse: [] },
        `chunk ${idx} missing allowed_mentions`
      );
    }
  });

  test("attachment-only send (no content at all) still carries allowed_mentions", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", {
      files: [{ name: "shot.png", type: "image/png", data: Buffer.from("fakepng") }],
      content: undefined,
    });
    assert.equal(calls.length, 1);
    const form = calls[0].init.body;
    const payload = JSON.parse(form.get("payload_json"));
    assert.equal("content" in payload, false, "no content key should be set");
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  });
});

describe("quiet / --quiet / --silent (SUPPRESS_NOTIFICATIONS flag)", () => {
  const originalFetch = global.fetch;

  function mockFetch(responses) {
    const calls = [];
    let i = 0;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    };
    return calls;
  }

  function res({ ok, status = 200, statusText = "", bodyText = "", retryAfter } = {}) {
    return {
      ok,
      status,
      statusText,
      text: async () => bodyText,
      headers: {
        get: (name) =>
          name.toLowerCase() === "retry-after" ? retryAfter ?? null : null,
      },
    };
  }

  test("quiet: true sets payload.flags = 4096 on the JSON body path", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi", quiet: true });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.flags, 4096);
  });

  test("quiet: true sets payload.flags = 4096 on the multipart payload_json path", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", {
      content: "hi",
      quiet: true,
      files: [{ name: "a.txt", type: "text/plain", data: Buffer.from("hi") }],
    });
    assert.equal(calls.length, 1);
    const form = calls[0].init.body;
    const payload = JSON.parse(form.get("payload_json"));
    assert.equal(payload.flags, 4096);
  });

  test("quiet omitted or false: no flags key at all (not flags: 0)", async (t) => {
    const calls = mockFetch([
      res({ ok: true, status: 204 }),
      res({ ok: true, status: 204 }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi" });
    await post("https://example.com/webhook", { content: "hi", quiet: false });
    for (const call of calls) {
      const body = JSON.parse(call.init.body);
      assert.equal("flags" in body, false, "flags key should not be present");
    }
  });

  test("every chunk of a multi-chunk (>2000 char) message carries flags: 4096 when quiet", async (t) => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return res({ ok: true, status: 204 });
    };
    t.after(() => {
      global.fetch = originalFetch;
    });

    const lines = [];
    for (let i = 0; i < 400; i++) {
      lines.push("line " + i + " ".repeat(5));
    }
    const longText = lines.join("\n");
    const parts = chunks(longText);
    assert.ok(parts.length > 1, "test setup should produce multiple chunks");

    const files = [{ name: "a.txt", type: "text/plain", data: Buffer.from("hi") }];
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await post("https://example.com/webhook", {
        content: parts[i],
        files: last ? files : [],
        quiet: true,
      });
    }

    assert.equal(calls.length, parts.length);
    assert.ok(calls.length > 1, "expected more than one post() call");
    for (const [idx, call] of calls.entries()) {
      const isMultipart = call.init.body instanceof FormData;
      const payload = isMultipart
        ? JSON.parse(call.init.body.get("payload_json"))
        : JSON.parse(call.init.body);
      assert.equal(payload.flags, 4096, `chunk ${idx} missing flags: 4096`);
    }
  });

  test("retry path preserves quiet: mock a 429 then success, both calls carry the flag", async (t) => {
    const calls = mockFetch([
      res({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        bodyText: JSON.stringify({ retry_after: 0.01, global: false }),
      }),
      res({ ok: true, status: 204 }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi", quiet: true });
    assert.equal(calls.length, 2);
    for (const [idx, call] of calls.entries()) {
      const body = JSON.parse(call.init.body);
      assert.equal(body.flags, 4096, `retry call ${idx} lost the quiet flag`);
    }
  });
});

describe("post() embeds param", () => {
  const originalFetch = global.fetch;
  const embed = { title: "Build passed", color: 5793266 };

  function mockFetch(responses) {
    const calls = [];
    let i = 0;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    };
    return calls;
  }

  function res({ ok, status = 200, statusText = "", bodyText = "", retryAfter } = {}) {
    return {
      ok,
      status,
      statusText,
      text: async () => bodyText,
      headers: {
        get: (name) => (name.toLowerCase() === "retry-after" ? retryAfter ?? null : null),
      },
    };
  }

  test("non-empty embeds sets payload.embeds on the JSON body path", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi", embeds: [embed] });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.embeds, [embed]);
  });

  test("non-empty embeds sets payload.embeds on the multipart payload_json path", async (t) => {
    const calls = mockFetch([res({ ok: true, status: 204 })]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", {
      content: "hi",
      embeds: [embed],
      files: [{ name: "a.txt", type: "text/plain", data: Buffer.from("hi") }],
    });
    assert.equal(calls.length, 1);
    const form = calls[0].init.body;
    const payload = JSON.parse(form.get("payload_json"));
    assert.deepEqual(payload.embeds, [embed]);
  });

  test("empty embeds ([] or omitted) omits the embeds key entirely, never `embeds: []`", async (t) => {
    const calls = mockFetch([
      res({ ok: true, status: 204 }),
      res({ ok: true, status: 204 }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi", embeds: [] });
    await post("https://example.com/webhook", { content: "hi" });
    for (const call of calls) {
      const body = JSON.parse(call.init.body);
      assert.equal("embeds" in body, false, "embeds key should not be present");
    }
  });

  test("retry path preserves embeds: mock a 429 then success, both calls carry the embed", async (t) => {
    const calls = mockFetch([
      res({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        bodyText: JSON.stringify({ retry_after: 0.01, global: false }),
      }),
      res({ ok: true, status: 204 }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi", embeds: [embed] });
    assert.equal(calls.length, 2);
    for (const [idx, call] of calls.entries()) {
      const body = JSON.parse(call.init.body);
      assert.deepEqual(body.embeds, [embed], `retry call ${idx} lost the embed`);
    }
  });

  test("embeds compose with quiet: true — both flags and embeds present on the retried call", async (t) => {
    const calls = mockFetch([
      res({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        retryAfter: "0",
      }),
      res({ ok: true, status: 204 }),
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });
    await post("https://example.com/webhook", { content: "hi", embeds: [embed], quiet: true });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const body = JSON.parse(call.init.body);
      assert.equal(body.flags, 4096);
      assert.deepEqual(body.embeds, [embed]);
    }
  });

  test("multi-chunk send: the embed is attached to the final chunk's post() call only", async (t) => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return res({ ok: true, status: 204 });
    };
    t.after(() => {
      global.fetch = originalFetch;
    });

    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ` + " ".repeat(5));
    const parts = chunks(lines.join("\n"));
    assert.ok(parts.length > 1, "test setup should produce multiple chunks");

    // Mirror how main() drives post() across chunks: embeds only on the
    // final chunk, same as files.
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await post("https://example.com/webhook", {
        content: parts[i],
        embeds: last ? [embed] : [],
      });
    }

    assert.equal(calls.length, parts.length);
    calls.slice(0, -1).forEach((call, idx) => {
      const body = JSON.parse(call.init.body);
      assert.equal("embeds" in body, false, `chunk ${idx} (not last) should not carry the embed`);
    });
    const lastBody = JSON.parse(calls[calls.length - 1].init.body);
    assert.deepEqual(lastBody.embeds, [embed]);
  });
});

describe("MAX_ATTACHMENT_BYTES", () => {
  test("is Discord's 8MB combined webhook attachment limit", () => {
    assert.equal(MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024);
    assert.equal(MAX_ATTACHMENT_BYTES, 8388608);
  });
});

describe("totalFileBytes", () => {
  test("returns 0 for an empty array", () => {
    assert.equal(totalFileBytes([]), 0);
  });

  test("returns a single file's byte length", () => {
    const files = [{ name: "a.txt", type: "text/plain", data: Buffer.alloc(1234) }];
    assert.equal(totalFileBytes(files), 1234);
  });

  test("sums byte lengths across multiple files", () => {
    const files = [
      { name: "a.txt", type: "text/plain", data: Buffer.alloc(100) },
      { name: "b.txt", type: "text/plain", data: Buffer.alloc(250) },
      { name: "c.txt", type: "text/plain", data: Buffer.alloc(3) },
    ];
    assert.equal(totalFileBytes(files), 353);
  });

  test("several files each under the limit can still sum over it", () => {
    // Three 3MB files: each is comfortably under MAX_ATTACHMENT_BYTES (8MB)
    // individually, but their combined total (9MB) is not.
    const threeMB = 3 * 1024 * 1024;
    const files = [
      { name: "a.bin", type: "application/octet-stream", data: Buffer.alloc(threeMB) },
      { name: "b.bin", type: "application/octet-stream", data: Buffer.alloc(threeMB) },
      { name: "c.bin", type: "application/octet-stream", data: Buffer.alloc(threeMB) },
    ];
    const total = totalFileBytes(files);
    assert.ok(files.every((f) => f.data.length < MAX_ATTACHMENT_BYTES));
    assert.ok(total > MAX_ATTACHMENT_BYTES, "combined total should exceed the limit");
    assert.equal(total, 3 * threeMB);
  });
});

describe("formatBytes", () => {
  test("formats exactly the 8MB limit as 8.00MB", () => {
    assert.equal(formatBytes(MAX_ATTACHMENT_BYTES), "8.00MB");
  });

  test("formats an arbitrary byte count to 2 decimal places", () => {
    assert.equal(formatBytes(9 * 1024 * 1024), "9.00MB");
    assert.equal(formatBytes(0), "0.00MB");
    assert.equal(formatBytes(1.5 * 1024 * 1024), "1.50MB");
  });
});

describe("attachment size limit end-to-end (child process)", () => {
  // These spawn the real CLI as a subprocess so we can exercise main()
  // (which calls fail() -> process.exit(1)) without killing the test
  // runner itself. A webhook URL that nothing listens on lets us tell
  // "the size check rejected this before any network call" apart from
  // "post() ran and the network call failed" — the latter would surface
  // a completely different error (a connection failure), not our
  // "attachments too large" message, and would take a beat rather than
  // failing immediately.
  const UNREACHABLE_WEBHOOK = "http://127.0.0.1:1/webhook";
  let hadExistingConfig = false;
  let existingConfigContents = "";

  function writeConfig() {
    hadExistingConfig = fs.existsSync(CONFIG_PATH);
    if (hadExistingConfig) existingConfigContents = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ webhookUrl: UNREACHABLE_WEBHOOK }));
  }

  function restoreConfig() {
    if (hadExistingConfig) fs.writeFileSync(CONFIG_PATH, existingConfigContents);
    else fs.rmSync(CONFIG_PATH, { force: true });
  }

  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [SEND_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      // No stdin is scripted for these tests. Some argument combinations
      // (e.g. no message/no --file) make main() fall back to reading
      // stdin; without closing it here that read blocks forever since
      // execFile never sends EOF on its own.
      child.stdin.end();
    });
  }

  test("rejects combined-oversized attachments before making any network request", async (t) => {
    writeConfig();
    const tmpA = path.join(__dirname, "tmp-oversized-a.bin");
    const tmpB = path.join(__dirname, "tmp-oversized-b.bin");
    fs.writeFileSync(tmpA, Buffer.alloc(5 * 1024 * 1024));
    fs.writeFileSync(tmpB, Buffer.alloc(4 * 1024 * 1024));
    t.after(() => {
      restoreConfig();
      fs.rmSync(tmpA, { force: true });
      fs.rmSync(tmpB, { force: true });
    });

    const { code, stderr } = await run(["--file", tmpA, "--file", tmpB, "too big"]);
    assert.equal(code, 1);
    assert.match(stderr, /attachments too large: 9\.00MB combined/);
    assert.match(stderr, /Discord's webhook limit is 8\.00MB per message/);
  });

  test("does not reject attachments at/under the combined limit for size reasons", async (t) => {
    writeConfig();
    const tmpA = path.join(__dirname, "tmp-ok-a.bin");
    fs.writeFileSync(tmpA, Buffer.alloc(1 * 1024 * 1024));
    t.after(() => {
      restoreConfig();
      fs.rmSync(tmpA, { force: true });
    });

    const { stderr } = await run(["--file", tmpA, "small enough"]);
    // The (unreachable) webhook will still make the send itself fail, but
    // it must fail for a network reason, never our size-limit message.
    assert.doesNotMatch(stderr, /attachments too large/);
  });

  test("pre-existing MAX_FILES (count) check still fires independently for >10 files", async (t) => {
    writeConfig();
    t.after(() => {
      restoreConfig();
    });

    const args = [];
    for (let i = 0; i < 11; i++) args.push("--file", "does-not-need-to-exist.txt");
    args.push("too many");
    const { code, stderr } = await run(args);
    assert.equal(code, 1);
    assert.match(stderr, /too many attachments: 11/);
    assert.doesNotMatch(stderr, /attachments too large/);
  });

  // Gap flagged by dev: the check uses strict `>`, not `>=`, so a combined
  // total of exactly MAX_ATTACHMENT_BYTES must NOT trigger the error, while
  // one byte over must. Verify both sides of that boundary explicitly
  // rather than only "well under" (1MB) and "well over" (9MB) cases.
  test("boundary: exactly MAX_ATTACHMENT_BYTES combined (split across files) is not rejected", async (t) => {
    writeConfig();
    const half = MAX_ATTACHMENT_BYTES / 2;
    const tmpA = path.join(__dirname, "tmp-boundary-exact-a.bin");
    const tmpB = path.join(__dirname, "tmp-boundary-exact-b.bin");
    fs.writeFileSync(tmpA, Buffer.alloc(half));
    fs.writeFileSync(tmpB, Buffer.alloc(MAX_ATTACHMENT_BYTES - half));
    t.after(() => {
      restoreConfig();
      fs.rmSync(tmpA, { force: true });
      fs.rmSync(tmpB, { force: true });
    });

    const { stderr } = await run(["--file", tmpA, "--file", tmpB, "exactly at the limit"]);
    // Must fail for a network reason (unreachable webhook), never our
    // size-limit message.
    assert.doesNotMatch(stderr, /attachments too large/);
  });

  test("boundary: one byte over MAX_ATTACHMENT_BYTES combined is rejected", async (t) => {
    writeConfig();
    const tmpA = path.join(__dirname, "tmp-boundary-over-a.bin");
    fs.writeFileSync(tmpA, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    t.after(() => {
      restoreConfig();
      fs.rmSync(tmpA, { force: true });
    });

    const { code, stderr } = await run(["--file", tmpA, "one byte over the limit"]);
    assert.equal(code, 1);
    assert.match(stderr, /attachments too large: 8\.00MB combined/);
  });
});

describe("webhook resolution (--to)", () => {
  // loadWebhook() calls fail() -> process.exit(1) on error paths, which
  // would kill the whole test runner if called in-process. As with the
  // attachment-size e2e tests above, drive these through a real child
  // process instead.
  let hadExistingConfig = false;
  let existingConfigContents = "";

  function writeConfig(cfg) {
    hadExistingConfig = fs.existsSync(CONFIG_PATH);
    if (hadExistingConfig) existingConfigContents = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  }

  function restoreConfig() {
    if (hadExistingConfig) fs.writeFileSync(CONFIG_PATH, existingConfigContents);
    else fs.rmSync(CONFIG_PATH, { force: true });
  }

  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [SEND_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      // No stdin is scripted for these tests. Some argument combinations
      // (e.g. no message/no --file) make main() fall back to reading
      // stdin; without closing it here that read blocks forever since
      // execFile never sends EOF on its own.
      child.stdin.end();
    });
  }

  function serve() {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ url: req.url, body });
        res.writeHead(204);
        res.end();
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
    });
  }

  const UNREACHABLE = "http://127.0.0.1:1/webhook";

  test("no --to resolves to webhookUrl even when webhooks is absent", async (t) => {
    writeConfig({ webhookUrl: UNREACHABLE });
    t.after(restoreConfig);
    const { stderr } = await run(["hello"]);
    // Fails for a network reason (unreachable), never a "no webhook named" error.
    assert.doesNotMatch(stderr, /no webhook named/);
  });

  test("no --to resolves to webhookUrl even when webhooks is present", async (t) => {
    writeConfig({ webhookUrl: UNREACHABLE, webhooks: { work: UNREACHABLE } });
    t.after(restoreConfig);
    const { stderr } = await run(["hello"]);
    assert.doesNotMatch(stderr, /no webhook named/);
  });

  test("--to <configured-name> resolves to that webhook and posts there", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    const namedUrl = `http://127.0.0.1:${port}/webhook`;
    writeConfig({ webhookUrl: UNREACHABLE, webhooks: { work: namedUrl } });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stdout, stderr } = await run(["--to", "work", "hi team"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /sent message to Discord/);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.content, "hi team");
  });

  test("--to <unconfigured-name> fails with available names listed, no network call", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({
      webhookUrl: `http://127.0.0.1:${port}/webhook`,
      webhooks: { work: `http://127.0.0.1:${port}/webhook`, personal: `http://127.0.0.1:${port}/webhook` },
    });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stderr } = await run(["--to", "bogus", "hi"]);
    assert.equal(code, 1);
    assert.match(
      stderr,
      /no webhook named "bogus" in config\.json \(available: work, personal — or omit --to for the default\)/
    );
    assert.equal(requests.length, 0);
  });

  test("--to <name> fails with a no-named-webhooks message when webhooks is absent", async (t) => {
    writeConfig({ webhookUrl: UNREACHABLE });
    t.after(restoreConfig);
    const { code, stderr } = await run(["--to", "bogus", "hi"]);
    assert.equal(code, 1);
    assert.match(
      stderr,
      /no webhook named "bogus" in config\.json \(no named webhooks configured — only the default is available; add one via: npx agy-discord-notify\)/
    );
  });

  test("--to <name> fails the same way when webhooks is present but empty", async (t) => {
    writeConfig({ webhookUrl: UNREACHABLE, webhooks: {} });
    t.after(restoreConfig);
    const { code, stderr } = await run(["--to", "bogus", "hi"]);
    assert.equal(code, 1);
    assert.match(stderr, /no named webhooks configured/);
  });

  test("--to with no following argument fails immediately", async (t) => {
    writeConfig({ webhookUrl: UNREACHABLE });
    t.after(restoreConfig);
    const { code, stderr } = await run(["hello", "--to"]);
    assert.equal(code, 1);
    assert.match(stderr, /--to needs a webhook name/);
  });
});

describe("--quiet / --silent CLI flag parsing and composition", () => {
  // End-to-end through the real CLI (child process) so we exercise main()'s
  // actual arg-parsing loop, not just post() directly.
  let hadExistingConfig = false;
  let existingConfigContents = "";

  function writeConfig(cfg) {
    hadExistingConfig = fs.existsSync(CONFIG_PATH);
    if (hadExistingConfig) existingConfigContents = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  }

  function restoreConfig() {
    if (hadExistingConfig) fs.writeFileSync(CONFIG_PATH, existingConfigContents);
    else fs.rmSync(CONFIG_PATH, { force: true });
  }

  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [SEND_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      // No stdin is scripted for these tests. Some argument combinations
      // (e.g. no message/no --file) make main() fall back to reading
      // stdin; without closing it here that read blocks forever since
      // execFile never sends EOF on its own.
      child.stdin.end();
    });
  }

  function serve() {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ url: req.url, body });
        res.writeHead(204);
        res.end();
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
    });
  }

  test("--quiet does not consume the following argument as a value", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stderr } = await run(["--quiet", "hello there"]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.content, "hello there");
    assert.equal(payload.flags, 4096);
  });

  test("--silent is accepted as an alias and also sets flags: 4096", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stderr } = await run(["--silent", "hush"]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.content, "hush");
    assert.equal(payload.flags, 4096);
  });

  test("without --quiet/--silent: no flags key present (unchanged default behavior)", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stderr } = await run(["plain message"]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body);
    assert.equal("flags" in payload, false);
  });

  test("--quiet parses correctly before other flags/message text", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stderr } = await run(["--quiet", "--username", "Bot", "msg"]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.content, "msg");
    assert.equal(payload.username, "Bot");
    assert.equal(payload.flags, 4096);
  });

  test("--quiet parses correctly after other flags, before message text", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stderr } = await run(["--username", "Bot", "--quiet", "msg"]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.content, "msg");
    assert.equal(payload.username, "Bot");
    assert.equal(payload.flags, 4096);
  });

  test("--quiet composes with --to, --username, and --file", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    const namedUrl = `http://127.0.0.1:${port}/webhook`;
    writeConfig({ webhookUrl: "http://127.0.0.1:1/unreachable", webhooks: { work: namedUrl } });

    const tmpFile = path.join(__dirname, "tmp-quiet-compose.txt");
    fs.writeFileSync(tmpFile, "attachment contents");
    t.after(() => {
      restoreConfig();
      server.close();
      fs.rmSync(tmpFile, { force: true });
    });

    const { code, stderr } = await run([
      "--to",
      "work",
      "--username",
      "Bot",
      "--file",
      tmpFile,
      "--quiet",
      "composed message",
    ]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
    // Multipart request: parse the multipart body for payload_json's flags.
    assert.match(requests[0].body, /"flags":4096/);
    assert.match(requests[0].body, /"username":"Bot"/);
    assert.match(requests[0].body, /composed message/);
  });

  test("--quiet composes with a multi-chunk message: every chunk carries flags: 4096", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const longMsg = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const { code, stderr } = await run(["--quiet", longMsg]);
    assert.equal(code, 0, stderr);
    assert.ok(requests.length > 1, "expected more than one chunked request");
    for (const [idx, r] of requests.entries()) {
      const payload = JSON.parse(r.body);
      assert.equal(payload.flags, 4096, `chunk ${idx} missing flags: 4096`);
    }
  });
});

describe("attachment size limit applies to URL-sourced attachments", () => {
  // Same idea as the local-file e2e tests above, but the size-contributing
  // attachment comes from an http(s) URL via loadFile()'s fetch path
  // instead of fs.readFileSync. Uses a tiny local HTTP server rather than
  // a real external host so the test doesn't depend on network access or
  // a third-party URL staying up.
  const UNREACHABLE_WEBHOOK = "http://127.0.0.1:1/webhook";
  let hadExistingConfig = false;
  let existingConfigContents = "";

  function writeConfig() {
    hadExistingConfig = fs.existsSync(CONFIG_PATH);
    if (hadExistingConfig) existingConfigContents = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ webhookUrl: UNREACHABLE_WEBHOOK }));
  }

  function restoreConfig() {
    if (hadExistingConfig) fs.writeFileSync(CONFIG_PATH, existingConfigContents);
    else fs.rmSync(CONFIG_PATH, { force: true });
  }

  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [SEND_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      // No stdin is scripted for these tests. Some argument combinations
      // (e.g. no message/no --file) make main() fall back to reading
      // stdin; without closing it here that read blocks forever since
      // execFile never sends EOF on its own.
      child.stdin.end();
    });
  }

  function serve(body) {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
      });
      res.end(body);
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  test("a URL attachment counts toward the combined limit (rejected before reaching the webhook)", async (t) => {
    writeConfig();
    const urlBody = Buffer.alloc(6 * 1024 * 1024);
    const server = await serve(urlBody);
    const port = server.address().port;
    const fileUrl = `http://127.0.0.1:${port}/big.bin`;

    const tmpLocal = path.join(__dirname, "tmp-url-combo-local.bin");
    fs.writeFileSync(tmpLocal, Buffer.alloc(3 * 1024 * 1024)); // 6MB (url) + 3MB (local) = 9MB > 8MB

    t.after(() => {
      restoreConfig();
      fs.rmSync(tmpLocal, { force: true });
      server.close();
    });

    const { code, stderr } = await run([
      "--file",
      fileUrl,
      "--file",
      tmpLocal,
      "url plus local over the limit",
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /attachments too large: 9\.00MB combined/);
  });

  test("a URL attachment under the limit is not rejected for size", async (t) => {
    writeConfig();
    const urlBody = Buffer.alloc(1 * 1024 * 1024);
    const server = await serve(urlBody);
    const port = server.address().port;
    const fileUrl = `http://127.0.0.1:${port}/small.bin`;

    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { stderr } = await run(["--file", fileUrl, "small url attachment"]);
    // Must fail (unreachable webhook) for a network reason, never ours.
    assert.doesNotMatch(stderr, /attachments too large/);
  });
});

describe("maskWebhookUrl", () => {
  test("masks the token portion of a webhook URL, leaving the id visible", () => {
    assert.equal(
      maskWebhookUrl("https://discord.com/api/webhooks/123/AbCdEfGhIjKl"),
      "https://discord.com/api/webhooks/123/AbCd…IjKl"
    );
  });
});

describe("buildDryRunReport (pure, unit)", () => {
  const WEBHOOK = "https://discord.com/api/webhooks/111111111111111111/SuperSecretToken1234567890";

  test("never contains the raw webhook URL, only the masked form", () => {
    const out = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      username: undefined,
      parts: ["hello"],
      files: [],
    });
    assert.doesNotMatch(out, /SuperSecretToken1234567890/);
    assert.match(out, /Supe…7890/);
  });

  test("target line shows 'default' when --to is omitted", () => {
    const out = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      parts: ["hi"],
      files: [],
    });
    assert.match(out, /target: default/);
  });

  test("target line shows the --to name when provided", () => {
    const out = buildDryRunReport({
      to: "work",
      webhookUrl: WEBHOOK,
      quiet: false,
      parts: ["hi"],
      files: [],
    });
    assert.match(out, /target: work/);
  });

  test("reports quiet/silent state and always notes allowed_mentions is active", () => {
    const quietOut = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: true,
      parts: ["hi"],
      files: [],
    });
    assert.match(quietOut, /quiet\/silent: ON/);
    assert.match(quietOut, /4096/);
    assert.match(quietOut, /allowed_mentions.*always included/);

    const loudOut = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      parts: ["hi"],
      files: [],
    });
    assert.match(loudOut, /quiet\/silent: off/);
    assert.match(loudOut, /allowed_mentions.*always included/);
  });

  test("lists every message part with index/total, char count, and full content", () => {
    const parts = ["first chunk", "second chunk here"];
    const out = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      parts,
      files: [],
    });
    assert.match(out, /message 1\/2 — 11 chars:/);
    assert.match(out, /first chunk/);
    assert.match(out, /message 2\/2 — 17 chars:/);
    assert.match(out, /second chunk here/);
  });

  test("handles parts=[] with files.length>0 (files-only send) correctly", () => {
    const files = [
      { name: "a.png", type: "image/png", data: Buffer.alloc(100), origin: "local" },
    ];
    const out = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      parts: [],
      files,
    });
    assert.match(out, /messages: none \(files-only send\)/);
    assert.match(out, /attachments \(posted on their own, no message text\)/);
    assert.match(out, /a\.png/);
    assert.match(out, /DRY RUN SUMMARY: 1 Discord API call would have been made/);
  });

  test("reports attachment details (name, MIME, size, origin) and combined vs limit total", () => {
    const files = [
      { name: "local.txt", type: "text/plain", data: Buffer.alloc(1024 * 1024), origin: "local" },
      {
        name: "remote.png",
        type: "image/png",
        data: Buffer.alloc(2 * 1024 * 1024),
        origin: "url",
      },
    ];
    const out = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      parts: ["msg"],
      files,
    });
    assert.match(out, /local\.txt \(text\/plain, 1\.00MB, origin: local\)/);
    assert.match(out, /remote\.png \(image\/png, 2\.00MB, origin: url\)/);
    assert.match(out, /combined: 3\.00MB \/ 8\.00MB limit/);
    // Attachments must be reported on the last (carrying) message only.
    assert.match(out, /attachments — carried on message 1\/1/);
  });

  test("summary line is textually distinguishable from the real send success message", () => {
    const out = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      parts: ["hi"],
      files: [],
    });
    // The real success line is `✅ sent ${what} to Discord`, e.g.
    // "✅ sent message to Discord" / "✅ sent 2 attachments to Discord" /
    // "✅ sent message + 2 attachments to Discord". None of those exact
    // phrasings should appear anywhere in the dry-run report.
    assert.doesNotMatch(out, /✅/);
    assert.doesNotMatch(out, /sent message to Discord/);
    assert.doesNotMatch(out, /sent \d+ attachments? to Discord/);
    assert.doesNotMatch(out, /sent message \+ \d+ attachments? to Discord/);
    assert.match(out, /DRY RUN SUMMARY/);
  });

  test("includes username when provided", () => {
    const out = buildDryRunReport({
      to: undefined,
      webhookUrl: WEBHOOK,
      quiet: false,
      username: "Build Bot",
      parts: ["hi"],
      files: [],
    });
    assert.match(out, /username: Build Bot/);
  });
});

describe("--dry-run end-to-end (child process)", () => {
  // Exercises main()'s actual flag parsing and validation ordering, and
  // confirms zero network requests reach the webhook.
  let hadExistingConfig = false;
  let existingConfigContents = "";

  function writeConfig(cfg) {
    hadExistingConfig = fs.existsSync(CONFIG_PATH);
    if (hadExistingConfig) existingConfigContents = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  }

  function restoreConfig() {
    if (hadExistingConfig) fs.writeFileSync(CONFIG_PATH, existingConfigContents);
    else fs.rmSync(CONFIG_PATH, { force: true });
  }

  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [SEND_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      // No stdin is scripted for these tests. Some argument combinations
      // (e.g. no message/no --file) make main() fall back to reading
      // stdin; without closing it here that read blocks forever since
      // execFile never sends EOF on its own.
      child.stdin.end();
    });
  }

  function serve() {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ url: req.url, body });
        res.writeHead(204);
        res.end();
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
    });
  }

  test("--dry-run is a boolean switch and does not consume the following argument", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--dry-run", "hello there"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /message 1\/1 — 11 chars:/);
    assert.match(stdout, /hello there/);
  });

  test("exits 0 on successful dry-run validation, zero network requests made", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
    t.after(() => {
      restoreConfig();
      server.close();
    });

    const { code, stdout, stderr } = await run(["--dry-run", "some message"]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 0, "post() must never be called under --dry-run");
    assert.match(stdout, /DRY RUN/);
  });

  test("multi-chunk + files scenario: zero fetch calls to the webhook, all chunks reported", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });

    const tmpFile = path.join(__dirname, "tmp-dry-run-file.txt");
    fs.writeFileSync(tmpFile, "attachment contents");
    t.after(() => {
      restoreConfig();
      server.close();
      fs.rmSync(tmpFile, { force: true });
    });

    const longMsg = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const expectedParts = chunks(longMsg).filter((p) => p.trim() !== "");
    assert.ok(expectedParts.length > 1, "test setup should produce multiple chunks");

    const { code, stdout, stderr } = await run(["--dry-run", "--file", tmpFile, longMsg]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 0, "no webhook request should ever be made under --dry-run");
    for (let i = 0; i < expectedParts.length; i++) {
      assert.match(stdout, new RegExp(`message ${i + 1}/${expectedParts.length}`));
    }
    assert.match(stdout, /tmp-dry-run-file\.txt/);
    assert.match(stdout, /origin: local/);
  });

  test("webhook URL never appears unmasked in --dry-run output", async (t) => {
    const url = "https://discord.com/api/webhooks/222222222222222222/RawTokenShouldNeverAppear123";
    writeConfig({ webhookUrl: url });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--dry-run", "hi"]);
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stdout, /RawTokenShouldNeverAppear123/);
    assert.match(stdout, /RawT…r123/);
  });

  test("missing-value errors fire identically under --dry-run (same message, exit 1)", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stderr } = await run(["--dry-run", "--username"]);
    assert.equal(code, 1);
    assert.match(stderr, /--username needs a value/);
  });

  test("MAX_FILES count check still fires under --dry-run before any loadFile call", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const args = ["--dry-run"];
    for (let i = 0; i < 11; i++) args.push("--file", "does-not-need-to-exist.txt");
    args.push("too many");
    const { code, stderr } = await run(args);
    assert.equal(code, 1);
    assert.match(stderr, /too many attachments: 11/);
  });

  test("loadWebhook(--to) failure still fires under --dry-run, no network call", async (t) => {
    const { server, requests } = await serve();
    const port = server.address().port;
    writeConfig({
      webhookUrl: `http://127.0.0.1:${port}/webhook`,
      webhooks: { work: `http://127.0.0.1:${port}/webhook` },
    });
    t.after(() => {
      restoreConfig();
      server.close();
    });
    const { code, stderr } = await run(["--dry-run", "--to", "bogus", "hi"]);
    assert.equal(code, 1);
    assert.match(stderr, /no webhook named "bogus"/);
    assert.equal(requests.length, 0);
  });

  test("loadFile() failure (missing local file) still fires under --dry-run, exit 1", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stderr } = await run([
      "--dry-run",
      "--file",
      "/no/such/file-really-does-not-exist.txt",
      "hi",
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /file not found/);
  });

  test("MAX_ATTACHMENT_BYTES check still fires under --dry-run before any post, exit 1", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    const tmpA = path.join(__dirname, "tmp-dry-run-oversized-a.bin");
    const tmpB = path.join(__dirname, "tmp-dry-run-oversized-b.bin");
    fs.writeFileSync(tmpA, Buffer.alloc(5 * 1024 * 1024));
    fs.writeFileSync(tmpB, Buffer.alloc(4 * 1024 * 1024));
    t.after(() => {
      restoreConfig();
      fs.rmSync(tmpA, { force: true });
      fs.rmSync(tmpB, { force: true });
    });
    const { code, stderr } = await run(["--dry-run", "--file", tmpA, "--file", tmpB, "too big"]);
    assert.equal(code, 1);
    assert.match(stderr, /attachments too large: 9\.00MB combined/);
  });

  test("no message or attachment still fails with exit 2 under --dry-run", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stderr } = await run(["--dry-run"]);
    assert.equal(code, 2);
    assert.match(stderr, /no message or attachment provided/);
  });

  test("--file URL refs are still resolved via real loadFile() under --dry-run (real fetch happens)", async (t) => {
    const urlBody = Buffer.from("hello from a real fetch");
    const fileServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": urlBody.length,
      });
      res.end(urlBody);
    });
    await new Promise((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
    const filePort = fileServer.address().port;
    const fileUrl = `http://127.0.0.1:${filePort}/note.txt`;

    const { server: webhookServer, requests } = await serve();
    const whPort = webhookServer.address().port;
    writeConfig({ webhookUrl: `http://127.0.0.1:${whPort}/webhook` });
    t.after(() => {
      restoreConfig();
      webhookServer.close();
      fileServer.close();
    });

    const { code, stdout, stderr } = await run(["--dry-run", "--file", fileUrl, "with a url file"]);
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 0, "webhook must never receive a request");
    // The reported size reflects the actual fetched bytes, proving the
    // real network fetch happened rather than being skipped/faked.
    assert.match(stdout, /note\.txt/);
    assert.match(stdout, /origin: url/);
  });

  test("quiet/silent state is reported correctly under --dry-run", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--dry-run", "--quiet", "hi"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /quiet\/silent: ON/);
  });
});

describe("--embed-* CLI flags (child process)", () => {
  // buildEmbed()/parseEmbedColor()/parseEmbedField() call fail() ->
  // process.exit(1) on invalid input, same convention as loadWebhook()
  // elsewhere in this file — driven through a real child process so a
  // failure can't kill the test runner itself.
  let hadExistingConfig = false;
  let existingConfigContents = "";

  function writeConfig(cfg) {
    hadExistingConfig = fs.existsSync(CONFIG_PATH);
    if (hadExistingConfig) existingConfigContents = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  }

  function restoreConfig() {
    if (hadExistingConfig) fs.writeFileSync(CONFIG_PATH, existingConfigContents);
    else fs.rmSync(CONFIG_PATH, { force: true });
  }

  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [SEND_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      child.stdin.end();
    });
  }

  function serve() {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ url: req.url, body });
        res.writeHead(204);
        res.end();
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
    });
  }

  describe("missing-value errors", () => {
    for (const flag of ["--embed-title", "--embed-description", "--embed-color", "--embed-field", "--embed-field-inline"]) {
      test(`${flag} with no following argument fails immediately`, async (t) => {
        writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
        t.after(restoreConfig);
        const { code, stderr } = await run(["hello", flag]);
        assert.equal(code, 1);
        assert.match(stderr, new RegExp(`${flag} needs a value`));
      });
    }
  });

  describe("--embed-color parsing", () => {
    test("accepts #RRGGBB and posts the decoded decimal color", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run(["--embed-color", "#5865F2", "msg"]);
      assert.equal(code, 0, stderr);
      const payload = JSON.parse(requests[0].body);
      assert.equal(payload.embeds[0].color, 0x5865f2);
    });

    test("accepts bare RRGGBB (no #)", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run(["--embed-color", "5865F2", "msg"]);
      assert.equal(code, 0, stderr);
      const payload = JSON.parse(requests[0].body);
      assert.equal(payload.embeds[0].color, 0x5865f2);
    });

    test("accepts a decimal integer", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run(["--embed-color", "5793266", "msg"]);
      assert.equal(code, 0, stderr);
      const payload = JSON.parse(requests[0].body);
      assert.equal(payload.embeds[0].color, 5793266);
    });

    test("rejects an invalid color with a clear message, no network call", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run(["--embed-color", "not-a-color", "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /invalid --embed-color: "not-a-color"/);
      assert.equal(requests.length, 0);
    });
  });

  describe("--embed-field / --embed-field-inline parsing", () => {
    test("valid name=value fields are posted with correct inline state", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run([
        "--embed-field",
        "Duration=3m12s",
        "--embed-field-inline",
        "Branch=main",
        "msg",
      ]);
      assert.equal(code, 0, stderr);
      const payload = JSON.parse(requests[0].body);
      assert.deepEqual(payload.embeds[0].fields, [
        { name: "Duration", value: "3m12s", inline: false },
        { name: "Branch", value: "main", inline: true },
      ]);
    });

    test("field order is preserved across --embed-field and --embed-field-inline in encounter order", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run([
        "--embed-field-inline",
        "First=1",
        "--embed-field",
        "Second=2",
        "--embed-field-inline",
        "Third=3",
        "msg",
      ]);
      assert.equal(code, 0, stderr);
      const payload = JSON.parse(requests[0].body);
      assert.deepEqual(
        payload.embeds[0].fields.map((f) => f.name),
        ["First", "Second", "Third"]
      );
    });

    test("rejects a field with no '=', no network call", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run(["--embed-field", "noequals", "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /invalid --embed-field: "noequals"/);
      assert.equal(requests.length, 0);
    });

    // Closes a gap: parseEmbedField's "split on the FIRST '=' only" behavior
    // (unit-tested directly elsewhere) was never exercised end-to-end through
    // the real CLI arg parsing + dry-run rendering path.
    test("a value containing '=' keeps everything after the first '=' intact", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stderr } = await run(["--embed-field", "Formula=x=y+z", "msg"]);
      assert.equal(code, 0, stderr);
      const payload = JSON.parse(requests[0].body);
      assert.deepEqual(payload.embeds[0].fields, [{ name: "Formula", value: "x=y+z", inline: false }]);
    });

    test("rejects a field with an empty name, no network call", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stderr } = await run(["--embed-field", "=value", "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /invalid --embed-field: "=value"/);
    });

    test("rejects a field with an empty value, no network call", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stderr } = await run(["--embed-field-inline", "name=", "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /invalid --embed-field-inline: "name="/);
    });
  });

  describe("length/count limit validation (each fires before any network call)", () => {
    test("embed title over 256 chars is rejected with an exact count + limit", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const title = "a".repeat(257);
      const { code, stderr } = await run(["--embed-title", title, "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /embed title too long: 257 chars \(Discord's limit is 256\)/);
    });

    test("embed description over 4096 chars is rejected with an exact count + limit", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const description = "a".repeat(4097);
      const { code, stderr } = await run(["--embed-description", description, "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /embed description too long: 4097 chars \(Discord's limit is 4096\)/);
    });

    test("more than 25 embed fields is rejected with an exact count + limit", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const args = [];
      for (let i = 0; i < 26; i++) args.push("--embed-field", `n${i}=v${i}`);
      args.push("msg");
      const { code, stderr } = await run(args);
      assert.equal(code, 1);
      assert.match(stderr, /too many embed fields: 26 \(Discord allows 25 per embed\)/);
    });

    test("a field name over 256 chars is rejected, naming the offending field", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const longName = "n".repeat(257);
      const { code, stderr } = await run(["--embed-field", `${longName}=v`, "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /embed field name too long: ".*" is 257 chars \(Discord's limit is 256\)/);
    });

    test("a field value over 1024 chars is rejected, naming the offending field", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const longValue = "v".repeat(1025);
      const { code, stderr } = await run(["--embed-field", `MyField=${longValue}`, "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /embed field value too long: field "MyField" value is 1025 chars \(Discord's limit is 1024\)/);
    });

    test("combined total over 6000 chars is rejected even when each piece is individually within limit", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      // 256 (title) + 4096 (description) + 25 * (256 + 1024) fields would be
      // huge; keep it simpler: title + description alone already fit under
      // their own limits but push the combined total over 6000.
      const title = "a".repeat(256);
      const description = "b".repeat(4096);
      const fieldValue = "c".repeat(1024);
      // combined so far: 256 + 4096 + (name 1 + value 1024) = 5377; add one
      // more field to push over 6000.
      const { code, stderr } = await run([
        "--embed-title",
        title,
        "--embed-description",
        description,
        "--embed-field",
        `f1=${fieldValue}`,
        "--embed-field",
        `f2=${fieldValue}`,
        "msg",
      ]);
      assert.equal(code, 1);
      assert.match(stderr, /embed too large: \d+ chars combined across title\/description\/fields \(Discord's limit is 6000 per embed\)/);
    });

    test("boundary: exactly 6000 combined chars is not rejected", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      // title(256) + description(4096) + field name(4) + field value(1024) = 5380
      // pad with a second field value to land exactly on 6000.
      const title = "a".repeat(256);
      const description = "b".repeat(4096);
      const field1Value = "c".repeat(1024);
      // 256 + 4096 + (4 + 1024) = 5380; need 620 more via a second field
      // (name "f2" = 2 chars + value 618 chars = 620).
      const field2Value = "d".repeat(618);
      const { code, stderr } = await run([
        "--embed-title",
        title,
        "--embed-description",
        description,
        "--embed-field",
        `name=${field1Value}`,
        "--embed-field",
        `f2=${field2Value}`,
        "msg",
      ]);
      assert.equal(code, 0, stderr);
      const payload = JSON.parse(requests[0].body);
      const embed = payload.embeds[0];
      const total =
        embed.title.length +
        embed.description.length +
        embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
      assert.equal(total, 6000);
    });
  });

  describe("validation ordering: before loadWebhook(--to) and before loadFile()", () => {
    test("an invalid embed fails even with a bogus --to, and no 'no webhook named' error surfaces", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stderr } = await run(["--to", "bogus-channel", "--embed-color", "nope", "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /invalid --embed-color/);
      assert.doesNotMatch(stderr, /no webhook named/);
    });

    test("an invalid embed fails even with a missing --file, and no 'file not found' error surfaces", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stderr } = await run([
        "--file",
        "/no/such/file-really-does-not-exist.txt",
        "--embed-title",
        "a".repeat(300),
        "msg",
      ]);
      assert.equal(code, 1);
      assert.match(stderr, /embed title too long/);
      assert.doesNotMatch(stderr, /file not found/);
    });
  });

  describe("embed-only / content+embed sends (end-to-end)", () => {
    test("embed-only send (no text, no --file) is valid and does not fall back to stdin / exit 2", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stdout, stderr } = await run(["--embed-title", "Standalone embed"]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /sent embed to Discord/);
      assert.equal(requests.length, 1);
      const payload = JSON.parse(requests[0].body);
      assert.equal("content" in payload, false);
      assert.equal(payload.embeds[0].title, "Standalone embed");
    });

    test("content + embed together is valid and both are posted on the same message", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const { code, stdout, stderr } = await run(["--embed-title", "Build passed", "here you go"]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /sent message \+ embed to Discord/);
      assert.equal(requests.length, 1);
      const payload = JSON.parse(requests[0].body);
      assert.equal(payload.content, "here you go");
      assert.equal(payload.embeds[0].title, "Build passed");
    });

    test("no message, no attachment, and no embed still fails with exit 2", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stderr } = await run([]);
      assert.equal(code, 2);
      assert.match(stderr, /no message or attachment provided/);
    });

    test("multi-chunk message with an embed: the embed appears in exactly the last chunk's payload", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      t.after(() => {
        restoreConfig();
        server.close();
      });
      const longMsg = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
      const { code, stderr } = await run(["--embed-title", "Final chunk only", longMsg]);
      assert.equal(code, 0, stderr);
      assert.ok(requests.length > 1, "expected more than one chunked request");
      requests.slice(0, -1).forEach((r, idx) => {
        const payload = JSON.parse(r.body);
        assert.equal("embeds" in payload, false, `chunk ${idx} (not last) should not carry the embed`);
      });
      const lastPayload = JSON.parse(requests[requests.length - 1].body);
      assert.equal(lastPayload.embeds[0].title, "Final chunk only");
    });

    test("embed composes with --file (multipart payload_json path carries embeds)", async (t) => {
      const { server, requests } = await serve();
      const port = server.address().port;
      writeConfig({ webhookUrl: `http://127.0.0.1:${port}/webhook` });
      const tmpFile = path.join(__dirname, "tmp-embed-with-file.txt");
      fs.writeFileSync(tmpFile, "attachment contents");
      t.after(() => {
        restoreConfig();
        server.close();
        fs.rmSync(tmpFile, { force: true });
      });
      const { code, stderr } = await run(["--embed-title", "With a file", "--file", tmpFile, "msg"]);
      assert.equal(code, 0, stderr);
      assert.equal(requests.length, 1);
      // Multipart request body: assert on the raw multipart text for the
      // payload_json field's embeds.
      assert.match(requests[0].body, /"embeds":\[\{"title":"With a file"/);
    });
  });

  describe("--dry-run rendering of the embed", () => {
    test("shows title, full description, color as hex+decimal, and fields with inline state", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stdout, stderr } = await run([
        "--dry-run",
        "--embed-title",
        "Build passed",
        "--embed-description",
        "All 42 tests green",
        "--embed-color",
        "#5865F2",
        "--embed-field",
        "Duration=3m12s",
        "--embed-field-inline",
        "Branch=main",
        "here's the report",
      ]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /title: Build passed/);
      assert.match(stdout, /description: All 42 tests green/);
      assert.match(stdout, /color: #5865F2 \(5793266\)/);
      assert.match(stdout, /Duration: 3m12s \(inline: false\)/);
      assert.match(stdout, /Branch: main \(inline: true\)/);
      // Attached to the same (last, only) message it would actually attach to.
      assert.match(stdout, /embed — attached to message 1\/1/);
    });

    test("embed-only dry-run reports 'posted on its own, no message text' and 1 API call", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stdout, stderr } = await run(["--dry-run", "--embed-title", "Solo"]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /messages: none \(embed-only send\)/);
      assert.match(stdout, /embed \(posted on its own, no message text\)/);
      assert.match(stdout, /DRY RUN SUMMARY: 1 Discord API call would have been made/);
    });

    test("dry-run with no embed requested renders no embed section at all", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stdout, stderr } = await run(["--dry-run", "plain message"]);
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stdout, /embed/);
    });

    test("invalid embed input still fails identically under --dry-run (same message, exit 1)", async (t) => {
      writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
      t.after(restoreConfig);
      const { code, stderr } = await run(["--dry-run", "--embed-color", "garbage", "msg"]);
      assert.equal(code, 1);
      assert.match(stderr, /invalid --embed-color: "garbage"/);
    });
  });
});

describe("--help and unknown-flag rejection (child process)", () => {
  // These run through the real CLI because they are entirely about main()'s
  // argument parsing — the order of the --help / `--` / unknown-flag branches
  // relative to the value-consuming flags is the whole point.
  let hadExistingConfig = false;
  let existingConfigContents = "";

  function writeConfig(cfg) {
    hadExistingConfig = fs.existsSync(CONFIG_PATH);
    if (hadExistingConfig) existingConfigContents = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  }

  function restoreConfig() {
    if (hadExistingConfig) fs.writeFileSync(CONFIG_PATH, existingConfigContents);
    else fs.rmSync(CONFIG_PATH, { force: true });
  }

  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [SEND_JS, ...args], (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      // Same reason as the other child-process suites: without EOF, any
      // argument combination that falls back to stdin blocks forever.
      child.stdin.end();
    });
  }

  test("--help prints usage and exits 0 without needing a config", async () => {
    const { code, stdout } = await run(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /usage:/);
    assert.match(stdout, /--embed-field-inline/);
  });

  test("-h is accepted as well", async () => {
    const { code, stdout } = await run(["-h"]);
    assert.equal(code, 0);
    assert.match(stdout, /usage:/);
  });

  test("--help lists the real MAX_FILES value, not a hardcoded one", async () => {
    const { stdout } = await run(["--help"]);
    assert.match(stdout, /up to 10 per message/);
  });

  test("an unknown --flag fails instead of being sent as message text", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--fiel", "shot.png", "oops"]);
    assert.equal(code, 1);
    assert.match(stderr, /unknown flag: --fiel/);
    assert.match(stderr, /--help/);
    assert.equal(stdout, "");
  });

  test("the unknown-flag error points at `--` for genuine message text", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { stderr } = await run(["--oops"]);
    assert.match(stderr, /put it after --/);
    assert.match(stderr, /discord_send\.js -- "--oops"/);
  });

  test("`--` ends flag parsing so a message can start with dashes", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--dry-run", "--", "--- release notes ---"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /message 1\/1 — 21 chars:/);
    assert.match(stdout, /--- release notes ---/);
  });

  test("`--` does not swallow flags that came before it", async (t) => {
    writeConfig({
      webhookUrl: "https://discord.com/api/webhooks/1/token1234567890",
      webhooks: { work: "https://discord.com/api/webhooks/2/token0987654321" },
    });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--dry-run", "--to", "work", "--", "--x"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /target: work/);
    assert.match(stdout, /--x/);
  });

  test("a flag value that looks like a flag is still treated as a value", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--dry-run", "--embed-title", "--help"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /title: --help/);
    assert.doesNotMatch(stdout, /usage:/);
  });

  test("a single-dash argument is still message text (markdown bullets, negative numbers)", async (t) => {
    writeConfig({ webhookUrl: "https://discord.com/api/webhooks/1/token1234567890" });
    t.after(restoreConfig);
    const { code, stdout, stderr } = await run(["--dry-run", "-3 degrees overnight"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /-3 degrees overnight/);
  });
});
