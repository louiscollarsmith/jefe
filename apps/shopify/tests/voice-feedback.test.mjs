import assert from "node:assert/strict";
import test from "node:test";
import { getVoiceTranscribeModel, extractTranscript } from "../app/lib/llm/transcribe-voice.server.js";
import { isVoiceFeedbackEnabled, processVoiceFeedback } from "../app/lib/feedback/voice-feedback.server.js";

const ON = { ENABLE_VOICE_FEEDBACK: "true" };
const OFF = { ENABLE_VOICE_FEEDBACK: "false" };

function audioFile(bytes = 32, type = "audio/webm") {
  return { type, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

test("isVoiceFeedbackEnabled reads the flag (default off)", () => {
  assert.equal(isVoiceFeedbackEnabled(ON), true);
  assert.equal(isVoiceFeedbackEnabled(OFF), false);
  assert.equal(isVoiceFeedbackEnabled({}), false);
});

test("getVoiceTranscribeModel: default falls back to the app model; override wins", () => {
  assert.equal(typeof getVoiceTranscribeModel({}), "string");
  assert.equal(getVoiceTranscribeModel({ VOICE_TRANSCRIBE_MODEL: "gemini-x-audio" }), "gemini-x-audio");
});

test("extractTranscript: .text, parts fallback, and empty", () => {
  assert.equal(extractTranscript({ text: "hello" }), "hello");
  assert.equal(extractTranscript({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] }), "ab");
  assert.equal(extractTranscript(null), "");
  assert.equal(extractTranscript({}), "");
});

test("processVoiceFeedback: disabled = complete no-op (never transcribes)", async () => {
  const res = await processVoiceFeedback({}, { file: audioFile() }, {
    env: OFF,
    transcribe: async () => { throw new Error("should not run while dark"); },
  });
  assert.deepEqual(res, { ok: false, reason: "disabled" });
});

test("processVoiceFeedback: rejects no-file / bad-mime / empty / too-large before transcribing", async () => {
  const t = async () => ({ transcript: "x", model: "m" });
  assert.equal((await processVoiceFeedback({}, { file: null }, { env: ON, transcribe: t })).reason, "no_file");
  assert.equal((await processVoiceFeedback({}, { file: audioFile(32, "video/mp4") }, { env: ON, transcribe: t })).reason, "bad_mime");
  assert.equal((await processVoiceFeedback({}, { file: audioFile(0) }, { env: ON, transcribe: t })).reason, "empty");
  assert.equal((await processVoiceFeedback({}, { file: audioFile(8 * 1024 * 1024 + 1) }, { env: ON, transcribe: t })).reason, "too_large");
});

test("processVoiceFeedback: happy path transcribes → records a merchant_build_request feedback event", async () => {
  let tracked = null;
  const res = await processVoiceFeedback(
    {},
    { file: audioFile(64), shopDomain: "s.myshopify.com", merchantId: "m1", shopId: "sh1" },
    {
      env: ON,
      transcribe: async (arg) => {
        assert.ok(arg.audioBase64 && arg.mimeType === "audio/webm", "audio passed through");
        return { transcript: "build me a bulk editor please", model: "gemini-audio" };
      },
      trackEvent: async (_p, ev) => { tracked = ev; },
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.recorded, true);
  assert.equal(tracked.type, "merchant_build_request");
  assert.equal(tracked.topic, "feedback");
  assert.equal(tracked.properties.source, "voice_note");
  assert.ok(typeof tracked.summary === "string" && tracked.summary.length > 0);
});

test("processVoiceFeedback: empty transcript records nothing but returns ok", async () => {
  let tracked = false;
  const res = await processVoiceFeedback({}, { file: audioFile(64) }, {
    env: ON,
    transcribe: async () => ({ transcript: "   ", model: "m" }),
    trackEvent: async () => { tracked = true; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.recorded, false);
  assert.equal(tracked, false);
});
