# Rich content, both ways — direction and open decisions

Founder direction, 2026-08-13 (~01:00): *"lets enable there to be a path for rich content too
> both ways. users may want to add attachments/images/videos etc"*, *"maybe merchants can set
whether they save or dont save their attachment/file"*, and — the one that decides the shape —
*"then its saved not in the llm chat, but in the app for them and they can refer to it in
future"*.

Written by the coordinating lane so the reasoning survives the conversation it came from.
Nothing here is built beyond the chart layout noted below.

## Where the code actually is

- **Messages are text.** `MerchantMemoryConversationMessage.content` is a `String`, and
  `daily-home.tsx` renders `{message.content}` and nothing else. There is no path for rich
  content in either direction today.
- **There is no upload transport.** No multipart parsing, no blob store, no presigned URLs.
  ⚠️ `voice-feedback.server.js:10` refers to "the existing multipart-upload transport (the
  Goals-doc `GoodsDocumentUploadCard` pattern)" — **that does not exist in this repo.** Do not
  plan against it.
- **`metadata Json` exists on every message** and is already used (general chat writes
  `citedContextIds`, `retrievalRunId`). A typed attachment/part shape can ride there without a
  migration, at least to begin with.
- **Chart LAYOUT is built** — `app/lib/charts/chart-layout.server.js`, pure, tested, not wired
  to any surface.

## The precedent that answers most of this

Matt already ruled on this exact question once, for voice (2026-07-31, recorded in
`voice-feedback.server.js`):

> v1 = TRANSCRIPT-ONLY … the raw audio is NOT persisted — the app has no blob storage, and
> keeping audio is a new-vendor/PII decision left to the founder.

**Derive and discard.** It generalises: accept the file, extract the understanding, keep the
text, drop the bytes. A merchant photographs a supplier invoice and Jefe remembers the
numbers. No storage vendor, no retention policy, no new PII surface — and it inherits a
decision rather than reopening one.

## Two buckets, and only one of them is blocked

| | Needs | Status |
|---|---|---|
| **Jefe → merchant** (charts, rich output) | Nothing — generated, never stored | Layout built; wiring is a small step |
| **Merchant → Jefe: images, PDFs, audio** | Nothing new — derive and discard | Buildable now |
| **Merchant → Jefe: video, or anything they must see AGAIN** | Blob storage, retention, deletion, GDPR | Blocked on a founder decision |

Video sits entirely in the blocked row: no current provider can understand it, so storing it
*is* the whole feature rather than an implementation detail of it.

## The shape: a merchant file library, not message attachments

Matt's third line is the important one. A saved file lives **in the app**, not in the chat
transcript, and the merchant can refer back to it. That makes files **first-class merchant
objects** rather than metadata hanging off a message:

- A file belongs to the merchant, is browsable, and outlives the conversation it arrived in.
- A chat message *references* a file; it does not contain it.
- "The supplier invoice I uploaded last month" becomes a real reference instead of something
  lost in scrollback — which is the same argument Merchant Memory itself rests on.

It is a bigger build than message attachments (merchant-scoped listing, retrieval, deletion),
and a better one: attachments buried in a transcript are found once and never again.

⚠️ **Where a file LIVES and what it is SHOWN TO are separate questions.** "Saved in the app,
not in the LLM chat" is right about storage — but each time Jefe reads that file to answer
something, it goes to a provider again. The honest merchant-facing promise is "you keep it,
you can find it, Jefe can use it" — never "it never leaves".

## ⚠️ The trap in "let merchants choose to save"

Matt's instinct — let the merchant decide — is right, and it makes consent explicit rather
than assumed. But the wording has to be honest about what it controls, because the obvious
phrasing promises something we do not deliver:

- **"Keep it"** → we store the file; the merchant can open it again later.
- **"Read it and forget it"** → Jefe extracts what it needs; the file is gone.

**Both send the file to a model.** Neither is "nobody else sees this". A merchant who reads
"don't save" as "stays private" has been misled, and — like the win-back email in
`reclaim-arbitration-2026-08-12.md` — the damage is done at the moment of transmission, not at
the moment we notice. A genuinely private option means local processing, which is not
realistic here, so the setting must not imply it.

Note also that the toggle does not remove the infra decision, it narrows it: the moment *any*
merchant can choose "keep", blob storage, retention and a deletion path all have to exist.

## Build order

1. **Wire the chart path** (Jefe → merchant). No storage, no consent question. Wants
   `MessageRow` to render a part rather than a string, and the analyst to emit a spec when a
   question is better answered with a picture. Do this when nobody is mid-demo on the home.
2. ~~**Derive-and-discard inbound** for images and documents~~ — **DONE 2026-08-13.** Size caps
   and a type allow-list, shared by the composer and the server. ⛔ No redaction on the extracted
   text: PII scrubbing was removed across every surface that day, so an invoice's names, emails
   and phone numbers now land in the thread verbatim.
3. **The file library + the save/discard toggle.** Storage vendor, merchant-scoped listing,
   retrieval, deletion, retention — and copy that promises what we actually do. This is the
   real feature Matt described; steps 1 and 2 are worth shipping without waiting for it.

## Open, for Matt

- Is **derive-and-discard** still the position now the ask is broader than voice?
- **Which formats first?** Best guess: photos of stock and supplier documents well before
  video.
- Is there a **merchant asking for playback**, or is "Jefe understood my photo" the whole job?
  That decides whether step 3 is real work or a someday.
