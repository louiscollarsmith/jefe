import assert from "node:assert/strict";
import test from "node:test";

import { renderBeliefStatement } from "../app/lib/merchant-memory/belief-statement.server.js";

// Four beliefs shipped today derived correctly, became findable, and still rendered as raw
// JSON in the memory view because none had a statement. A belief a merchant cannot read is
// a belief they cannot correct, which is most of the point of Merchant Memory.

const say = (key, value) => renderBeliefStatement({ key, value });

test("the discount belief names the offer, and calls out silent automatic discounting", () => {
  const s = say("business.discount_code_mix.trailing_90d", {
    offers: [{ label: "WELCOME10", kind: "code", orderSharePercent: 64 }],
    typedCodeOrderSharePercent: 55,
    automaticOrderSharePercent: 45,
    distinctOffers: 3,
  });
  assert.ok(s.includes("WELCOME10"));
  // The distinction that changes what a merchant does about it.
  assert.match(s, /automatically/);
});

test("a store with only typed codes is not told about automatic discounting", () => {
  const s = say("business.discount_code_mix.trailing_90d", {
    offers: [{ label: "SUMMER20", kind: "code", orderSharePercent: 80 }],
    typedCodeOrderSharePercent: 100,
    automaticOrderSharePercent: 0,
  });
  assert.ok(s.includes("SUMMER20"));
  assert.ok(!s.includes("automatically"), "invented an automatic-discount problem");
});

test("the cohort belief pairs the small loyal group with the revenue it carries", () => {
  const s = say("customers.cohort_mix.all_stored_history", {
    oneTimeSharePercent: 68,
    returningSharePercent: 20,
    loyalSharePercent: 12,
    loyalRevenueSharePercent: 40,
    recencyBasis: "store_observed_repeat_gap",
    lapsedSharePercent: 22,
    lapsedRevenueAtStake: 4100,
    currency: "GBP",
  });
  assert.match(s, /68%/);
  assert.match(s, /12%/);
  assert.match(s, /40%/);
  assert.match(s, /gone quiet/);
});

test("no lapsed claim is made when the belief could not establish a rhythm", () => {
  // ⛔ "We can't tell yet" must not become "nobody has lapsed" on the way to a sentence.
  const s = say("customers.cohort_mix.all_stored_history", {
    oneTimeSharePercent: 90,
    loyalSharePercent: 2,
    loyalRevenueSharePercent: 3,
    recencyBasis: "unavailable_too_few_repeat_customers",
  });
  assert.ok(s);
  assert.ok(!/quiet|lapsed/.test(s), "stated a lapsed figure the belief withheld");
});

test("channel quality compares two channels and never states a bare repeat rate", () => {
  // ⛔ The rates are floors truncated by how recently attribution started. A merchant
  // reading one as "my repeat rate" would be badly misled.
  const s = say("business.channel_quality.all_stored_history", {
    channels: [
      { channel: "email", customers: 40, repeatRatePercent: 38, averageLifetimeSpend: 210 },
      { channel: "social", customers: 90, repeatRatePercent: 9, averageLifetimeSpend: 60 },
    ],
    basis: "comparative_between_channels_only",
  });
  assert.match(s, /email/);
  assert.match(s, /social/);
  assert.match(s, /compare the two/);
  // No percentage at all, so none can be lifted out of context.
  assert.ok(!/\d+%/.test(s), `channel quality leaked a percentage: ${s}`);
});

test("channels that are barely different produce silence, not a finding", () => {
  const s = say("business.channel_quality.all_stored_history", {
    channels: [
      { channel: "email", customers: 40, repeatRatePercent: 22 },
      { channel: "search", customers: 50, repeatRatePercent: 19 },
    ],
  });
  assert.equal(s, null, "asserted a difference that is noise on a truncated window");
});

test("acquisition names only channels that carry real share", () => {
  const s = say("business.acquisition_mix.trailing_90d", {
    paidSharePercent: 41,
    searchSharePercent: 30,
    socialSharePercent: 22,
    emailSharePercent: 4,
    referralSharePercent: 2,
    directSharePercent: 1,
    touch: "first",
  });
  assert.match(s, /paid ads/);
  assert.match(s, /search/);
  // 4%, 2% and 1% are noise in a sentence.
  assert.ok(!s.includes("email"), "listed a channel too small to matter");
  // Scope is stated: this is only the orders where the journey is known.
  assert.match(s, /where I can see/);
});

test("every new belief stays silent rather than emitting an empty sentence", () => {
  for (const key of [
    "business.discount_code_mix.trailing_90d",
    "customers.cohort_mix.all_stored_history",
    "business.acquisition_mix.trailing_90d",
    "business.channel_quality.all_stored_history",
  ]) {
    assert.equal(say(key, {}), null, `${key} produced a statement from an empty value`);
    assert.equal(say(key, null), null, `${key} produced a statement from a null value`);
  }
});
