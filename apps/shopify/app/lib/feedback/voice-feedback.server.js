// @ts-check

// Voice-note feedback — the server seam for the app-home "Tell us what to build" rail's Record
// button. DARK behind ENABLE_VOICE_FEEDBACK (unset = no-op). Flow: audio Blob → Gemini transcript
// → REDACT (merchant speech can carry PII, and the event log is PII-free by construction) → record
// a `merchant_build_request` feedback event via `track()` (surfaced in the ops panel + Slack).
//
// v1 = TRANSCRIPT-ONLY (founder call, 2026-07-31): the raw audio is NOT persisted — the app has no
// blob storage, and keeping audio is a new-vendor/PII decision left to the founder. Reuses the
// existing multipart-upload transport (the Goals-doc `GoodsDocumentUploadCard` pattern) + the
// existing `track()` sink — no new infra, no migration.
//
// The client audio capture (MediaRecorder) + the `feedback.voice` action intent live in the
// surface lane (app-home / app._index); this module is the callable they POST to.

import { transcribeVoiceNote } from "../llm/transcribe-voice.server.js";
import { redact } from "../observability/redact.server.js";
import { track } from "../../services/analytics/event-log.server.js";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // keep on the single-request Gemini inline path
const ALLOWED_MIME = /^audio\//i;

/** @param {NodeJS.ProcessEnv} [env] */
export function isVoiceFeedbackEnabled(env = process.env) {
  return env.ENABLE_VOICE_FEEDBACK === "true";
}

/**
 * @param {any} prisma
 * @param {{ file: { arrayBuffer: () => Promise<ArrayBuffer>, type?: string, size?: number } | null | undefined, merchantId?: string|null, shopId?: string|null, shopDomain?: string|null }} input
 * @param {{ transcribe?: typeof transcribeVoiceNote, trackEvent?: typeof track, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {Promise<{ ok: boolean, reason?: string, recorded?: boolean }>}
 */
export async function processVoiceFeedback(prisma, input, deps = {}) {
  const transcribe = deps.transcribe ?? transcribeVoiceNote;
  const trackEvent = deps.trackEvent ?? track;
  if (!isVoiceFeedbackEnabled(deps.env)) return { ok: false, reason: "disabled" };

  const file = input?.file;
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, reason: "no_file" };
  const mime = file.type || "";
  if (!ALLOWED_MIME.test(mime)) return { ok: false, reason: "bad_mime" };

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return { ok: false, reason: "empty" };
  if (buf.length > MAX_AUDIO_BYTES) return { ok: false, reason: "too_large" };

  const { transcript, model } = await transcribe({
    prisma, audioBase64: buf.toString("base64"), mimeType: mime,
    merchantId: input.merchantId, shopId: input.shopId,
  });

  // Redact before it lands anywhere (merchant speech may contain PII). track() also redacts, but
  // being explicit keeps the transcript clean at the seam. Defensive: if redact() doesn't hand back
  // a usable string, fall back to the raw transcript (track's own redaction still applies on store).
  const redacted = redact(transcript);
  const clean = String(typeof redacted === "string" && redacted.length ? redacted : transcript).trim();
  if (!clean) return { ok: true, reason: "empty_transcript", recorded: false };

  await trackEvent(prisma, {
    type: "merchant_build_request",
    topic: "feedback",
    shopDomain: input.shopDomain ?? undefined,
    summary: clean.slice(0, 280),
    properties: { source: "voice_note", model, transcriptLength: clean.length },
  });

  return { ok: true, recorded: true };
}
