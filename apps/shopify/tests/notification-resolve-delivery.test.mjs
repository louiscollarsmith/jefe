import assert from "node:assert/strict";
import test from "node:test";
import { resolveDelivery } from "../app/lib/notifications/service.server.js";
import { CHANNEL_STATUS } from "../app/lib/channels/status.js";

// resolveDelivery composes the effective preference with what can actually be
// delivered: connected slack/whatsapp + a known, non-unsubscribed email. Mock
// prisma covers the four reads it makes (pref, channel connections, contact
// email, email opt-out). No DB.
function mockPrisma({ prefRow = null, connections = [], contactEmail = null, unsubscribed = false } = {}) {
  return {
    notificationPreference: { findUnique: async () => (prefRow ? { ...prefRow } : null) },
    channelConnection: { findMany: async () => connections.map((c) => ({ ...c })) },
    shop: { findUnique: async () => ({ contactEmail }) },
    emailPreference: {
      findUnique: async () => (unsubscribed ? { unsubscribedAt: new Date() } : null),
    },
  };
}

const connectedSlack = {
  id: "conn-slack",
  provider: "slack",
  status: CHANNEL_STATUS.connected,
  verifiedAt: new Date("2026-07-01T00:00:00Z"),
  disconnectedAt: null,
  maskedDestination: "#ops",
};

const args = { merchantId: "m1", shopId: "s1" };

test("a disabled category never delivers", async () => {
  const prisma = mockPrisma({ prefRow: { category: "morning_brief", enabled: false }, contactEmail: "a@b.com" });
  const res = await resolveDelivery(prisma, { ...args, category: "morning_brief" });
  assert.equal(res.deliver, false);
  assert.deepEqual(res.suppressed, ["disabled"]);
});

test("an unknown category is refused", async () => {
  const res = await resolveDelivery(mockPrisma({}), { ...args, category: "nope" });
  assert.equal(res.deliver, false);
  assert.deepEqual(res.suppressed, ["unknown_category"]);
});

test("email delivers when there is a contact address and no opt-out", async () => {
  const prisma = mockPrisma({ contactEmail: "maya@everdew.co.uk" });
  const res = await resolveDelivery(prisma, { ...args, category: "morning_brief" });
  assert.equal(res.deliver, true);
  assert.deepEqual(res.channels, [{ channel: "email", destination: "maya@everdew.co.uk" }]);
  assert.deepEqual(res.suppressed, []);
});

test("email is suppressed with no address", async () => {
  const res = await resolveDelivery(mockPrisma({ contactEmail: null }), { ...args, category: "morning_brief" });
  assert.equal(res.deliver, false);
  assert.deepEqual(res.suppressed, ["email_no_address"]);
});

test("email is suppressed when the recipient has unsubscribed", async () => {
  const prisma = mockPrisma({ contactEmail: "maya@everdew.co.uk", unsubscribed: true });
  const res = await resolveDelivery(prisma, { ...args, category: "morning_brief" });
  assert.equal(res.deliver, false);
  assert.deepEqual(res.suppressed, ["email_unsubscribed"]);
});

test("connected channels are kept and unconnected ones suppressed", async () => {
  // action_needs_approval defaults to slack + whatsapp + email. Only slack is
  // connected; email address present; whatsapp absent.
  const prisma = mockPrisma({ connections: [connectedSlack], contactEmail: "maya@everdew.co.uk" });
  const res = await resolveDelivery(prisma, { ...args, category: "action_needs_approval" });
  assert.equal(res.deliver, true);
  const channels = res.channels.map((c) => c.channel).sort();
  assert.deepEqual(channels, ["email", "slack"]);
  assert.ok(res.suppressed.includes("whatsapp_not_connected"));
  const slack = res.channels.find((c) => c.channel === "slack");
  assert.equal(slack.destination, "#ops");
});
