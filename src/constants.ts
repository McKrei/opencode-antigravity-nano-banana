import { homedir } from "os";
import { join } from "path";
import { platform } from "process";

// OAuth credentials (same as antigravity-auth plugin)
export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET = "REDACTED";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// CloudCode API
export const CLOUDCODE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const CLOUDCODE_FALLBACK_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

export const CLOUDCODE_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

// ── Image generation config ──

// Default model — overridden at runtime via auto-detection from fetchAvailableModels
export const IMAGE_MODEL_DEFAULT = "gemini-3.1-flash-image";

// Candidates to look for when auto-detecting (first match wins, newest first)
export const IMAGE_MODEL_CANDIDATES = [
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-3-flash-image",
  "gemini-2.5-flash-preview-image",
];

export let IMAGE_MODEL = IMAGE_MODEL_DEFAULT;

// Generation timeout per single request attempt
export const IMAGE_GENERATION_TIMEOUT_MS = 120_000;

// ── Retry config for 503 (capacity) errors ──
export const CAPACITY_RETRY_COUNT = 3;
export const CAPACITY_RETRY_BASE_DELAY_MS = 3_000; // 3s, 6s, 12s (exponential)

// ── Default image settings ──
export const DEFAULT_ASPECT_RATIO = "1:1";
export const DEFAULT_IMAGE_SIZE = "1K";

// ── Reference images ──
export const MAX_REFERENCE_IMAGES = 10;
export const SUPPORTED_IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

// ── Sessions ──
/** Subdirectory (relative to worktree) where session JSON files are stored */
export const SESSIONS_SUBDIR = ".opencode/generated-image-sessions";

// ── Soft quota ──
/** Skip accounts with remainingFraction below this threshold (< 10% quota left) */
export const SOFT_QUOTA_THRESHOLD = 0.1;
/** How long quota info stays fresh before re-fetching (5 minutes) */
export const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Safety settings ──
/** Passed to every generation request to reduce over-blocking */
export const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH",        threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT",  threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY",    threshold: "BLOCK_ONLY_HIGH" },
] as const;

// Config directory (match opencode-antigravity-auth behavior)
function getConfigDir(): string {
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

// Config file paths (primary path matches auth plugin, fallback for legacy)
export const CONFIG_PATHS = [
  join(getConfigDir(), "antigravity-accounts.json"),
  join(homedir(), ".opencode", "antigravity-accounts.json"),
];

// State file — persists last generated image path for edit_mode
export const STATE_FILE = join(getConfigDir(), "antigravity-img-state.json");

// Command files for opencode discovery (opencode uses "command" singular)
export const COMMAND_DIR = join(getConfigDir(), "command");

export const COMMAND_FILE = join(COMMAND_DIR, "generate-image.md");
export const COMMAND_CONTENT = `---
description: Generate an image using Gemini image model (auto-detected)
---

Generate an image using the best available Gemini image model.

Prompt: $PROMPT
Output filename (optional): $FILENAME
`;

export const QUOTA_COMMAND_FILE = join(COMMAND_DIR, "antigravity-quota-img.md");
export const QUOTA_COMMAND_CONTENT = `---
description: Check Antigravity image generation quota for all configured accounts
---

Use the \`image_quota\` tool to check the current image generation quota status.

This will show:
- Gemini image model quota remaining per account
- Visual progress bars for each account
- Time until quota reset

IMPORTANT: Display the tool output EXACTLY as it is returned. Do not summarize, reformat, or modify the output in any way.
`;
