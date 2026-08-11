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

// The reachable Merchant Memory surface (?view=memory). After the action-chat home
// redesign this is the ONLY place a merchant reaches Merchant Memory, so the founder's
// call is: make correction work here, entirely through the free-text composer — no
// per-belief buttons. So this view is deliberately conversational:
//   • it renders what Jefe believes in plain English (the `statement` + provenance the
//     loader computes), ordered by how much each is worth confirming (`confirmPriority`);
//   • it surfaces the open questions only the merchant can answer;
//   • and the ONE input is the composer, which posts `memory.message` →
//     sendConversationMessage → interpret/validate/commit (confirm / correct / answer,
//     and — once the interpreter's obsolete op lands — forget).
// Presentation-only: the loader shapes each belief; this component just renders it.

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

  return (
    <main className="JefeMemoryView">
      <BlockStack gap="600">
        <BlockStack gap="150">
          <Text as="p" tone="subdued">
            {merchantName}
          </Text>
          <Text as="h1" variant="heading2xl">
            What Jefe knows about {storeName}
          </Text>
          <Text as="p" tone="subdued">
            Merchant Memory is built from Shopify evidence, merchant corrections
            and lower-authority inferences that stay clearly labelled.
          </Text>
        </BlockStack>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Talk to me — I&apos;ll update what I know
            </Text>
            <Text as="p" tone="subdued">
              Everything here you can change just by telling me, in plain English.
              Confirm something (&ldquo;that&apos;s right&rdquo;), correct it
              (&ldquo;most of my sales are wholesale, not retail&rdquo;), or answer
              one of the questions below. A correction from you outranks anything
              I&apos;ve only inferred.
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
                  placeholder="e.g. That's right — or, most of my sales are wholesale, not retail"
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
          </BlockStack>
        </Card>

        {openQuestions.length > 0 ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                A few things only you can tell me
              </Text>
              <Text as="p" tone="subdued">
                Answer any of these in the box above — it&apos;s the fastest way
                to sharpen what I know.
              </Text>
              <BlockStack gap="200">
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
            </BlockStack>
          </Card>
        ) : null}

        {groups.length === 0 ? (
          <Card>
            <Text as="p">
              Merchant Memory is still being built. Come back once Shopify
              import and memory generation have finished.
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
