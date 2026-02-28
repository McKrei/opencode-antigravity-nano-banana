import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { STATE_FILE } from "./constants";

interface ImgState {
  /** Absolute path to the last successfully generated image */
  lastGeneratedPath: string;
  /** ISO timestamp of the generation */
  generatedAt: string;
}

/**
 * Persist the path of the last successfully generated image.
 * Silently ignores write errors — state is best-effort.
 */
export async function saveLastGeneratedPath(imagePath: string): Promise<void> {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const state: ImgState = {
      lastGeneratedPath: imagePath,
      generatedAt: new Date().toISOString(),
    };
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Non-fatal — state is best-effort
  }
}

/**
 * Read the path of the last successfully generated image.
 * Returns null if state file doesn't exist, is corrupted, or the file was deleted.
 */
export async function loadLastGeneratedPath(): Promise<string | null> {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const content = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(content) as ImgState;
    if (!state.lastGeneratedPath) return null;
    // Verify the file still actually exists on disk
    if (!existsSync(state.lastGeneratedPath)) return null;
    return state.lastGeneratedPath;
  } catch {
    return null;
  }
}
