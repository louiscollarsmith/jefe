import { useState } from "react";
import { Form, Link, useLocation } from "react-router";
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
// Design (Matt's direct feedback, 2026-08-12): SHORT, beautiful, and easy to INTERACT with — it
// was reading as a read-only data dump. So:
//   • it opens with the invitation — a prominent "Talk to Jefe" composer with real example
//     prompts — so the obvious thing to do is talk to it, not just read it;
//   • what Jefe believes is grouped by PROVENANCE, not category — "What you've told me" vs "What
//     Jefe's worked out" — because a merchant trusts and corrects those differently, and the set
//     is about to span a third source (beliefs pulled from connected tools like Meta/Google). The
//     group header carries provenance so each row stays clean;
//   • the worked-out list is capped (most-worth-checking first, confirmPriority) with a "show all",
//     so it's never a wall.
// Correction commits ONLY through the composer (Matt's rule — no per-belief action buttons):
// memory.message → sendConversationMessage (confirm / correct / answer / teach / forget — forget
// shows what it'll drop, asks first, and is undoable). Presentation-only: the loader shapes each
// belief; this component renders it.

const WORKED_OUT_CAP = 6;

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
  // provenance line, authorship (merchant-told vs Jefe-derived), and a confirm-priority.
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

function BeliefRow({ belief }: { belief: MemoryBelief }) {
  return (
    <Box paddingBlockEnd="150" borderBlockEndWidth="025" borderColor="border">
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
    </Box>
  );
}

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
  const location = useLocation();
  // Back to the conversation. Strip only `view` — shop/host/embedded params must survive
  // or an embedded app loses its session.
  const backToHome = (() => {
    const params = new URLSearchParams(location.search);
    params.delete("view");
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  })();
  const [message, setMessage] = useState("");
  const [showAllWorkedOut, setShowAllWorkedOut] = useState(false);
  const messages = (conversation?.messages ?? []).slice(-4);
  const openQuestions = conversation?.summary?.openQuestions ?? [];

  // Grouped by PROVENANCE (what the merchant told Jefe vs what he worked out), each ordered
  // most-worth-checking first (confirmPriority = impact × uncertainty).
  // `data` beliefs are OUR ingestion diagnostics — orphan line items, link coverage,
  // timestamp coverage. Not facts about the merchant's business; they must never render
  // here. Chat 10 is adding a first-class audience field; category is the honest proxy.
  const all = memory.groups
    .filter((group) => group.category !== "data")
    .flatMap((group) => group.beliefs)
    .sort((a, b) => (b.confirmPriority ?? 0) - (a.confirmPriority ?? 0));
  const toldByMerchant = all.filter((belief) => belief.authorship === "merchant");
  const workedOut = all.filter((belief) => belief.authorship !== "merchant");
  const workedOutVisible = showAllWorkedOut
    ? workedOut
    : workedOut.slice(0, WORKED_OUT_CAP);
  const workedOutHidden = workedOut.length - workedOutVisible.length;

  return (
    <main className="JefeMemoryView">
      <BlockStack gap="500">
        <Link to={backToHome}>← Back to Jefe</Link>

        <BlockStack gap="100">
          <Text as="p" tone="subdued">
            {merchantName}
          </Text>
          <Text as="h1" variant="headingXl">
            What Jefe knows about {storeName}
          </Text>
          <Text as="p" tone="subdued">
            This shapes every suggestion he makes. Talk to him below — put something right, add
            what he&apos;s missing, or ask why he thinks something.
          </Text>
        </BlockStack>

        {/* The invitation to interact — a prominent composer with real example prompts. */}
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingSm">
              Talk to Jefe
            </Text>
            <Form method="post">
              <input type="hidden" name="intent" value="memory.message" />
              <BlockStack gap="150">
                <TextField
                  label="Talk to Jefe"
                  labelHidden
                  name="message"
                  value={message}
                  onChange={setMessage}
                  placeholder="e.g. “most of my sales are wholesale” · “why do you think that?” · “forget that”"
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

        {all.length === 0 ? (
          <Card>
            <Text as="p">
              Jefe is still reading your store. What he works out shows up here for you to
              check — and anything you tell him above lands here too.
            </Text>
          </Card>
        ) : (
          <>
            <BlockStack gap="150">
              <Text as="h2" variant="headingSm">
                What you&apos;ve told me
              </Text>
              {toldByMerchant.length > 0 ? (
                toldByMerchant.map((belief) => (
                  <BeliefRow key={belief.id} belief={belief} />
                ))
              ) : (
                <Text as="p" tone="subdued">
                  Nothing yet — anything you tell Jefe above shows up here, and it outranks
                  anything he&apos;s only worked out.
                </Text>
              )}
            </BlockStack>

            {workedOut.length > 0 ? (
              <BlockStack gap="150">
                <Text as="h2" variant="headingSm">
                  What Jefe&apos;s worked out
                </Text>
                {workedOutVisible.map((belief) => (
                  <BeliefRow key={belief.id} belief={belief} />
                ))}
                {workedOutHidden > 0 ? (
                  <Button variant="plain" onClick={() => setShowAllWorkedOut(true)}>
                    {`Show all ${workedOut.length}`}
                  </Button>
                ) : null}
              </BlockStack>
            ) : null}
          </>
        )}
      </BlockStack>
    </main>
  );
}
