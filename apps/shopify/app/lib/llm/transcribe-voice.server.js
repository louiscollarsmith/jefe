// @ts-check

// Voice-note transcription via Gemini (multimodal — no new STT vendor). Self-contained: it builds
// its own GoogleGenAI client from config and sends the audio as an inline part, so it doesn't
// touch the shared text-only provider. Metered through the cost ledger (feature "voice_feedback").
//
// Model: defaults to a Gemini audio-capable model, overridable via VOICE_TRANSCRIBE_MODEL. The
// shared text model may be OpenAI/Groq-only and may not accept audio input. VERIFY the chosen
// Gemini model transcribes audio before flipping ENABLE_VOICE_FEEDBACK (a go-live step); until then
// this is dark/unused.

import { GoogleGenAI } from "@google/genai";
import { getLlmConfig } from "./config.server.js";
import { assertExternalLlmCallAllowed } from "./external-call-guard.server.js";
import { recordLlmUsage } from "./usage-recorder.server.js";

const TRANSCRIBE_PROMPT =
  "Transcribe this voice note from a Shopify merchant into plain text, verbatim. Output only the transcript — no preamble, no commentary.";
const DEFAULT_VOICE_TRANSCRIBE_MODEL = "gemini-3.1-flash-lite";

/** @param {NodeJS.ProcessEnv} [env] */
export function getVoiceTranscribeModel(env = process.env) {
  return (
    env.VOICE_TRANSCRIBE_MODEL ||
    env.LLM_FALLBACK_MODEL ||
    getLlmConfig({ env }).fallbackModel ||
    DEFAULT_VOICE_TRANSCRIBE_MODEL
  );
}

/** Pure: pull the transcript text out of a GoogleGenAI response (with a parts fallback). */
export function extractTranscript(response) {
  if (typeof response?.text === "string") return response.text;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text ?? "").join("");
  return "";
}

/**
 * Transcribe an audio buffer to text. Meters the call (best-effort). Throws if the LLM isn't
 * configured or the provider errors — the caller keeps it best-effort.
 *
 * @param {{ prisma?: any, audioBase64: string, mimeType: string, merchantId?: string|null, shopId?: string|null, client?: { models: { generateContent: Function } } }} input
 * @returns {Promise<{ transcript: string, model: string }>}
 */
export async function transcribeVoiceNote(input) {
  const config = getLlmConfig();
  const hasInjectedTransport = Boolean(input.client);
  if ((!config.enabled || !config.geminiApiKey) && !hasInjectedTransport) {
    throw new Error("LLM is not configured (GEMINI_API_KEY missing) — cannot transcribe voice note.");
  }
  assertExternalLlmCallAllowed({ hasInjectedTransport });
  const model = getVoiceTranscribeModel();
  const client = input.client ?? new GoogleGenAI({ apiKey: config.geminiApiKey });

  let response;
  try {
    response = await client.models.generateContent({
      model,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: input.mimeType, data: input.audioBase64 } },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
    });
  } catch (err) {
    if (input.prisma) {
      await recordLlmUsage(input.prisma, {
        provider: "gemini",
        model, feature: "voice_feedback", runType: "transcription", status: "error",
        merchantId: input.merchantId, shopId: input.shopId, usage: null,
      }).catch(() => {});
    }
    throw err;
  }

  const transcript = extractTranscript(response).trim();
  if (input.prisma) {
    await recordLlmUsage(input.prisma, {
      provider: "gemini",
      model, feature: "voice_feedback", runType: "transcription", status: "ok",
      merchantId: input.merchantId, shopId: input.shopId,
      usage: {
        inputTokens: response?.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response?.usageMetadata?.candidatesTokenCount ?? null,
        totalTokens: response?.usageMetadata?.totalTokenCount ?? null,
      },
    }).catch(() => {});
  }
  return { transcript, model };
}
