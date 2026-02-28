// Account configuration (from antigravity-accounts.json)
export interface Account {
  email: string;
  refreshToken: string;
  accessToken?: string;
  projectId?: string;
  managedProjectId?: string;
  lastUsed?: number;
  rateLimitedUntil?: number;
  /** Cached quota info to avoid repeated API calls (soft quota) */
  cachedImageQuota?: {
    remainingFraction: number;
    resetTime?: string;
    updatedAt: number;
  };
}

export interface AccountsConfig {
  accounts: Account[];
}

// API responses
export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: { id?: string; name?: string };
  paidTier?: { id?: string; name?: string };
}

export interface CloudCodeQuotaResponse {
  models?: Record<string, ModelInfo>;
}

export interface ModelInfo {
  displayName?: string;
  model?: string;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
}

// ── Image generation types ──

// Supported aspect ratios (Google Gemini image API)
export type AspectRatio =
  | "1:1" | "2:3" | "3:2" | "3:4" | "4:3"
  | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

// Supported output resolutions
export type ImageSize = "1K" | "2K" | "4K";

/**
 * Image generation options passed to the Google API.
 * This interface is intentionally extensible — new fields can be added
 * as Google exposes more parameters without breaking existing code.
 */
export interface ImageGenerationOptions {
  /** Aspect ratio of the generated image (default: from constants) */
  aspectRatio?: AspectRatio;
  /** Output resolution (default: from constants) */
  imageSize?: ImageSize;
  /**
   * Number of image variations to generate (1–4, default: 1).
   * Maps to candidateCount in the Google API request.
   */
  count?: number;
  /**
   * Catch-all for any future Google API parameters we haven't typed yet.
   * Allows passing arbitrary key-value pairs into generationConfig.imageConfig.
   */
  [key: string]: unknown;
}

/**
 * imageConfig object sent inside generationConfig to the Google API.
 * Mirrors ImageGenerationOptions but kept separate for clarity.
 */
export interface ImageConfig {
  aspectRatio?: AspectRatio;
  imageSize?: ImageSize;
  [key: string]: unknown;
}

// ── Multimodal content parts ──

/** A text-only part */
export interface TextPart {
  text: string;
}

/** An inline binary data part (image, etc.) */
export interface InlineDataPart {
  inlineData: {
    mimeType: string;
    data: string; // base64-encoded
  };
}

/** Union of all part types that can appear in a request */
export type ContentPart = TextPart | InlineDataPart;

export interface GenerateContentRequest {
  project: string;
  requestId: string;
  model: string;
  userAgent: string;
  requestType: string;
  request: {
    contents: Array<{
      role: string;
      parts: ContentPart[];
    }>;
    session_id: string;
    generationConfig: {
      responseModalities: string[];
      imageConfig?: ImageConfig;
      candidateCount?: number;
      [key: string]: unknown;
    };
    safetySettings?: Array<{
      category: string;
      threshold: string;
    }>;
  };
}

export interface GenerateContentResponse {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          thought?: boolean;
          inlineData?: {
            mimeType: string;
            data: string;
          };
        }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

export interface ImageGenerationResult {
  success: boolean;
  imagePath?: string;
  imageData?: string;  // base64 — first image (backward-compat)
  mimeType?: string;
  sizeBytes?: number;
  /** All generated images when count > 1 */
  images?: Array<{ imageData: string; mimeType: string; sizeBytes: number }>;
  error?: string;
  /** True when ALL endpoints returned 429 (rate limit) */
  isRateLimited?: boolean;
  /** True when ALL endpoints returned 503 (no capacity) after retries */
  isCapacityError?: boolean;
  /** Errors that occurred while loading individual reference images (non-fatal) */
  referenceErrors?: string[];
  quota?: {
    remainingPercent: number;
    resetTime: string;
  };
  /** @internal Raw API candidates — used to build session model turn */
  _candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
    finishReason?: string;
  }>;
}

export interface QuotaInfo {
  modelName: string;
  remainingPercent: number;
  resetTime: string;
  resetIn: string;
}

// ── Sessions ──

export interface SessionTurn {
  role: "user" | "model";
  parts: ContentPart[];
}

/**
 * A session stores conversation history for character-consistent generation.
 * Stored as a JSON file in <worktree>/.opencode/generated-image-sessions/<id>.json
 */
export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  history: SessionTurn[];
}
