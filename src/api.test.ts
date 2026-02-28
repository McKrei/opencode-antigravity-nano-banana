import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { loadReferenceImage, loadReferenceImages, detectImageModel } from "./api";
import { SUPPORTED_IMAGE_MIMES, MAX_REFERENCE_IMAGES } from "./constants";
import type { CloudCodeQuotaResponse } from "./types";

// ── Test fixture directory ────────────────────────────────────────────────────
// All test images go here and are gitignored via test_output/

const FIXTURES_DIR = join(import.meta.dir, "../test_output/fixtures");

/**
 * Create a minimal valid PNG (1×1 red pixel, 67 bytes).
 * This is the smallest valid PNG that most parsers accept.
 */
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
  "2e00000000c4944415478016360f8cf000000020001e221bc330000000049454e44ae426082",
  "hex"
);

/** A minimal JPEG — SOI + EOI, 4 bytes */
const TINY_JPEG = Buffer.from("ffd8ffe0ffd9", "hex");

/** A minimal WEBP — RIFF header + WEBP tag (12 bytes) */
const TINY_WEBP = Buffer.from("52494646" + "00000000" + "57454250", "hex");

beforeAll(async () => {
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(join(FIXTURES_DIR, "image.png"), TINY_PNG);
  await writeFile(join(FIXTURES_DIR, "image.jpg"), TINY_JPEG);
  await writeFile(join(FIXTURES_DIR, "image.jpeg"), TINY_JPEG);
  await writeFile(join(FIXTURES_DIR, "image.webp"), TINY_WEBP);
  await writeFile(join(FIXTURES_DIR, "image.bmp"), Buffer.from("424d", "hex")); // BMP magic
  await writeFile(join(FIXTURES_DIR, "image.gif"), Buffer.from("474946383961", "hex")); // GIF89a
  await writeFile(join(FIXTURES_DIR, "document.txt"), Buffer.from("hello"));
});

afterAll(async () => {
  await rm(FIXTURES_DIR, { recursive: true, force: true });
});

// ── loadReferenceImage ────────────────────────────────────────────────────────

describe("loadReferenceImage", () => {
  test("loads PNG and returns correct mimeType", async () => {
    const part = await loadReferenceImage(join(FIXTURES_DIR, "image.png"));
    expect(part).toHaveProperty("inlineData");
    if ("inlineData" in part) {
      expect(part.inlineData.mimeType).toBe("image/png");
      expect(part.inlineData.data).toBeTruthy();
      // Verify it's valid base64
      const decoded = Buffer.from(part.inlineData.data, "base64");
      expect(decoded.length).toBe(TINY_PNG.length);
    }
  });

  test("loads JPEG (.jpg) with correct mimeType", async () => {
    const part = await loadReferenceImage(join(FIXTURES_DIR, "image.jpg"));
    if ("inlineData" in part) {
      expect(part.inlineData.mimeType).toBe("image/jpeg");
    }
  });

  test("loads JPEG (.jpeg) with correct mimeType", async () => {
    const part = await loadReferenceImage(join(FIXTURES_DIR, "image.jpeg"));
    if ("inlineData" in part) {
      expect(part.inlineData.mimeType).toBe("image/jpeg");
    }
  });

  test("loads WEBP with correct mimeType", async () => {
    const part = await loadReferenceImage(join(FIXTURES_DIR, "image.webp"));
    if ("inlineData" in part) {
      expect(part.inlineData.mimeType).toBe("image/webp");
    }
  });

  test("loads BMP with correct mimeType", async () => {
    const part = await loadReferenceImage(join(FIXTURES_DIR, "image.bmp"));
    if ("inlineData" in part) {
      expect(part.inlineData.mimeType).toBe("image/bmp");
    }
  });

  test("loads GIF with correct mimeType", async () => {
    const part = await loadReferenceImage(join(FIXTURES_DIR, "image.gif"));
    if ("inlineData" in part) {
      expect(part.inlineData.mimeType).toBe("image/gif");
    }
  });

  test("throws for unsupported extension (.txt)", async () => {
    await expect(
      loadReferenceImage(join(FIXTURES_DIR, "document.txt"))
    ).rejects.toThrow('Unsupported image format: ".txt"');
  });

  test("throws for non-existent file", async () => {
    await expect(
      loadReferenceImage(join(FIXTURES_DIR, "nonexistent.png"))
    ).rejects.toThrow();
  });

  test("returned data is non-empty base64 string", async () => {
    const part = await loadReferenceImage(join(FIXTURES_DIR, "image.png"));
    if ("inlineData" in part) {
      expect(typeof part.inlineData.data).toBe("string");
      expect(part.inlineData.data.length).toBeGreaterThan(0);
      // Base64 chars only (no whitespace or padding issues)
      expect(part.inlineData.data).toMatch(/^[A-Za-z0-9+/]+=*$/);
    }
  });

  test("error message lists all supported extensions", async () => {
    try {
      await loadReferenceImage(join(FIXTURES_DIR, "document.txt"));
    } catch (err) {
      const message = (err as Error).message;
      for (const ext of Object.keys(SUPPORTED_IMAGE_MIMES)) {
        expect(message).toContain(ext);
      }
    }
  });
});

// ── loadReferenceImages ───────────────────────────────────────────────────────

describe("loadReferenceImages", () => {
  test("returns empty parts and errors for empty input", async () => {
    const { parts, errors } = await loadReferenceImages([]);
    expect(parts).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("loads multiple valid images", async () => {
    const paths = [
      join(FIXTURES_DIR, "image.png"),
      join(FIXTURES_DIR, "image.jpg"),
      join(FIXTURES_DIR, "image.webp"),
    ];
    const { parts, errors } = await loadReferenceImages(paths);
    expect(parts).toHaveLength(3);
    expect(errors).toHaveLength(0);

    const mimes = parts
      .filter((p) => "inlineData" in p)
      .map((p) => ("inlineData" in p ? p.inlineData.mimeType : ""));
    expect(mimes).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  test("reports errors for bad paths but still loads valid ones", async () => {
    const paths = [
      join(FIXTURES_DIR, "image.png"),
      join(FIXTURES_DIR, "nonexistent.png"),
      join(FIXTURES_DIR, "document.txt"),
      join(FIXTURES_DIR, "image.jpg"),
    ];
    const { parts, errors } = await loadReferenceImages(paths);
    expect(parts).toHaveLength(2); // only the two valid images
    expect(errors).toHaveLength(2); // nonexistent + unsupported
    expect(errors.some((e) => e.includes("nonexistent.png"))).toBeTrue();
    expect(errors.some((e) => e.includes("document.txt"))).toBeTrue();
  });

  test(`silently truncates to ${MAX_REFERENCE_IMAGES} images`, async () => {
    // Create MAX_REFERENCE_IMAGES + 2 paths (all valid)
    const paths = Array.from(
      { length: MAX_REFERENCE_IMAGES + 2 },
      () => join(FIXTURES_DIR, "image.png")
    );
    const { parts, errors } = await loadReferenceImages(paths);
    expect(parts).toHaveLength(MAX_REFERENCE_IMAGES);
    expect(errors).toHaveLength(0);
  });

  test("all errors, no parts — when all paths are invalid", async () => {
    const paths = [
      join(FIXTURES_DIR, "a.png"),  // doesn't exist
      join(FIXTURES_DIR, "b.png"),  // doesn't exist
    ];
    const { parts, errors } = await loadReferenceImages(paths);
    expect(parts).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  test("each InlineDataPart has mimeType and non-empty data", async () => {
    const { parts } = await loadReferenceImages([
      join(FIXTURES_DIR, "image.png"),
      join(FIXTURES_DIR, "image.jpg"),
    ]);
    for (const part of parts) {
      expect("inlineData" in part).toBeTrue();
      if ("inlineData" in part) {
        expect(part.inlineData.mimeType).toBeTruthy();
        expect(part.inlineData.data.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── detectImageModel ──────────────────────────────────────────────────────────

describe("detectImageModel", () => {
  test("returns null for empty models response", () => {
    const response: CloudCodeQuotaResponse = {};
    expect(detectImageModel(response)).toBeNull();
  });

  test("returns null when no image models present", () => {
    const response: CloudCodeQuotaResponse = {
      models: {
        "gemini-2.5-flash": { displayName: "Gemini 2.5 Flash" },
        "claude-sonnet-4": { displayName: "Claude Sonnet 4" },
      },
    };
    expect(detectImageModel(response)).toBeNull();
  });

  test("picks highest-priority candidate first", () => {
    // Both gemini-3.1-flash-image and gemini-3-pro-image are present
    // gemini-3.1-flash-image has higher priority (index 0 in candidates)
    const response: CloudCodeQuotaResponse = {
      models: {
        "gemini-3-pro-image": { displayName: "Gemini 3 Pro Image" },
        "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" },
      },
    };
    expect(detectImageModel(response)).toBe("gemini-3.1-flash-image");
  });

  test("falls back to second candidate when first not available", () => {
    const response: CloudCodeQuotaResponse = {
      models: {
        "gemini-3-pro-image": { displayName: "Gemini 3 Pro Image" },
        "gemini-2.5-flash": { displayName: "Gemini 2.5 Flash" },
      },
    };
    expect(detectImageModel(response)).toBe("gemini-3-pro-image");
  });

  test("falls back to any model containing 'image' when no candidates match", () => {
    const response: CloudCodeQuotaResponse = {
      models: {
        "gemini-future-image-v99": { displayName: "Future Image Model" },
        "gemini-2.5-flash": { displayName: "Gemini 2.5 Flash" },
      },
    };
    expect(detectImageModel(response)).toBe("gemini-future-image-v99");
  });

  test("returns null when models object is present but empty", () => {
    const response: CloudCodeQuotaResponse = { models: {} };
    expect(detectImageModel(response)).toBeNull();
  });

  test("is case-insensitive for the 'image' fallback", () => {
    const response: CloudCodeQuotaResponse = {
      models: {
        "gemini-IMAGE-model": { displayName: "IMAGE Model" },
      },
    };
    expect(detectImageModel(response)).toBe("gemini-IMAGE-model");
  });
});
