import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSession,
  loadSession,
  saveSession,
  addUserMessage,
  addModelMessage,
  getSessionHistory,
  listSessions,
  deleteSession,
} from "./sessions";
import type { Session, ContentPart } from "./types";

// ── Test setup ────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  // Create a fresh temp directory for each test
  testDir = join(tmpdir(), `sessions_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(async () => {
  // Clean up temp directory
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ── createSession ─────────────────────────────────────────────────────────────

describe("createSession", () => {
  test("creates session with correct id and empty history", () => {
    const session = createSession("test-session-1");
    expect(session.id).toBe("test-session-1");
    expect(session.history).toEqual([]);
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  test("createdAt and updatedAt are close to Date.now()", () => {
    const before = Date.now();
    const session = createSession("ts-test");
    const after = Date.now();
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
  });
});

// ── saveSession / loadSession ─────────────────────────────────────────────────

describe("saveSession / loadSession", () => {
  test("saves and reloads a session correctly", async () => {
    const session = createSession("round-trip");
    session.history.push({ role: "user", parts: [{ text: "hello" }] });

    await saveSession(session, testDir);
    const loaded = await loadSession("round-trip", testDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("round-trip");
    expect(loaded!.history).toHaveLength(1);
    expect((loaded!.history[0].parts[0] as { text: string }).text).toBe("hello");
  });

  test("loadSession returns null for missing session", async () => {
    const result = await loadSession("nonexistent", testDir);
    expect(result).toBeNull();
  });

  test("saveSession creates sessions directory if it does not exist", async () => {
    const deepDir = join(testDir, "sub", "project");
    const session = createSession("deep-save");
    await saveSession(session, deepDir);

    const loaded = await loadSession("deep-save", deepDir);
    expect(loaded).not.toBeNull();
  });

  test("saveSession updates updatedAt on each save", async () => {
    const session = createSession("update-ts");
    const originalUpdatedAt = session.updatedAt;

    // Wait a tick to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));
    await saveSession(session, testDir);

    expect(session.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  test("sanitizes special characters in session id for filename", async () => {
    const session = createSession("my session/with:special?chars");
    await saveSession(session, testDir);
    const loaded = await loadSession("my session/with:special?chars", testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("my session/with:special?chars");
  });
});

// ── addUserMessage / addModelMessage ──────────────────────────────────────────

describe("addUserMessage / addModelMessage", () => {
  test("addUserMessage appends user turn", () => {
    const session = createSession("msg-test");
    const parts: ContentPart[] = [{ text: "generate a cat" }];
    addUserMessage(session, parts);

    expect(session.history).toHaveLength(1);
    expect(session.history[0].role).toBe("user");
    expect(session.history[0].parts).toEqual(parts);
  });

  test("addModelMessage appends model turn", () => {
    const session = createSession("model-test");
    const parts: ContentPart[] = [
      { inlineData: { mimeType: "image/png", data: "base64data" } },
    ];
    addModelMessage(session, parts);

    expect(session.history).toHaveLength(1);
    expect(session.history[0].role).toBe("model");
    expect(session.history[0].parts).toEqual(parts);
  });

  test("alternating user/model messages build correct history", () => {
    const session = createSession("dialogue");
    addUserMessage(session, [{ text: "first prompt" }]);
    addModelMessage(session, [{ inlineData: { mimeType: "image/png", data: "abc" } }]);
    addUserMessage(session, [{ text: "make it blue" }]);
    addModelMessage(session, [{ inlineData: { mimeType: "image/png", data: "def" } }]);

    expect(session.history).toHaveLength(4);
    expect(session.history[0].role).toBe("user");
    expect(session.history[1].role).toBe("model");
    expect(session.history[2].role).toBe("user");
    expect(session.history[3].role).toBe("model");
  });

  test("addUserMessage updates updatedAt", () => {
    const session = createSession("upd-test");
    const before = session.updatedAt;
    // Slight delay so timestamp is different
    session.updatedAt = before - 1;
    addUserMessage(session, [{ text: "hi" }]);
    expect(session.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── getSessionHistory ─────────────────────────────────────────────────────────

describe("getSessionHistory", () => {
  test("returns empty array for new session", () => {
    const session = createSession("hist-empty");
    expect(getSessionHistory(session)).toEqual([]);
  });

  test("returns all history turns", () => {
    const session = createSession("hist-full");
    addUserMessage(session, [{ text: "a" }]);
    addModelMessage(session, [{ text: "b" }]);

    const history = getSessionHistory(session);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("model");
  });
});

// ── listSessions ──────────────────────────────────────────────────────────────

describe("listSessions", () => {
  test("returns empty array when sessions dir does not exist", async () => {
    const result = await listSessions(testDir);
    expect(result).toEqual([]);
  });

  test("lists saved sessions", async () => {
    await saveSession(createSession("alpha"), testDir);
    await saveSession(createSession("beta"), testDir);
    await saveSession(createSession("gamma"), testDir);

    const sessions = await listSessions(testDir);
    expect(sessions).toHaveLength(3);
    expect(sessions).toContain("alpha");
    expect(sessions).toContain("beta");
    expect(sessions).toContain("gamma");
  });

  test("does not include non-json files", async () => {
    const sessionsDir = join(testDir, ".opencode", "generated-image-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    await fs.writeFile(join(sessionsDir, "notes.txt"), "ignored");
    await saveSession(createSession("valid"), testDir);

    const sessions = await listSessions(testDir);
    expect(sessions).not.toContain("notes");
    expect(sessions).toContain("valid");
  });
});

// ── deleteSession ─────────────────────────────────────────────────────────────

describe("deleteSession", () => {
  test("deletes an existing session and returns true", async () => {
    await saveSession(createSession("to-delete"), testDir);
    const result = await deleteSession("to-delete", testDir);
    expect(result).toBe(true);

    const loaded = await loadSession("to-delete", testDir);
    expect(loaded).toBeNull();
  });

  test("returns false when session does not exist", async () => {
    const result = await deleteSession("ghost", testDir);
    expect(result).toBe(false);
  });

  test("does not affect other sessions", async () => {
    await saveSession(createSession("keep"), testDir);
    await saveSession(createSession("remove"), testDir);

    await deleteSession("remove", testDir);

    const kept = await loadSession("keep", testDir);
    const removed = await loadSession("remove", testDir);
    expect(kept).not.toBeNull();
    expect(removed).toBeNull();
  });
});
