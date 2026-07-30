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

// Presentation-only. The loader (`getMerchantMemoryView` in app._index) shapes
// each belief into display-ready rows — including `statusLabel` / `statusTone`
// — so this component carries no formatting helpers and code-splits cleanly out
// of the route module. Its data contract is declared explicitly here; any drift
// from the loader's return shape is caught at the render/call site in app._index.

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
};

type MemoryData = {
  groups: Array<{
    category: string;
    label: string;
    beliefs: MemoryBelief[];
  }>;
};

type MemoryConversation = {
  messages: Array<{ id: string; role: string; content: string }>;
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
              Tell me what&apos;s wrong or missing
            </Text>
            <Text as="p" tone="subdued">
              Correct me in plain English — &ldquo;most of my sales are
              wholesale,&rdquo; &ldquo;my cost on hoodies is £14&rdquo; — and
              I&apos;ll update what I know. A correction from you outranks
              anything I&apos;ve only inferred.
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
                  label="Correct Jefe"
                  labelHidden
                  name="message"
                  value={message}
                  onChange={setMessage}
                  placeholder="e.g. Most of my sales are wholesale, not retail"
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

        {memory.groups.length === 0 ? (
          <Card>
            <Text as="p">
              Merchant Memory is still being built. Come back once Shopify
              import and memory generation have finished.
            </Text>
          </Card>
        ) : (
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {memory.groups.map((group) => (
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
                              {belief.title}
                            </Text>
                            <Badge tone={belief.statusTone}>
                              {belief.statusLabel}
                            </Badge>
                          </InlineStack>
                          <Text as="p">{belief.value}</Text>
                          {belief.evidenceSummary ? (
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
