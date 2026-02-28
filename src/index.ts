import { type Plugin, tool } from "@opencode-ai/plugin";
import * as fs from "fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { CONFIG_PATHS, COMMAND_DIR, COMMAND_FILE, COMMAND_CONTENT, QUOTA_COMMAND_FILE, QUOTA_COMMAND_CONTENT, IMAGE_MODEL } from "./constants";
import type { AccountsConfig, Account, ImageGenerationOptions, AspectRatio, ImageSize } from "./types";
import { generateImage, getImageModelQuota, buildModelResponseContent } from "./api";
import { selectAccount, markUsed, markRateLimited, updateCachedQuota, MAX_RETRIES, RATE_LIMIT_COOLDOWN_MS } from "./accounts";
import { saveLastGeneratedPath, loadLastGeneratedPath } from "./state";
import { loadSession, saveSession, createSession, addUserMessage, addModelMessage, getSessionHistory } from "./sessions";

// Create command file for opencode discovery
try {
  if (!existsSync(COMMAND_DIR)) {
    mkdirSync(COMMAND_DIR, { recursive: true });
  }
  if (!existsSync(COMMAND_FILE)) {
    writeFileSync(COMMAND_FILE, COMMAND_CONTENT, "utf-8");
  }
  if (!existsSync(QUOTA_COMMAND_FILE)) {
    writeFileSync(QUOTA_COMMAND_FILE, QUOTA_COMMAND_CONTENT, "utf-8");
  }
} catch {
  // Non-fatal if command file creation fails
}

// Track which config file was loaded so we can write back to it
let loadedConfigPath: string | null = null;

/**
 * Load accounts from config file
 */
async function loadAccounts(): Promise<AccountsConfig | null> {
  for (const configPath of CONFIG_PATHS) {
    if (existsSync(configPath)) {
      try {
        const content = await fs.readFile(configPath, "utf-8");
        loadedConfigPath = configPath;
        return JSON.parse(content) as AccountsConfig;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Save accounts config back to the file it was loaded from
 */
async function saveAccounts(config: AccountsConfig): Promise<void> {
  const savePath = loadedConfigPath || CONFIG_PATHS[0];
  const dirPath = dirname(savePath);
  if (!existsSync(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true });
  }
  await fs.writeFile(savePath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Mark an account as recently used and persist to disk
 */
async function markAccountUsed(config: AccountsConfig, email: string): Promise<void> {
  markUsed(config, email);
  await saveAccounts(config);
}

/**
 * Mark an account as rate-limited with a cooldown and persist to disk
 */
async function markAccountRateLimited(config: AccountsConfig, email: string): Promise<void> {
  markRateLimited(config, email);
  await saveAccounts(config);
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format quota for display
 */
function formatQuota(percent: number): string {
  if (percent <= 10) return `${percent.toFixed(0)}% (low)`;
  if (percent <= 30) return `${percent.toFixed(0)}% (medium)`;
  return `${percent.toFixed(0)}%`;
}

export const plugin: Plugin = async (ctx) => {
  return {
    tool: {
      /**
       * Generate an image using the best available Gemini image model (auto-detected)
       */
      generate_image: tool({
        description:
          "Generate an image using the best available Gemini image model (auto-detected). " +
          "Provide a text prompt describing the image you want. " +
          "Optionally pass reference_images (array of absolute local file paths) to give the model " +
          "visual context — e.g. 'put this jacket on this person' with paths to both images. " +
          "Use edit_mode=true to automatically use the last generated image as a reference — " +
          "ideal for iterative edits in the same conversation (e.g. 'now make the background blue'). " +
          "If edit_mode=true and reference_images are also provided, the last image is prepended to them. " +
          "Use session_id to maintain a consistent style/character across multiple generations. " +
          "Use count to generate multiple variations in a single call (1-4). " +
          "Supported formats: PNG, JPEG, WEBP, GIF, BMP. " +
          "Output is always saved as the format returned by the API (typically PNG). " +
          "Returns the path to the generated image file.",
        args: {
          prompt: tool.schema.string().describe("Text description of the image to generate"),
          filename: tool.schema
            .string()
            .optional()
            .describe("Output filename (default: generated_<timestamp>.png)"),
          output_dir: tool.schema
            .string()
            .optional()
            .describe("Output directory (default: current working directory)"),
          aspect_ratio: tool.schema
            .string()
            .optional()
            .describe("Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 (default: 1:1)"),
          image_size: tool.schema
            .string()
            .optional()
            .describe("Image resolution: 1K, 2K, 4K (default: 1K)"),
          reference_images: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "Absolute paths to local reference images. The model will use them as visual context " +
              "when generating the new image. Up to 10 images. " +
              "Example: [\"/path/to/person.png\", \"/path/to/jacket.jpg\"]"
            ),
          edit_mode: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, automatically uses the last generated image as the first reference. " +
              "Use this for iterative edits within the same conversation " +
              "(e.g. generate an image, then say 'make the sky red' with edit_mode=true). " +
              "Can be combined with reference_images — last image is prepended."
            ),
          session_id: tool.schema
            .string()
            .optional()
            .describe(
              "Session ID for multi-turn generation. Pass the same session_id across multiple calls " +
              "to maintain character consistency and conversation context. " +
              "The session stores the full dialogue history (images + text) at the project level."
            ),
          count: tool.schema
            .number()
            .optional()
            .describe(
              "Number of image variations to generate in a single call (1-4, default: 1). " +
              "When count > 1, all variations are saved as separate files and their paths are returned."
            ),
        },
        async execute(args, context) {
          const { prompt, filename, output_dir, aspect_ratio, image_size, reference_images, edit_mode, session_id, count } = args;

          if (!prompt?.trim()) {
            return "Error: Please provide a prompt describing the image to generate.";
          }

          // Load all accounts
          const config = await loadAccounts();
          if (!config?.accounts?.length) {
            return (
              "Error: No Antigravity account found.\n\n" +
              "Please install and configure opencode-antigravity-auth first:\n" +
              "  1. Add 'opencode-antigravity-auth' to your opencode plugins\n" +
              "  2. Authenticate with your Google account\n\n" +
              `Checked paths:\n${CONFIG_PATHS.map((p) => `  - ${p}`).join("\n")}`
            );
          }

          // Resolve reference images list, injecting last generated image if edit_mode
          let resolvedRefs: string[] = reference_images ?? [];
          if (edit_mode) {
            const lastPath = await loadLastGeneratedPath();
            if (!lastPath) {
              return (
                "Error: edit_mode=true but no previously generated image was found.\n\n" +
                "Generate an image first, then use edit_mode=true to refine it."
              );
            }
            resolvedRefs = [lastPath, ...resolvedRefs];
          }

          // Load or create session
          const sessionHistory = session_id
            ? getSessionHistory((await loadSession(session_id, ctx.directory)) ?? createSession(session_id))
            : undefined;

          const refCount = resolvedRefs.length;
          const editLabel = edit_mode ? " [edit mode]" : "";
          const sessionLabel = session_id ? ` [session: ${session_id}]` : "";
          const countRequested = Math.min(Math.max(count ?? 1, 1), 4);
          const countLabel = countRequested > 1 ? ` x${countRequested}` : "";
          const titleSuffix = refCount > 0 ? ` (${refCount} reference image${refCount > 1 ? "s" : ""})` : "";
          context.metadata({ title: `Generating image...${editLabel}${sessionLabel}${countLabel}${titleSuffix}` });

          // Build generation options
          const options: ImageGenerationOptions = {};
          if (aspect_ratio) options.aspectRatio = aspect_ratio as AspectRatio;
          if (image_size) options.imageSize = image_size as ImageSize;
          if (countRequested > 1) options.count = countRequested;
          const genOptions = Object.keys(options).length > 0 ? options : undefined;

          // Retry loop: rotate through accounts on any failure
          const excludeEmails: string[] = [];
          const errors: string[] = [];

          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const account = selectAccount(config, excludeEmails);
            if (!account) break;

            const result = await generateImage(account, prompt, genOptions, resolvedRefs, sessionHistory);

            if (result.success && result.imageData) {
              await markAccountUsed(config, account.email);

              // Update soft quota cache if we got quota info back
              if (result.quota) {
                updateCachedQuota(
                  config,
                  account.email,
                  result.quota.remainingPercent / 100,
                  result.quota.resetTime
                );
                await saveAccounts(config);
              }

              // Determine output path and extension from API response MIME type
              const dir = output_dir || ctx.directory;
              const ext = result.mimeType === "image/png" ? ".png" : result.mimeType === "image/webp" ? ".webp" : ".jpg";

              const allImages = result.images ?? [{ imageData: result.imageData, mimeType: result.mimeType!, sizeBytes: result.sizeBytes! }];
              const savedPaths: string[] = [];

              for (let i = 0; i < allImages.length; i++) {
                const img = allImages[i];
                const imgExt = img.mimeType === "image/png" ? ".png" : img.mimeType === "image/webp" ? ".webp" : ".jpg";
                let name: string;
                if (allImages.length === 1) {
                  name = filename || `generated_${Date.now()}${imgExt}`;
                } else {
                  // For multiple images: append _1, _2, ... suffix before extension
                  const base = filename
                    ? filename.replace(/\.[^.]+$/, "")
                    : `generated_${Date.now()}`;
                  name = `${base}_${i + 1}${imgExt}`;
                }
                const outputPath = join(dir, name);

                // Ensure directory exists
                const outDir = dirname(outputPath);
                if (!existsSync(outDir)) {
                  await fs.mkdir(outDir, { recursive: true });
                }

                const imageBuffer = Buffer.from(img.imageData, "base64");
                await fs.writeFile(outputPath, imageBuffer);
                savedPaths.push(outputPath);
              }

              // Persist last path (first image) for future edit_mode calls
              await saveLastGeneratedPath(savedPaths[0]);

              // Update session history if session_id was provided
              if (session_id) {
                let session = (await loadSession(session_id, ctx.directory)) ?? createSession(session_id);

                // Build user turn: reference images + prompt text
                const userParts: import("./types").ContentPart[] = [];
                // We don't re-encode reference images into session (too large), just the prompt text
                userParts.push({ text: prompt });
                addUserMessage(session, userParts);

                // Build model turn from API candidates
                if (result._candidates) {
                  const modelParts = buildModelResponseContent(result._candidates);
                  if (modelParts) {
                    addModelMessage(session, modelParts);
                  }
                }

                await saveSession(session, ctx.directory);
              }

              const firstBuffer = Buffer.from(result.imageData, "base64");
              const sizeStr = formatSize(firstBuffer.length);
              const totalAccounts = config.accounts.length;
              const usedLabel = totalAccounts > 1 ? ` (account: ${account.email})` : "";

              context.metadata({
                title: edit_mode ? "Image edited" : "Image generated",
                metadata: {
                  path: savedPaths[0],
                  size: sizeStr,
                  format: result.mimeType,
                  references: String(refCount),
                  editMode: String(!!edit_mode),
                  count: String(allImages.length),
                  ...(session_id ? { session: session_id } : {}),
                },
              });

              let response = edit_mode
                ? `Image edited successfully!${usedLabel}\n\n`
                : `Image generated successfully!${usedLabel}\n\n`;

              if (allImages.length === 1) {
                response += `Path: ${savedPaths[0]}\n`;
                response += `Size: ${sizeStr}\n`;
                response += `Format: ${result.mimeType}\n`;
              } else {
                response += `Generated ${allImages.length} variations:\n`;
                for (const p of savedPaths) {
                  response += `  ${p}\n`;
                }
                response += `Format: ${result.mimeType}\n`;
              }

              if (session_id) {
                response += `Session: ${session_id}\n`;
              }
              if (edit_mode) {
                response += `Edit mode: used last generated image as reference\n`;
              } else if (refCount > 0) {
                response += `References used: ${refCount}\n`;
              }
              if (result.quota) {
                response += `\nQuota: ${formatQuota(result.quota.remainingPercent)} remaining`;
              }
              // Warn about any reference images that failed to load (non-fatal)
              if (result.referenceErrors && result.referenceErrors.length > 0) {
                response += `\n\nWarning: Some reference images could not be loaded:\n`;
                response += result.referenceErrors.map((e) => `  - ${e}`).join("\n");
              }

              return response;
            }

            // Rate-limited: mark with cooldown so future calls skip it too
            if (result.isRateLimited) {
              await markAccountRateLimited(config, account.email);
            }

            // Any failure: log it and try the next account
            const reason = result.isRateLimited
              ? "rate-limited"
              : result.isCapacityError
                ? "no capacity (503, retries exhausted)"
                : (result.error || "unknown error");
            errors.push(`${account.email}: ${reason}`);
            excludeEmails.push(account.email);
          }

          // All accounts failed — build a helpful summary
          const anyCapacity = errors.some((e) => e.includes("no capacity"));
          const anyRateLimit = errors.some((e) => e.includes("rate-limited"));

          let msg = "Error: Image generation failed.\n\n";
          if (errors.length > 0) {
            msg += "Accounts tried:\n";
            msg += errors.map((e) => `  - ${e}`).join("\n") + "\n\n";
          } else {
            msg += "No accounts available to try.\n\n";
          }
          msg += "Possible fixes:\n";
          if (anyCapacity) {
            msg += "  - 503 errors = Google servers overloaded. Wait 30-60 seconds and try again\n";
          }
          if (anyRateLimit) {
            msg += "  - Rate-limited: wait a few minutes for quota to reset\n";
          }
          msg += "  - If project ID errors, open the Antigravity IDE once with that Google account\n";
          msg += "  - Run image_quota to check account status";
          return msg;
        },
      }),

      /**
       * Check quota for image generation model
       */
      image_quota: tool({
        description:
          "Check the remaining quota for the Gemini image model (auto-detected). " +
          "Shows percentage remaining and time until reset.",
        args: {},
        async execute(args, context) {
          const config = await loadAccounts();
          if (!config?.accounts?.length) {
            return (
              "Error: No Antigravity account found.\n" +
              "Please configure opencode-antigravity-auth first."
            );
          }

          context.metadata({ title: "Checking quota..." });

          const accounts = config.accounts;
          const isSingle = accounts.length === 1;

          // Single account: keep the original compact output
          if (isSingle) {
            const quota = await getImageModelQuota(accounts[0]);
            if (!quota) return "Error: Could not fetch quota information.";

            context.metadata({
              title: "Quota",
              metadata: {
                remaining: `${quota.remainingPercent.toFixed(0)}%`,
                resetIn: quota.resetIn,
              },
            });

            const barWidth = 20;
            const filled = Math.round((quota.remainingPercent / 100) * barWidth);
            const bar = "#".repeat(filled) + ".".repeat(barWidth - filled);

            let response = `${quota.modelName}\n\n`;
            response += `[${bar}] ${quota.remainingPercent.toFixed(0)}% remaining\n`;
            response += `Resets in: ${quota.resetIn}`;
            if (quota.resetTime) {
              const resetDate = new Date(quota.resetTime);
              response += ` (at ${resetDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
            }
            return response;
          }

          // Multi-account: show per-account breakdown
          let response = `Image quota -- ${accounts.length} accounts\n\n`;
          const now = Date.now();

          for (const account of accounts) {
            const quota = await getImageModelQuota(account);
            const rateLimited = account.rateLimitedUntil && account.rateLimitedUntil > now;

            if (quota) {
              const barWidth = 20;
              const filled = Math.round((quota.remainingPercent / 100) * barWidth);
              const bar = "#".repeat(filled) + ".".repeat(barWidth - filled);
              const flag = rateLimited ? " [rate-limited]" : "";
              response += `${account.email}${flag}\n`;
              response += `  [${bar}] ${quota.remainingPercent.toFixed(0)}% -- resets in ${quota.resetIn}\n`;
            } else {
              response += `${account.email}\n`;
              response += `  [error fetching quota]\n`;
            }
          }

          context.metadata({
            title: "Quota",
            metadata: { accounts: String(accounts.length) },
          });

          return response;
        },
      }),
    },
  };
};

export default plugin;
