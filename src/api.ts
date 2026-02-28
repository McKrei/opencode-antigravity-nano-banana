import { readFile } from "fs/promises";
import { extname } from "path";

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  GOOGLE_TOKEN_URL,
  CLOUDCODE_BASE_URL,
  CLOUDCODE_FALLBACK_URLS,
  CLOUDCODE_METADATA,
  IMAGE_MODEL,
  IMAGE_MODEL_CANDIDATES,
  IMAGE_GENERATION_TIMEOUT_MS,
  CAPACITY_RETRY_COUNT,
  CAPACITY_RETRY_BASE_DELAY_MS,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_SIZE,
  SUPPORTED_IMAGE_MIMES,
  MAX_REFERENCE_IMAGES,
  SAFETY_SETTINGS,
} from "./constants";
import type {
  Account,
  TokenResponse,
  LoadCodeAssistResponse,
  CloudCodeQuotaResponse,
  GenerateContentResponse,
  ImageGenerationResult,
  ImageGenerationOptions,
  ImageConfig,
  ContentPart,
  SessionTurn,
  QuotaInfo,
} from "./types";

// ── Helpers ──

/** Sleep for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Reference image loading ──

/**
 * Load a local image file and return it as an InlineDataPart.
 * Throws if the file does not exist or the format is unsupported.
 */
export async function loadReferenceImage(filePath: string): Promise<ContentPart> {
  const ext = extname(filePath).toLowerCase();
  const mimeType = SUPPORTED_IMAGE_MIMES[ext];
  if (!mimeType) {
    throw new Error(
      `Unsupported image format: "${ext}". Supported: ${Object.keys(SUPPORTED_IMAGE_MIMES).join(", ")}`
    );
  }

  const data = await readFile(filePath);
  return {
    inlineData: {
      mimeType,
      data: data.toString("base64"),
    },
  };
}

/**
 * Load multiple reference images from local paths.
 * Returns { parts, errors } — images that failed to load are reported in errors
 * but do not abort the whole request.
 */
export async function loadReferenceImages(
  paths: string[]
): Promise<{ parts: ContentPart[]; errors: string[] }> {
  const limited = paths.slice(0, MAX_REFERENCE_IMAGES);
  const parts: ContentPart[] = [];
  const errors: string[] = [];

  for (const p of limited) {
    try {
      parts.push(await loadReferenceImage(p));
    } catch (err) {
      errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { parts, errors };
}

// ── Content builders ──

/**
 * Build the `contents` array for the GenerateContent request.
 *
 * If a session history is provided it is prepended before the current user turn,
 * giving the model conversational context (multi-turn generation).
 *
 * @param prompt         - text prompt for the current turn
 * @param inputImageParts - reference images for the current turn (already loaded)
 * @param sessionHistory - prior turns from the session (user + model)
 */
export function buildContents(
  prompt: string,
  inputImageParts?: ContentPart[],
  sessionHistory?: SessionTurn[]
): Array<{ role: string; parts: ContentPart[] }> {
  const currentParts: ContentPart[] = [
    ...(inputImageParts ?? []),
    { text: prompt },
  ];

  const currentTurn = { role: "user", parts: currentParts };

  if (sessionHistory && sessionHistory.length > 0) {
    return [...sessionHistory, currentTurn];
  }
  return [currentTurn];
}

/**
 * Extract the model's response parts from a parsed SSE response.
 * Used to save the model turn back into the session history.
 *
 * Returns null if no image or text was found (e.g. error response).
 */
export function buildModelResponseContent(
  candidates: NonNullable<GenerateContentResponse["response"]>["candidates"]
): ContentPart[] | null {
  if (!candidates || candidates.length === 0) return null;

  const parts: ContentPart[] = [];

  for (const candidate of candidates) {
    const cParts = candidate.content?.parts ?? [];
    for (const part of cParts) {
      if (part.thought) continue; // skip reasoning tokens
      if (part.inlineData?.data && part.inlineData.mimeType) {
        parts.push({ inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data } });
      } else if (part.text) {
        parts.push({ text: part.text });
      }
    }
  }

  return parts.length > 0 ? parts : null;
}

// ── OAuth ──

/**
 * Refresh an access token using the refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status})`);
  }

  const data = (await response.json()) as TokenResponse;
  return data.access_token;
}

// ── CloudCode API ──

/**
 * Load code assist info to get project ID
 */
export async function loadCodeAssist(accessToken: string): Promise<LoadCodeAssistResponse> {
  const response = await fetch(`${CLOUDCODE_BASE_URL}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    },
    body: JSON.stringify({ metadata: CLOUDCODE_METADATA }),
  });

  if (!response.ok) {
    throw new Error(`loadCodeAssist failed (${response.status})`);
  }

  return (await response.json()) as LoadCodeAssistResponse;
}

/**
 * Extract project ID from cloudaicompanionProject field
 */
export function extractProjectId(project: string | { id?: string } | undefined): string | undefined {
  if (!project) return undefined;
  if (typeof project === "string") return project;
  return project.id;
}

/**
 * Fetch available models with quota info
 */
export async function fetchAvailableModels(
  accessToken: string,
  projectId?: string
): Promise<CloudCodeQuotaResponse> {
  const payload = projectId ? { project: projectId } : {};

  const response = await fetch(`${CLOUDCODE_BASE_URL}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`fetchAvailableModels failed (${response.status})`);
  }

  return (await response.json()) as CloudCodeQuotaResponse;
}

// ── Model detection ──

/**
 * Auto-detect the best available image model from the API.
 * Checks IMAGE_MODEL_CANDIDATES in order, returns the first match.
 * Falls back to any model name containing "image" if no candidate matches.
 */
export function detectImageModel(models: CloudCodeQuotaResponse): string | null {
  const available = models.models || {};
  const keys = Object.keys(available);

  // Try candidates in priority order
  for (const candidate of IMAGE_MODEL_CANDIDATES) {
    if (keys.includes(candidate)) {
      return candidate;
    }
  }

  // Fallback: any model with "image" in its name
  const fallback = keys.find(k => k.toLowerCase().includes("image"));
  return fallback || null;
}

// ── Quota ──

/**
 * Get quota info for the image model
 */
export async function getImageModelQuota(account: Account): Promise<QuotaInfo | null> {
  try {
    const accessToken = await refreshAccessToken(account.refreshToken);
    let projectId = account.projectId || account.managedProjectId;

    if (!projectId) {
      const codeAssist = await loadCodeAssist(accessToken);
      projectId = extractProjectId(codeAssist.cloudaicompanionProject);
    }

    const models = await fetchAvailableModels(accessToken, projectId);

    // Auto-detect image model
    const resolvedModel = detectImageModel(models) || IMAGE_MODEL;
    const imageModel = models.models?.[resolvedModel];

    if (!imageModel?.quotaInfo) {
      return null;
    }

    const quota = imageModel.quotaInfo;
    const remainingPercent = (quota.remainingFraction ?? 0) * 100;
    const resetTime = quota.resetTime || "";

    // Calculate reset in human readable
    let resetIn = "N/A";
    if (resetTime) {
      const resetDate = new Date(resetTime);
      const now = Date.now();
      const diffMs = resetDate.getTime() - now;
      if (diffMs > 0) {
        const hours = Math.floor(diffMs / 3600000);
        const mins = Math.floor((diffMs % 3600000) / 60000);
        resetIn = `${hours}h ${mins}m`;
      } else {
        resetIn = "now";
      }
    }

    return {
      modelName: imageModel.displayName || resolvedModel,
      remainingPercent,
      resetTime,
      resetIn,
    };
  } catch (error) {
    return null;
  }
}

// ── Image generation ──

/**
 * Build imageConfig from options, applying defaults from constants.
 * Any unknown keys in options are passed through to imageConfig as-is,
 * so new Google API parameters can be used without code changes.
 */
function buildImageConfig(options?: ImageGenerationOptions): ImageConfig {
  const config: ImageConfig = {
    aspectRatio: options?.aspectRatio || (DEFAULT_ASPECT_RATIO as any),
    imageSize: options?.imageSize || (DEFAULT_IMAGE_SIZE as any),
  };

  // Forward any extra keys the caller provided (future-proofing)
  if (options) {
    for (const [key, value] of Object.entries(options)) {
      if (key !== "aspectRatio" && key !== "imageSize" && value !== undefined) {
        config[key] = value;
      }
    }
  }

  return config;
}

/**
 * Attempt a single image generation request against one endpoint.
 * Returns the result or a specific error indicator.
 */
async function attemptGeneration(
  baseUrl: string,
  accessToken: string,
  requestBody: Record<string, unknown>,
): Promise<{ result: ImageGenerationResult; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "antigravity",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: response.status,
        result: {
          success: false,
          error: `HTTP ${response.status}: ${errorText.slice(0, 300)}`,
          isRateLimited: response.status === 429,
          isCapacityError: response.status === 503,
        },
      };
    }

    const text = await response.text();
    return { status: 200, result: parseSSEResponse(text) };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: 0,
        result: { success: false, error: `Timeout after ${IMAGE_GENERATION_TIMEOUT_MS / 1000}s` },
      };
    }
    return {
      status: 0,
      result: { success: false, error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Generate an image using the best available Gemini image model.
 *
 * @param account        - authenticated account to use
 * @param prompt         - text description of what to generate
 * @param options        - generation config (aspectRatio, imageSize, count, …)
 * @param referencePaths - optional local file paths to reference images.
 *                         They are inlined into the request before the prompt text,
 *                         so the model can use them as visual context.
 * @param sessionHistory - optional prior conversation turns for multi-turn generation.
 *
 * Retry strategy:
 *  - For each endpoint in CLOUDCODE_FALLBACK_URLS:
 *    - If 503 (no capacity): retry up to CAPACITY_RETRY_COUNT times
 *      with exponential backoff before moving to the next endpoint.
 *    - If 429 (rate limit): skip to next endpoint immediately.
 *    - If success or other error: return immediately.
 */
export async function generateImage(
  account: Account,
  prompt: string,
  options?: ImageGenerationOptions,
  referencePaths?: string[],
  sessionHistory?: SessionTurn[],
): Promise<ImageGenerationResult> {
  try {
    // Get access token
    const accessToken = await refreshAccessToken(account.refreshToken);

    // Get project ID
    let projectId = account.projectId || account.managedProjectId;
    if (!projectId) {
      const codeAssist = await loadCodeAssist(accessToken);
      projectId = extractProjectId(codeAssist.cloudaicompanionProject);
    }

    if (!projectId) {
      return { success: false, error: "Could not determine project ID" };
    }

    // Auto-detect the best available image model
    const models = await fetchAvailableModels(accessToken, projectId);
    const resolvedModel = detectImageModel(models) || IMAGE_MODEL;

    // Build multimodal parts: reference images first, then the text prompt
    const inputImageParts: ContentPart[] = [];
    const referenceErrors: string[] = [];

    if (referencePaths && referencePaths.length > 0) {
      const { parts: imgParts, errors } = await loadReferenceImages(referencePaths);
      inputImageParts.push(...imgParts);
      referenceErrors.push(...errors);
    }

    // Build request body
    const imageConfig = buildImageConfig(options);
    const count = options?.count;

    const generationConfig: Record<string, unknown> = {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig,
    };
    if (count && count > 1) {
      generationConfig.candidateCount = Math.min(count, 4);
    }

    const contents = buildContents(prompt, inputImageParts, sessionHistory);

    const requestBody = {
      project: projectId,
      requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      model: resolvedModel,
      userAgent: "antigravity",
      requestType: "agent",
      request: {
        contents,
        session_id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        generationConfig,
        safetySettings: SAFETY_SETTINGS,
      },
    };

    // Try each endpoint with 503 retries
    let allRateLimited = true;
    let allCapacity = true;
    let lastError = "";

    for (const baseUrl of CLOUDCODE_FALLBACK_URLS) {
      // 503 retry loop with exponential backoff
      for (let retry = 0; retry <= CAPACITY_RETRY_COUNT; retry++) {
        if (retry > 0) {
          const delay = CAPACITY_RETRY_BASE_DELAY_MS * Math.pow(2, retry - 1);
          await sleep(delay);
        }

        const { result, status } = await attemptGeneration(baseUrl, accessToken, requestBody);

        // Success — fetch quota and return
        if (result.success && result.imageData) {
          allRateLimited = false;
          allCapacity = false;

          const quota = await getImageModelQuota(account).catch(() => null);
          return {
            ...result,
            referenceErrors: referenceErrors.length > 0 ? referenceErrors : undefined,
            quota: quota
              ? { remainingPercent: quota.remainingPercent, resetTime: quota.resetTime }
              : undefined,
          };
        }

        // 503 — retry on same endpoint
        if (status === 503) {
          allRateLimited = false;
          lastError = result.error || "No capacity";
          continue;
        }

        // 429 — skip to next endpoint
        if (status === 429) {
          allCapacity = false;
          lastError = result.error || "Rate limited";
          break;
        }

        // Any other error — return immediately
        allRateLimited = false;
        allCapacity = false;
        return {
          ...result,
          referenceErrors: referenceErrors.length > 0 ? referenceErrors : undefined,
        };
      }
    }

    return {
      success: false,
      error: lastError || "All endpoints failed",
      isRateLimited: allRateLimited,
      isCapacityError: allCapacity,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── SSE parsing ──

/**
 * Parse SSE response and extract image data.
 * Supports multi-candidate responses (when count > 1).
 * - The first image found becomes `imageData` (backward-compat).
 * - All images are collected into `images[]`.
 */
export function parseSSEResponse(text: string): ImageGenerationResult {
  const lines = text.split("\n");

  const allImages: Array<{ imageData: string; mimeType: string; sizeBytes: number }> = [];
  let lastCandidates: NonNullable<GenerateContentResponse["response"]>["candidates"] | undefined;

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;

    const jsonStr = line.slice(6);
    if (jsonStr === "[DONE]") continue;

    try {
      const data = JSON.parse(jsonStr) as GenerateContentResponse;

      // Check for error
      if (data.error) {
        return {
          success: false,
          error: `${data.error.code}: ${data.error.message}`,
        };
      }

      const candidates = data.response?.candidates || [];
      if (candidates.length > 0) {
        lastCandidates = candidates;
      }

      // Collect images from all candidates
      for (const candidate of candidates) {
        const parts = candidate.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("image/")) {
            allImages.push({
              imageData: part.inlineData.data,
              mimeType: part.inlineData.mimeType,
              sizeBytes: Math.round((part.inlineData.data.length * 3) / 4),
            });
          }
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (allImages.length === 0) {
    return { success: false, error: "No image in response" };
  }

  const first = allImages[0];
  return {
    success: true,
    imageData: first.imageData,
    mimeType: first.mimeType,
    sizeBytes: first.sizeBytes,
    images: allImages,
    // expose candidates for buildModelResponseContent callers
    ...(lastCandidates ? { _candidates: lastCandidates } : {}),
  };
}
