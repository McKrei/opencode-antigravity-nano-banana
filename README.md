# opencode-antigravity-nano-banana

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-nano-banana.svg)](https://www.npmjs.com/package/opencode-antigravity-nano-banana)
[![npm downloads](https://img.shields.io/npm/dm/opencode-antigravity-nano-banana.svg)](https://www.npmjs.com/package/opencode-antigravity-nano-banana)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenCode](https://opencode.ai) plugin for generating and editing images using Google's latest Gemini image models, powered by the Antigravity/CloudCode API — no separate API key required.

---

## Features

- **Auto-detected model** — always uses the best available Gemini image model (currently `gemini-2.5-flash-preview-image`, with automatic fallback to newer models as they become available)
- **Reference images** — supply up to 10 local images as visual context for style transfer, inpainting, and composition
- **Edit mode** — iteratively refine the last generated image in one conversation without re-specifying paths
- **Sessions** — maintain character/style consistency across multiple generations via persistent conversation history
- **Multiple variations** — generate up to 4 image variants in a single call
- **Multi-account round-robin** — rotate through Google accounts with automatic failover, rate-limit tracking, and soft quota management
- **Reduced blocking** — safety thresholds set to `BLOCK_ONLY_HIGH` to minimize unnecessary rejections
- **Retry on capacity errors** — automatic exponential backoff on 503 responses across multiple API endpoints

---

## Requirements

- [OpenCode](https://opencode.ai) installed
- Google One AI Premium subscription
- Authentication via [opencode-antigravity-auth](https://www.npmjs.com/package/opencode-antigravity-auth) plugin

---

## Installation

Add both the auth plugin and this plugin to your `opencode.json`:

```json
{
  "plugin": [
    "opencode-antigravity-auth",
    "opencode-antigravity-nano-banana"
  ]
}
```

Then authenticate once:

```
opencode
# Use the authenticate command from opencode-antigravity-auth
```

This creates `antigravity-accounts.json` in your OpenCode config directory. You're ready to generate.

---

## Tools

### `generate_image`

Generate or edit an image from a text prompt.

| Argument | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | required | Text description of the image |
| `filename` | string | auto | Output filename |
| `output_dir` | string | cwd | Output directory |
| `aspect_ratio` | string | `1:1` | `1:1` `2:3` `3:2` `3:4` `4:3` `4:5` `5:4` `9:16` `16:9` `21:9` |
| `image_size` | string | `1K` | `1K` `2K` `4K` |
| `reference_images` | string[] | — | Absolute paths to local reference images (up to 10) |
| `edit_mode` | boolean | `false` | Use last generated image as the first reference |
| `session_id` | string | — | Session ID for multi-turn style consistency |
| `count` | number | `1` | Number of variations to generate (1–4) |

**Returns:** path(s) to generated file(s), size, format, quota remaining.

---

### `image_quota`

Check remaining quota for the image model.

| Account setup | Output |
|---|---|
| Single account | Progress bar with % remaining and time to reset |
| Multiple accounts | Per-account progress bars with rate-limit status |

---

## Usage Examples

### Basic generation

```
Generate a photorealistic image of a fox sitting in autumn forest, golden hour lighting
```

### High-resolution with aspect ratio

```
Generate a 16:9 cinematic landscape of a cyberpunk city at night, 2K resolution
```

### Reference images — style transfer

```
Generate a portrait in the style of /path/to/reference.jpg, reference_images=["/path/to/reference.jpg"]
```

### Iterative editing

```
# First generation
Generate a cozy coffee shop interior with warm lighting

# Refine without re-specifying paths
Now add a cat sleeping on the counter, edit_mode=true
```

### Session — character consistency

```
# Turn 1
Generate a red-haired female warrior in fantasy armor, session_id="my-character"

# Turn 2 — model remembers the character
Now show her in a snowy mountain landscape, session_id="my-character"
```

### Multiple variations

```
Generate a minimalist logo for a tech startup, count=4, aspect_ratio=1:1
```

---

## Multi-Account Setup

Add multiple Google accounts for higher throughput and automatic failover:

```
opencode auth login  # repeat for each account
```

With multiple accounts the plugin:

- **Round-robins** between accounts (least-recently-used first)
- **Deprioritizes** accounts below 10% remaining quota (soft quota)
- **Retries** automatically on rate-limit or auth error
- **Tracks cooldowns** — rate-limited accounts are skipped for 5 minutes
- **Shows per-account quota** via `image_quota`

Single-account users see no behavior change.

---

## Sessions

Sessions store the full dialogue history (user prompts + generated images) at the project level:

```
<project-root>/.opencode/generated-image-sessions/<session-id>.json
```

Pass the same `session_id` across multiple calls to give the model memory of prior generations. Useful for:

- Maintaining a consistent character across scenes
- Iterating on a design system with a shared visual language
- Building a storyboard with narrative continuity

Sessions are per-project and stored as plain JSON — you can inspect, share, or delete them manually.

---

## Architecture

```
src/
├── index.ts        Plugin entry — tool definitions, execute handlers
├── api.ts          Gemini API client (auth, request building, SSE parsing)
├── accounts.ts     Multi-account selection, rate-limit tracking, soft quota
├── sessions.ts     Session persistence (load/save/history helpers)
├── state.ts        Last-generated-path persistence (for edit_mode)
├── types.ts        TypeScript interfaces
└── constants.ts    API endpoints, model candidates, safety settings, defaults
```

Key design decisions:

- **No build step** — runs directly via Bun, TypeScript executed natively
- **SSE streaming** — uses `streamGenerateContent?alt=sse` endpoint for lower latency
- **Extensible options** — `ImageGenerationOptions` has `[key: string]: unknown` so new Google API params can be passed without code changes
- **Soft quota** — cached `remainingFraction` from the last quota check deprioritizes near-empty accounts without an extra API call on every generation

---

## Supported Image Formats (reference input)

PNG, JPEG, WEBP, GIF, BMP

Output format is always determined by the API response (typically PNG).

---

## API Endpoints

The plugin tries each endpoint in order, with exponential backoff on 503:

1. `https://daily-cloudcode-pa.googleapis.com` (primary)
2. `https://daily-cloudcode-pa.sandbox.googleapis.com`
3. `https://cloudcode-pa.googleapis.com` (production)

---

## Troubleshooting

**"No Antigravity account found"**
— Install `opencode-antigravity-auth` and authenticate. Check that `antigravity-accounts.json` exists in your OpenCode config directory.

**Generation returns no image / blocked**
— Safety thresholds are already set to `BLOCK_ONLY_HIGH`. Try rephrasing the prompt. The model may still refuse very specific requests.

**503 / no capacity**
— Google's servers are overloaded. The plugin retries automatically (3 attempts, 3s → 6s → 12s backoff) across all endpoints. If all fail, wait 30–60 seconds and retry.

**Rate limited**
— Check quota with `image_quota`. With multiple accounts the plugin automatically moves to the next available one. Quota resets every ~5 hours.

**Slow generation**
— 10–40 seconds is normal. Image synthesis is computationally expensive.

---

## Related Plugins

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) — Authentication (required)
- [opencode-antigravity-web](https://github.com/ominiverdi/opencode-antigravity-web) — Web search and URL reading

## Original Plugin

- [opencode-antigravity-img](https://github.com/ominiverdi/opencode-antigravity-img) — original source

---

## License

MIT
