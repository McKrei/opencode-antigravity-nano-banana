import * as fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { SESSIONS_SUBDIR } from "./constants";
import type { Session, ContentPart } from "./types";

// ── Path helpers ──────────────────────────────────────────────────────────────

function getSessionsDir(worktree: string): string {
  return join(worktree, SESSIONS_SUBDIR);
}

function getSessionPath(sessionId: string, worktree: string): string {
  // Sanitize session ID to safe filename characters
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(getSessionsDir(worktree), `${safeId}.json`);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function loadSession(
  sessionId: string,
  worktree: string
): Promise<Session | null> {
  const sessionPath = getSessionPath(sessionId, worktree);
  if (!existsSync(sessionPath)) return null;

  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    return JSON.parse(content) as Session;
  } catch {
    return null;
  }
}

export async function saveSession(
  session: Session,
  worktree: string
): Promise<void> {
  const sessionsDir = getSessionsDir(worktree);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  session.updatedAt = Date.now();
  const sessionPath = getSessionPath(session.id, worktree);
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), "utf-8");
}

export function createSession(sessionId: string): Session {
  return {
    id: sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
  };
}

// ── History helpers ───────────────────────────────────────────────────────────

export function addUserMessage(session: Session, parts: ContentPart[]): void {
  session.history.push({ role: "user", parts });
  session.updatedAt = Date.now();
}

export function addModelMessage(session: Session, parts: ContentPart[]): void {
  session.history.push({ role: "model", parts });
  session.updatedAt = Date.now();
}

export function getSessionHistory(
  session: Session
): Array<{ role: "user" | "model"; parts: ContentPart[] }> {
  return session.history;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export async function listSessions(worktree: string): Promise<string[]> {
  const sessionsDir = getSessionsDir(worktree);
  if (!existsSync(sessionsDir)) return [];

  try {
    const files = await fs.readdir(sessionsDir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}

export async function deleteSession(
  sessionId: string,
  worktree: string
): Promise<boolean> {
  const sessionPath = getSessionPath(sessionId, worktree);
  if (!existsSync(sessionPath)) return false;

  try {
    await fs.unlink(sessionPath);
    return true;
  } catch {
    return false;
  }
}
