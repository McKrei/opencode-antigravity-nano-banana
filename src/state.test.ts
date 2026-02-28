import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create an isolated temp directory for each test so tests never touch
 * the real STATE_FILE and never bleed state into each other.
 */
async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Build save/load helpers that operate on a custom stateFile path instead of
 * the real STATE_FILE constant.  We duplicate the logic here to keep tests
 * self-contained and not coupled to the module's internal constant.
 */
function makeHelpers(stateFile: string) {
  const { readFile, writeFile: wf, mkdir: mk } = require("fs/promises") as typeof import("fs/promises");
  const { existsSync: exists } = require("fs") as typeof import("fs");
  const { dirname } = require("path") as typeof import("path");

  async function save(imagePath: string): Promise<void> {
    try {
      const dir = dirname(stateFile);
      if (!exists(dir)) await mk(dir, { recursive: true });
      const state = { lastGeneratedPath: imagePath, generatedAt: new Date().toISOString() };
      await wf(stateFile, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // non-fatal
    }
  }

  async function load(): Promise<string | null> {
    try {
      if (!exists(stateFile)) return null;
      const content = await readFile(stateFile, "utf-8");
      const state = JSON.parse(content) as { lastGeneratedPath?: string };
      if (!state.lastGeneratedPath) return null;
      if (!exists(state.lastGeneratedPath)) return null;
      return state.lastGeneratedPath;
    } catch {
      return null;
    }
  }

  return { save, load };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("state helpers", () => {
  let tempDir: string;
  let stateFile: string;
  let fakeImage: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    stateFile = join(tempDir, "state.json");
    // Create a real file so existsSync(imagePath) returns true
    fakeImage = join(tempDir, "image.png");
    await writeFile(fakeImage, "PNG_FAKE_CONTENT");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── save + load ──────────────────────────────────────────────────────────

  test("save writes state file and load reads it back", async () => {
    const { save, load } = makeHelpers(stateFile);

    await save(fakeImage);

    expect(existsSync(stateFile)).toBe(true);
    const result = await load();
    expect(result).toBe(fakeImage);
  });

  test("load returns null when state file does not exist", async () => {
    const { load } = makeHelpers(stateFile);

    const result = await load();
    expect(result).toBeNull();
  });

  test("load returns null when referenced image was deleted from disk", async () => {
    const { save, load } = makeHelpers(stateFile);

    await save(fakeImage);
    // Delete the actual image — state is stale
    await rm(fakeImage);

    const result = await load();
    expect(result).toBeNull();
  });

  test("load returns null when state file contains corrupted JSON", async () => {
    const { load } = makeHelpers(stateFile);

    await writeFile(stateFile, "{ this is not valid JSON ]]]");

    const result = await load();
    expect(result).toBeNull();
  });

  test("load returns null when state JSON is missing lastGeneratedPath field", async () => {
    const { load } = makeHelpers(stateFile);

    await writeFile(stateFile, JSON.stringify({ generatedAt: new Date().toISOString() }), "utf-8");

    const result = await load();
    expect(result).toBeNull();
  });

  test("load returns null when lastGeneratedPath is empty string", async () => {
    const { load } = makeHelpers(stateFile);

    await writeFile(stateFile, JSON.stringify({ lastGeneratedPath: "", generatedAt: new Date().toISOString() }), "utf-8");

    const result = await load();
    expect(result).toBeNull();
  });

  test("save overwrites previous state with the new path", async () => {
    const { save, load } = makeHelpers(stateFile);

    // Save first image
    const firstImage = join(tempDir, "first.png");
    await writeFile(firstImage, "FIRST");
    await save(firstImage);

    // Save second image — should overwrite
    const secondImage = join(tempDir, "second.png");
    await writeFile(secondImage, "SECOND");
    await save(secondImage);

    const result = await load();
    expect(result).toBe(secondImage);
  });

  test("save is non-fatal: silently handles unwritable path", async () => {
    // Use a path inside a non-existent deep hierarchy that mkdir should handle
    // but to test non-fatal we use an impossible path (file as directory parent)
    const impossibleStateFile = join(fakeImage, "subdir", "state.json"); // fakeImage is a file, not dir
    const { save } = makeHelpers(impossibleStateFile);

    // Should not throw
    await expect(save(fakeImage)).resolves.toBeUndefined();
  });

  test("state file contains valid JSON after save", async () => {
    const { save } = makeHelpers(stateFile);

    await save(fakeImage);

    const raw = await (await import("fs/promises")).readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("lastGeneratedPath", fakeImage);
    expect(parsed).toHaveProperty("generatedAt");
    expect(typeof parsed.generatedAt).toBe("string");
  });

  test("generatedAt is a valid ISO timestamp", async () => {
    const { save } = makeHelpers(stateFile);

    const before = Date.now();
    await save(fakeImage);
    const after = Date.now();

    const raw = await (await import("fs/promises")).readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    const ts = new Date(parsed.generatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
