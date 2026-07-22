import { describe, expect, it } from "vitest";

import {
  buildBacktestCorpus,
  type BacktestCase,
} from "../../packages/loopover-engine/src/calibration/backtest-corpus.js";
import type { HumanOverrideEvent, RuleFiredEvent } from "../../packages/loopover-engine/src/calibration/signal-tracking.js";

// Covers buildBacktestCorpus across its full branch matrix against the in-repo engine SOURCE (live-transformed
// .ts, the sanctioned coverage path for packages/loopover-engine/src/** -- see vitest.config.ts's
// coverage.include note), so Codecov attributes every executed line and branch to backtest-corpus.ts itself.
// The engine's own node:test mirror (packages/loopover-engine/test/backtest-corpus.test.ts) pins the same
// behavior in the #7982-precedent style; this file exists to make the pure branches genuinely executed under
// the repo's vitest/Codecov gate.

function fired(ruleId: string, targetKey: string, occurredAt: string, extra: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId, targetKey, outcome: "block", occurredAt, ...extra };
}

function override(
  ruleId: string,
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  occurredAt: string,
  extra: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId, targetKey, verdict, occurredAt, ...extra };
}

describe("buildBacktestCorpus (#8083)", () => {
  it("returns an empty corpus for empty input arrays", () => {
    expect(buildBacktestCorpus("missing_linked_issue", [], [])).toEqual([]);
  });

  it("excludes a fired event that has no matching override (same rule, different target)", () => {
    const corpus = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("missing_linked_issue", "a#1", "2026-07-22T00:00:00.000Z")],
      [override("missing_linked_issue", "a#2", "confirmed", "2026-07-22T01:00:00.000Z")],
    );
    expect(corpus).toEqual([]);
  });

  it("pairs a single fired+override into one labeled case and carries the fired metadata through", () => {
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
    expect(corpus).toEqual([expected]);
  });

  it("omits the metadata key entirely when the fired event has none", () => {
    const corpus = buildBacktestCorpus(
      "rule_a",
      [fired("rule_a", "a#1", "2026-07-22T00:00:00.000Z")],
      [override("rule_a", "a#1", "confirmed", "2026-07-22T00:30:00.000Z")],
    );
    expect(corpus).toHaveLength(1);
    expect("metadata" in corpus[0]!).toBe(false);
    expect(corpus[0]).toEqual({
      ruleId: "rule_a",
      targetKey: "a#1",
      outcome: "block",
      label: "confirmed",
      firedAt: "2026-07-22T00:00:00.000Z",
      decidedAt: "2026-07-22T00:30:00.000Z",
    });
  });

  it("pairs with the NEAREST override strictly after the fire when several follow", () => {
    const corpus = buildBacktestCorpus(
      "rule_a",
      [fired("rule_a", "a#1", "2026-07-22T00:00:00.000Z")],
      [
        override("rule_a", "a#1", "reversed", "2026-07-22T02:00:00.000Z"),
        override("rule_a", "a#1", "confirmed", "2026-07-22T01:00:00.000Z"),
        override("rule_a", "a#1", "reversed", "2026-07-22T03:00:00.000Z"),
      ],
    );
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.label).toBe("confirmed");
    expect(corpus[0]!.decidedAt).toBe("2026-07-22T01:00:00.000Z");
  });

  it("falls back to the MOST RECENT override when none strictly follows the fire", () => {
    const corpus = buildBacktestCorpus(
      "rule_a",
      [fired("rule_a", "a#1", "2026-07-22T05:00:00.000Z")],
      [
        override("rule_a", "a#1", "reversed", "2026-07-22T02:00:00.000Z"),
        override("rule_a", "a#1", "confirmed", "2026-07-22T04:00:00.000Z"),
        override("rule_a", "a#1", "reversed", "2026-07-22T03:00:00.000Z"),
      ],
    );
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.label).toBe("confirmed");
    expect(corpus[0]!.decidedAt).toBe("2026-07-22T04:00:00.000Z");
  });

  it("ignores events for a different ruleId on both the fired and override sides", () => {
    const corpus = buildBacktestCorpus(
      "rule_a",
      [
        fired("rule_a", "a#1", "2026-07-22T00:00:00.000Z"),
        fired("rule_b", "a#2", "2026-07-22T00:00:00.000Z"),
      ],
      [
        override("rule_a", "a#1", "confirmed", "2026-07-22T00:30:00.000Z"),
        override("rule_b", "a#1", "reversed", "2026-07-22T00:30:00.000Z"),
      ],
    );
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.ruleId).toBe("rule_a");
    expect(corpus[0]!.targetKey).toBe("a#1");
    expect(corpus[0]!.label).toBe("confirmed");
  });

  it("emits one case per distinct fired event, in input order", () => {
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
    expect(corpus.map((c) => [c.targetKey, c.label])).toEqual([
      ["a#1", "confirmed"],
      ["a#2", "reversed"],
    ]);
  });
});
