import { useState } from "react";
import { Form } from "react-router";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

// The reachable Merchant Memory surface (?view=memory). After the action-chat home redesign
// this is the ONLY place a merchant reaches Merchant Memory, so the founder's call is: make
// correction work here, entirely through the free-text composer — no per-belief buttons.
//
// It LEADS WITH THE ASK, not the archive (Matt asked twice what the page is "for"): the point
// isn't to browse what Jefe knows, it's to check he's got the business right — and correcting a
// belief changes the advice, because every recommendation is built from these. So the top of the
// page is the few highest-`confirmPriority` beliefs framed as questions ("… — is that right?")
// plus the open questions, with the composer as the one answer box; the full labelled list sits
// below as browsable reference. The composer posts `memory.message` → sendConversationMessage →
// interpret/validate/commit (confirm / correct / answer / teach / forget — forget always shows
// what it's about to drop and asks first, and is undoable). Presentation-only: the loader shapes
// each belief; this component renders it.

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
  // Rich fields getMerchantMemoryView now computes — plain-English statement in Jefe's
  // voice, a provenance line, and a confirm-priority (higher = more worth your eyes).
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
  // getMerchantMemoryConversationExperience surfaces the top open questions in its summary
  // (already capped, so this stays a short, paced list — not a wall).
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
  const messages = (conversation?.messages ?? []).slice(-6);
  const openQuestions = conversation?.summary?.openQuestions ?? [];
  // Highest confirm-priority first, so what's most worth your eyes leads; settled beliefs
  // (priority 0) sink to the bottom of each group as browsable reference.
  const groups = memory.groups.map((group) => ({
    ...group,
    beliefs: [...group.beliefs].sort(
      (a, b) => (b.confirmPriority ?? 0) - (a.confirmPriority ?? 0),
    ),
  }));
  // Lead with the ASK, not the archive: the few beliefs most worth confirming (highest
  // confirmPriority = impact × uncertainty) become the questions Jefe is asking. Capped so it
  // stays a short, answerable ask — the point of the page — not a wall of facts to inspect.
  const toConfirm = groups
    .flatMap((group) => group.beliefs)
    .filter(
      (belief) =>
        (belief.confirmPriority ?? 0) > 0 && Boolean(belief.statement || belief.title),
    )
    .sort((a, b) => (b.confirmPriority ?? 0) - (a.confirmPriority ?? 0))
    .slice(0, 4);
  const hasAsk = toConfirm.length > 0 || openQuestions.length > 0;

  return (
    <main className="JefeMemoryView">
      <BlockStack gap="600">
        {/* Purpose, legible in the first line: this is where you keep Jefe right, and being
            right is what changes his advice — not a knowledge dump to browse. */}
        <BlockStack gap="150">
          <Text as="p" tone="subdued">
            {merchantName}
          </Text>
          <Text as="h1" variant="heading2xl">
            Is this right about {storeName}?
          </Text>
          <Text as="p" tone="subdued">
            Everything Jefe suggests comes from what he&apos;s worked out about your
            business. If something here is wrong, tell him in plain English and the advice
            changes with it — no forms, just talk.
          </Text>
        </BlockStack>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {hasAsk ? "Does this look right?" : "Tell me about your business"}
            </Text>
            {hasAsk ? (
              <BlockStack gap="200">
                {toConfirm.map((belief) => (
                  <Box
                    key={belief.id}
                    paddingBlockEnd="200"
                    borderBlockEndWidth="025"
                    borderColor="border"
                  >
                    <BlockStack gap="050">
                      <Text as="p" fontWeight="semibold">
                        {belief.statement || belief.title} — is that right?
                      </Text>
                      {belief.sourceLine ? (
                        <Text as="p" tone="subdued">
                          {belief.sourceLine}
                        </Text>
                      ) : null}
                    </BlockStack>
                  </Box>
                ))}
                {openQuestions.map((question) => (
                  <Box
                    key={question.id}
                    paddingBlockEnd="200"
                    borderBlockEndWidth="025"
                    borderColor="border"
                  >
                    <BlockStack gap="050">
                      <Text as="p" fontWeight="semibold">
                        {question.question}
                      </Text>
                      {question.reason ? (
                        <Text as="p" tone="subdued">
                          {question.reason}
                        </Text>
                      ) : null}
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            ) : null}
            <Text as="p" tone="subdued">
              {hasAsk
                ? "Answer any of these below — “yes” if it’s right, or tell me what’s off. A correction from you outranks anything I’ve only guessed."
                : "Tell me anything about how your business works — who your customers are, what you sell, how you fulfil — and I’ll remember it."}
            </Text>
            {messages.length > 0 ? (
              <BlockStack gap="150">
                {messages.map((item) => (
                  <Text
                    key={item.id}
                    as="p"
                    tone={item.role === "assistant" ? "subdued" : undefined}
                  >
                    {(item.role === "assistant" ? "Jefe: " : "You: ") +
                      item.content}
                  </Text>
                ))}
              </BlockStack>
            ) : null}
            <Form method="post">
              <input type="hidden" name="intent" value="memory.message" />
              <BlockStack gap="200">
                <TextField
                  label="Tell Jefe"
                  labelHidden
                  name="message"
                  value={message}
                  onChange={setMessage}
                  placeholder="e.g. Yes, that's right — or, most of my sales are wholesale, not retail"
                  multiline={3}
                  autoComplete="off"
                />
                <InlineStack align="end">
                  <Button submit variant="primary" disabled={!message.trim()}>
                    Send
                  </Button>
                </InlineStack>
              </BlockStack>
            </Form>
            <Text as="p" tone="subdued">
              You can also teach me something new, or tell me to forget something — I&apos;ll
              show you exactly what I&apos;m about to drop and check first, and you can always
              undo it.
            </Text>
          </BlockStack>
        </Card>

        {groups.length > 0 ? (
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">
              Everything Jefe knows
            </Text>
            <Text as="p" tone="subdued">
              The full picture, most-important first — browse if you like, but the
              questions above are what sharpen his advice.
            </Text>
          </BlockStack>
        ) : null}
        {groups.length === 0 ? (
          <Card>
            <Text as="p">
              Jefe is still reading your store. Once the first import and memory pass
              finish, what he&apos;s worked out shows up here for you to check.
            </Text>
          </Card>
        ) : (
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {groups.map((group) => (
              <Card key={group.category}>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    {group.label}
                  </Text>
                  <BlockStack gap="200">
                    {group.beliefs.map((belief) => (
                      <Box
                        key={belief.id}
                        paddingBlockEnd="200"
                        borderBlockEndWidth="025"
                        borderColor="border"
                      >
                        <BlockStack gap="100">
                          <InlineStack align="space-between" gap="300">
                            <Text as="p" fontWeight="semibold">
                              {belief.statement || belief.title}
                            </Text>
                            <Badge tone={belief.statusTone}>
                              {belief.statusLabel}
                            </Badge>
                          </InlineStack>
                          {/* With a plain-English statement the raw value is redundant;
                              show it only as the fallback when no statement exists. */}
                          {belief.statement ? null : (
                            <Text as="p">{belief.value}</Text>
                          )}
                          {belief.sourceLine ? (
                            <Text as="p" tone="subdued">
                              {belief.sourceLine}
                            </Text>
                          ) : belief.evidenceSummary ? (
                            <Text as="p" tone="subdued">
                              {belief.evidenceSummary}
                            </Text>
                          ) : null}
                        </BlockStack>
                      </Box>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        )}
      </BlockStack>
    </main>
  );
}
