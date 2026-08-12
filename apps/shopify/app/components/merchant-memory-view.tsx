import { useState } from "react";
import { Form } from "react-router";
import {
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

// The reachable Merchant Memory surface (?view=memory) — the merchant's window into what Jefe
// has worked out about their business, and the one place they can put it right. After the
// action-chat home redesign this is the ONLY place Merchant Memory is reachable.
//
// Design (Matt's direct feedback, 2026-08-12): it doesn't need to tell the merchant what to DO —
// it needs to be SHORT, legible and easy to INTERRUPT. So:
//   • the beliefs are ONE tight list, most-worth-checking first (confirmPriority), capped with a
//     "show everything" expander so the page never becomes a wall to scroll;
//   • each belief carries a quiet "Not right?" that drops the merchant into the composer with
//     that belief already named — local correction, one click, no scrolling-and-describing;
//   • correction still COMMITS only through the free-text composer (Matt's rule — no per-belief
//     action buttons); "Not right?" just prefills + focuses it, it never acts on its own.
// The composer posts memory.message → sendConversationMessage (confirm / correct / answer / teach
// / forget — forget shows what it'll drop, asks first, and is undoable). Presentation-only: the
// loader shapes each belief; this component renders it.

const COMPOSER_ID = "jefe-memory-composer";
const TOP_BELIEFS = 6;

type MemoryBelief = {
  id: string;
  key: string;
  title: string;
  value: string;
  status: string;
  correctable: boolean;
  evidenceSummary: string | null;
  statusLabel: string;
  statusTone: "success" | "attention" | "info";
  // Rich fields getMerchantMemoryView computes — plain-English statement in Jefe's voice, a
  // provenance line, and a confirm-priority (higher = more worth your eyes).
  statement?: string | null;
  sourceLine?: string | null;
  authorship?: "merchant" | "jefe" | null;
  confirmState?: "settled" | "unsure" | null;
  confirmPriority?: number;
};

type MemoryData = {
  groups: Array<{
    category: string;
    label: string;
    beliefs: MemoryBelief[];
  }>;
};

type OpenQuestion = { id: string; question: string; reason: string | null };

type MemoryConversation = {
  messages: Array<{ id: string; role: string; content: string }>;
  summary?: { openQuestions?: OpenQuestion[] | null } | null;
};

export function MerchantMemoryView({
  storeName,
  merchantName,
  memory,
  conversation,
}: {
  storeName: string;
  merchantName: string;
  memory: MemoryData;
  conversation: MemoryConversation | null;
}) {
  const [message, setMessage] = useState("");
  const [showAll, setShowAll] = useState(false);
  const messages = (conversation?.messages ?? []).slice(-4);
  const openQuestions = conversation?.summary?.openQuestions ?? [];

  // One list, most-worth-checking first (confirmPriority = impact × uncertainty). Capped so the
  // page stays short — the rest is one click away, not a wall.
  const beliefs = memory.groups
    .flatMap((group) => group.beliefs)
    .sort((a, b) => (b.confirmPriority ?? 0) - (a.confirmPriority ?? 0));
  const visible = showAll ? beliefs : beliefs.slice(0, TOP_BELIEFS);
  const hiddenCount = beliefs.length - visible.length;

  // Local interruption: name the belief in the composer and focus it, so correcting the one Jefe
  // has wrong is a click + a sentence — not a scroll-and-describe. Prefill only; the correction
  // commits when the merchant sends (the composer-only rule).
  const correctThis = (belief: MemoryBelief) => {
    const subject = (belief.statement || belief.title).replace(/["\n]/g, " ").trim();
    setMessage(`About "${subject}": `);
    if (typeof document !== "undefined") {
      const el = document.getElementById(COMPOSER_ID);
      if (el) {
        el.focus();
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  };

  return (
    <main className="JefeMemoryView">
      <BlockStack gap="500">
        <BlockStack gap="100">
          <Text as="p" tone="subdued">
            {merchantName}
          </Text>
          <Text as="h1" variant="headingXl">
            What Jefe&apos;s worked out about {storeName}
          </Text>
          <Text as="p" tone="subdued">
            Everything he suggests comes from this — see something off, and put him right in a
            line. It changes the advice.
          </Text>
        </BlockStack>

        <Card>
          <BlockStack gap="200">
            <Form method="post">
              <input type="hidden" name="intent" value="memory.message" />
              <BlockStack gap="150">
                <TextField
                  label="Correct Jefe"
                  labelHidden
                  id={COMPOSER_ID}
                  name="message"
                  value={message}
                  onChange={setMessage}
                  placeholder="Tell me what's off — or confirm one, answer a question, or say “forget that”"
                  multiline={2}
                  autoComplete="off"
                />
                <InlineStack align="end">
                  <Button submit variant="primary" disabled={!message.trim()}>
                    Send
                  </Button>
                </InlineStack>
              </BlockStack>
            </Form>
            {messages.length > 0 ? (
              <BlockStack gap="100">
                {messages.map((item) => (
                  <Text
                    key={item.id}
                    as="p"
                    variant="bodySm"
                    tone={item.role === "assistant" ? "subdued" : undefined}
                  >
                    {(item.role === "assistant" ? "Jefe: " : "You: ") + item.content}
                  </Text>
                ))}
              </BlockStack>
            ) : null}
          </BlockStack>
        </Card>

        {openQuestions.length > 0 ? (
          <BlockStack gap="150">
            <Text as="h2" variant="headingSm">
              A few things only you can tell me
            </Text>
            {openQuestions.map((question) => (
              <Box
                key={question.id}
                paddingBlockEnd="150"
                borderBlockEndWidth="025"
                borderColor="border"
              >
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">
                    {question.question}
                  </Text>
                  {question.reason ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {question.reason}
                    </Text>
                  ) : null}
                </BlockStack>
              </Box>
            ))}
          </BlockStack>
        ) : null}

        {beliefs.length === 0 ? (
          <Card>
            <Text as="p">
              Jefe is still reading your store. What he works out shows up here for you to
              check.
            </Text>
          </Card>
        ) : (
          <BlockStack gap="150">
            <Text as="h2" variant="headingSm">
              What he believes
            </Text>
            {visible.map((belief) => (
              <Box
                key={belief.id}
                paddingBlockEnd="150"
                borderBlockEndWidth="025"
                borderColor="border"
              >
                <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
                  <BlockStack gap="050">
                    <Text as="p" fontWeight="semibold">
                      {belief.statement || belief.title}
                    </Text>
                    {belief.sourceLine ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {belief.sourceLine}
                      </Text>
                    ) : null}
                  </BlockStack>
                  <Button variant="plain" onClick={() => correctThis(belief)}>
                    Not right?
                  </Button>
                </InlineStack>
              </Box>
            ))}
            {hiddenCount > 0 ? (
              <Button variant="plain" onClick={() => setShowAll(true)}>
                {`Show everything Jefe knows (${hiddenCount} more)`}
              </Button>
            ) : null}
          </BlockStack>
        )}
      </BlockStack>
    </main>
  );
}
