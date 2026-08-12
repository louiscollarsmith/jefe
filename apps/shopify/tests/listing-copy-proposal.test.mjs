import assert from "node:assert/strict";
import test from "node:test";
import { proposeProductTypes } from "../app/lib/actions/listing-copy-proposal.server.js";

// The point of this module is CONSISTENCY with what the merchant already does — never
// classification against an external taxonomy. So the tests that matter are the ones proving
// it stays inside their vocabulary, and stays quiet when the evidence is thin.

const P = (productId, title, vendor, productType = "", status = "ACTIVE") => ({
  productId, title, vendor, productType, status,
});

test("a proposal only ever comes from the merchant's own vocabulary", () => {
  const { proposals, vocabulary } = proposeProductTypes({
    products: [
      P("t1", "Hawkstone Lager 330ml", "Hawkstone", "Beer"),
      P("t2", "Hawkstone IPA 330ml", "Hawkstone", "Beer"),
      P("t3", "Hawkstone Pilsner", "Hawkstone", "Beer"),
      P("u1", "Hawkstone Cider 500ml", "Hawkstone"),
    ],
  });
  assert.deepEqual(vocabulary, ["Beer"]);
  assert.equal(proposals.length, 1);
  // Not "Cider", which is what an external taxonomy would say — the merchant files all
  // Hawkstone under Beer and Jefe's job is to match them, not correct them.
  assert.equal(proposals[0].proposedType, "Beer");
  assert.equal(proposals[0].basis, "vendor");
});

test("every proposal explains itself in words the merchant can check", () => {
  const { proposals } = proposeProductTypes({
    products: [
      P("t1", "Yuzu Tonic 200ml", "Fever", "Mixers"),
      P("t2", "Ginger Tonic 200ml", "Fever", "Mixers"),
      P("t3", "Elderflower Tonic", "Fever", "Mixers"),
      P("u1", "Rhubarb Tonic 200ml", "Fever"),
    ],
  });
  // A proposal a merchant cannot check is one they cannot correct.
  assert.match(proposals[0].because, /Fever/);
  assert.ok(proposals[0].because.length > 10);
});

test("a distinctive word in the merchant's own titles can carry a proposal", () => {
  const { proposals } = proposeProductTypes({
    products: [
      P("t1", "Bergamot Candle Large", "Aery", "Candles"),
      P("t2", "Lavender Candle Small", "Wax Co", "Candles"),
      P("t3", "Sandalwood Diffuser", "Aery", "Diffusers"),
      P("t4", "Neroli Diffuser", "Wax Co", "Diffusers"),
      // Vendor is ambiguous (Aery sells both), so the title has to do the work.
      P("u1", "Vetiver Candle Large", "Aery"),
    ],
  });
  const pick = proposals.find((p) => p.productId === "u1");
  assert.equal(pick?.proposedType, "Candles");
  assert.equal(pick?.basis, "title");
});

test("a merely-majority vendor is not enough — a mixed brand proposes NOTHING", () => {
  // Aery is 3 Candles / 2 Diffusers: PLENTY of evidence (well past the count gate) and a
  // clear majority, but 60% is not "this brand sells one kind of thing". A model would
  // happily answer here; writing that into a catalogue silently is exactly what this module
  // exists to prevent. Titles are deliberately non-distinctive so only the vendor rule is
  // under test.
  const { proposals, unresolved } = proposeProductTypes({
    products: [
      P("t1", "Bergamot Thing", "Aery", "Candles"),
      P("t2", "Neroli Object", "Aery", "Candles"),
      P("t3", "Cedar Article", "Aery", "Candles"),
      P("t4", "Lavender Item", "Aery", "Diffusers"),
      P("t5", "Vetiver Piece", "Aery", "Diffusers"),
      P("u1", "Mystery Gift", "Aery"),
    ],
  });
  assert.deepEqual(proposals, []);
  assert.equal(unresolved[0].productId, "u1");
});

test("a catalogue with no types at all gets questions, not an invented taxonomy", () => {
  const { proposals, unresolved, vocabulary } = proposeProductTypes({
    products: [P("u1", "Yuzu Tonic", "Fever"), P("u2", "Cherry Cola", "Fizz")],
  });
  assert.deepEqual(vocabulary, []);
  assert.deepEqual(proposals, []);
  assert.deepEqual(unresolved.map((u) => u.reason), ["no_existing_vocabulary", "no_existing_vocabulary"]);
});

test("archived products neither receive proposals nor teach the vocabulary", () => {
  const { proposals, vocabulary } = proposeProductTypes({
    products: [
      P("a1", "Old Lager", "Hawkstone", "Discontinued", "ARCHIVED"),
      P("t1", "Hawkstone Lager", "Hawkstone", "Beer"),
      P("t2", "Hawkstone IPA", "Hawkstone", "Beer"),
      P("t3", "Hawkstone Pilsner", "Hawkstone", "Beer"),
      P("u1", "Hawkstone Cider", "Hawkstone"),
      P("a2", "Old Cider", "Hawkstone", "", "ARCHIVED"),
    ],
  });
  // "Discontinued" is not how this merchant organises what they SELL.
  assert.deepEqual(vocabulary, ["Beer"]);
  assert.deepEqual(proposals.map((p) => p.productId), ["u1"]);
});

test("one typed product from a vendor is not enough to generalise", () => {
  const { proposals, unresolved } = proposeProductTypes({
    products: [
      P("t1", "Solo Item", "Newco", "Homeware"),
      P("u1", "Another Newco Thing", "Newco"),
    ],
  });
  assert.deepEqual(proposals, []);
  assert.equal(unresolved[0].reason, "no_matching_signal");
});

test("re-running proposes the same thing", () => {
  const products = [
    P("t1", "Hawkstone Lager", "Hawkstone", "Beer"),
    P("t2", "Hawkstone IPA", "Hawkstone", "Beer"),
    P("t3", "Hawkstone Stout", "Hawkstone", "Beer"),
    P("u1", "Hawkstone Cider", "Hawkstone"),
  ];
  const a = proposeProductTypes({ products });
  const b = proposeProductTypes({ products: [...products].reverse() });
  assert.deepEqual(
    a.proposals.map((p) => [p.productId, p.proposedType]),
    b.proposals.map((p) => [p.productId, p.proposedType]),
  );
});
