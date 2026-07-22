import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBacktestCorpus, type BacktestCase, type HumanOverrideEvent, type RuleFiredEvent } from "../dist/index.js";

function fired(ruleId: string, targetKey: string, occurredAt: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId, targetKey, outcome: "block", occurredAt, ...overrides };
}

function override(
  ruleId: string,
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  occurredAt: string,
  overrides: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId, targetKey, verdict, occurredAt, ...overrides };
}

test("barrel: the public entrypoint re-exports buildBacktestCorpus (#8083)", () => {
  assert.equal(typeof buildBacktestCorpus, "function");
});

test("buildBacktestCorpus: empty input arrays produce an empty corpus", () => {
  assert.deepEqual(buildBacktestCorpus("missing_linked_issue", [], []), []);
});

test("buildBacktestCorpus: a fired event with no matching override is excluded (not emitted unlabeled)", () => {
  // override exists for the SAME rule but a DIFFERENT target -> the fire has no match and drops out.
  const corpus = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1", "2026-07-22T00:00:00.000Z")],
    [override("missing_linked_issue", "a#2", "confirmed", "2026-07-22T01:00:00.000Z")],
  );
  assert.deepEqual(corpus, []);
});

test("buildBacktestCorpus: a single fired+override pair produces one correctly-labeled case (metadata carried through)", () => {
  const corpus = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1", "2026-07-22T00:00:00.000Z", { metadata: { pr: 42 } })],
    [override("missing_linked_issue", "a#1", "reversed", "2026-07-22T02:00:00.000Z", { metadata: { by: "maintainer" } })],
  );
  const expected: BacktestCase = {
    ruleId: "missing_linked_issue",
    targetKey: "a#1",
    outcome: "block",
    label: "reversed",
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T02:00:00.000Z",
    metadata: { pr: 42 },
  };
  assert.deepEqual(corpus, [expected]);
});

test("buildBacktestCorpus: when the fired event has no metadata, the key is omitted entirely (not set to undefined)", () => {
  const corpus = buildBacktestCorpus(
    "rule_a",
    [fired("rule_a", "a#1", "2026-07-22T00:00:00.000Z")],
    [override("rule_a", "a#1", "confirmed", "2026-07-22T00:30:00.000Z")],
  );
  assert.equal(corpus.length, 1);
  const [only] = corpus;
  assert(only);
  assert.equal("metadata" in only, false);
  assert.deepEqual(only, {
    ruleId: "rule_a",
    targetKey: "a#1",
    outcome: "block",
    label: "confirmed",
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T00:30:00.000Z",
  });
});

test("buildBacktestCorpus: with multiple following overrides, pairs the NEAREST one strictly after the fire", () => {
  // Three overrides after the fire, given out of order (t+2, t+1, t+3) so the reducer must compare in both
  // directions; the nearest-following one (t+1) must win.
  const corpus = buildBacktestCorpus(
    "rule_a",
    [fired("rule_a", "a#1", "2026-07-22T00:00:00.000Z")],
    [
      override("rule_a", "a#1", "reversed", "2026-07-22T02:00:00.000Z"),
      override("rule_a", "a#1", "confirmed", "2026-07-22T01:00:00.000Z"),
      override("rule_a", "a#1", "reversed", "2026-07-22T03:00:00.000Z"),
    ],
  );
  assert.equal(corpus.length, 1);
  const [only] = corpus;
  assert(only);
  assert.equal(only.label, "confirmed");
  assert.equal(only.decidedAt, "2026-07-22T01:00:00.000Z");
});

test("buildBacktestCorpus: when NO override strictly follows the fire, falls back to the MOST RECENT override", () => {
  // Three overrides, all strictly BEFORE the fire, out of order (t-3, t-1, t-2) so the reducer compares in
  // both directions; the most-recent one (t-1) must win.
  const corpus = buildBacktestCorpus(
    "rule_a",
    [fired("rule_a", "a#1", "2026-07-22T05:00:00.000Z")],
    [
      override("rule_a", "a#1", "reversed", "2026-07-22T02:00:00.000Z"),
      override("rule_a", "a#1", "confirmed", "2026-07-22T04:00:00.000Z"),
      override("rule_a", "a#1", "reversed", "2026-07-22T03:00:00.000Z"),
    ],
  );
  assert.equal(corpus.length, 1);
  const [only] = corpus;
  assert(only);
  assert.equal(only.label, "confirmed");
  assert.equal(only.decidedAt, "2026-07-22T04:00:00.000Z");
});

test("buildBacktestCorpus: events for a DIFFERENT ruleId are ignored (both fired and override sides filtered)", () => {
  const corpus = buildBacktestCorpus(
    "rule_a",
    [
      fired("rule_a", "a#1", "2026-07-22T00:00:00.000Z"),
      fired("rule_b", "a#2", "2026-07-22T00:00:00.000Z"), // wrong-rule fire: skipped
    ],
    [
      override("rule_a", "a#1", "confirmed", "2026-07-22T00:30:00.000Z"),
      override("rule_b", "a#1", "reversed", "2026-07-22T00:30:00.000Z"), // wrong-rule override: not a match
    ],
  );
  assert.equal(corpus.length, 1);
  const [only] = corpus;
  assert(only);
  assert.equal(only.ruleId, "rule_a");
  assert.equal(only.targetKey, "a#1");
  assert.equal(only.label, "confirmed");
});

test("buildBacktestCorpus: distinct fired events each produce their own case, in input order", () => {
  const corpus = buildBacktestCorpus(
    "rule_a",
    [
      fired("rule_a", "a#1", "2026-07-22T00:00:00.000Z"),
      fired("rule_a", "a#2", "2026-07-22T00:00:00.000Z"),
    ],
    [
      override("rule_a", "a#1", "confirmed", "2026-07-22T00:30:00.000Z"),
      override("rule_a", "a#2", "reversed", "2026-07-22T00:30:00.000Z"),
    ],
  );
  assert.deepEqual(
    corpus.map((c) => [c.targetKey, c.label]),
    [
      ["a#1", "confirmed"],
      ["a#2", "reversed"],
    ],
  );
});
