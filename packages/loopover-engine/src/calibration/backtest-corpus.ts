// Backtest-corpus builder (#8083) -- the additive, replay-oriented counterpart to computeRulePrecision in
// signal-tracking.ts. Where computeRulePrecision COLLAPSES a rule's fired+override history into one aggregate
// precision number, this KEEPS each paired case as an individual labeled record: a concrete "this rule fired
// against this target, and a human later said it was right/wrong" datum that a follow-up backtest scorer (a
// sibling issue under epic #8082) can replay against a different candidate rule/classifier.
//
// SELF-CONTAINED, STORAGE-AGNOSTIC (same discipline as signal-tracking.ts): pure TypeScript, no IO, no DB, no
// env, no host adapter -- it consumes only the existing RuleFiredEvent / HumanOverrideEvent value types from
// signal-tracking.ts and returns plain objects. Nothing here reads the clock or a random source, so the same
// inputs always yield the same corpus.
import type { HumanOverrideEvent, RuleFiredEvent } from "./signal-tracking.js";

/** One replayable backtest datum: a single rule firing that a human later explicitly judged. `outcome` is the
 *  firing's own {@link RuleFiredEvent.outcome}; `label` is the human's {@link HumanOverrideEvent.verdict}
 *  (`"confirmed"` = the rule was right that time, `"reversed"` = it was wrong). `firedAt`/`decidedAt` carry the
 *  two events' `occurredAt` timestamps so a scorer can reason about the fire->judgment gap. `metadata` mirrors
 *  the fired event's optional `metadata` and is OMITTED entirely (never set to `undefined`) when the fired
 *  event carried none -- the same exactOptionalPropertyTypes discipline RuleFiredEvent itself uses. */
export type BacktestCase = {
  ruleId: string;
  targetKey: string;
  outcome: string;
  label: "reversed" | "confirmed";
  firedAt: string;
  decidedAt: string;
  metadata?: Record<string, unknown>;
};

/** True for an event that targets `ruleId` -- mirrors `overrideMatchesRule`'s one-line `event.ruleId === ruleId`
 *  filter in signal-tracking.ts (that helper is intentionally NOT re-exported there; #8083 is additive-only, so
 *  the same one-liner is restated here and applied to BOTH fired and override events). */
function eventMatchesRule(event: { ruleId: string }, ruleId: string): boolean {
  return event.ruleId === ruleId;
}

/** `occurredAt` (an ISO-8601 instant) as epoch millis, so pairing compares actual points in time rather than
 *  raw strings. Pure: `new Date(...).getTime()` reads no ambient clock. */
function occurredAtMs(occurredAt: string): number {
  return new Date(occurredAt).getTime();
}

/**
 * Build a labeled {@link BacktestCase} corpus for `ruleId` from its fired + override events. Only events whose
 * `ruleId` equals the argument are considered (mirroring {@link computeRulePrecision}'s "same-rule only" filter
 * via {@link eventMatchesRule}); a caller MAY pass a mixed-rule list without pre-filtering.
 *
 * Each fired event yields AT MOST ONE case (never a duplicate for the same firing). A fired event is paired
 * with an override that shares its `ruleId` AND `targetKey`; when several such overrides exist for one target
 * (the rule re-fired and was re-judged more than once), the fired event pairs with the override whose
 * `occurredAt` is the CLOSEST one strictly AFTER that firing's own `occurredAt`, and only if none strictly
 * follows does it fall back to the MOST RECENT override by `occurredAt`. A fired event with no matching
 * override at all is EXCLUDED from the corpus (not emitted as an unlabeled case) -- the same "only the decided
 * ones count" discipline computeRulePrecision applies. Cases are returned in the input order of `fired`.
 */
export function buildBacktestCorpus(
  ruleId: string,
  fired: readonly RuleFiredEvent[],
  overrides: readonly HumanOverrideEvent[],
): BacktestCase[] {
  const corpus: BacktestCase[] = [];
  for (const firedEvent of fired) {
    if (!eventMatchesRule(firedEvent, ruleId)) continue;
    const firedMs = occurredAtMs(firedEvent.occurredAt);
    const matching = overrides.filter(
      (override) => eventMatchesRule(override, ruleId) && override.targetKey === firedEvent.targetKey,
    );
    if (matching.length === 0) continue;
    const following = matching.filter((override) => occurredAtMs(override.occurredAt) > firedMs);
    const paired =
      following.length > 0
        ? following.reduce((best, override) =>
            occurredAtMs(override.occurredAt) < occurredAtMs(best.occurredAt) ? override : best,
          )
        : matching.reduce((best, override) =>
            occurredAtMs(override.occurredAt) > occurredAtMs(best.occurredAt) ? override : best,
          );
    corpus.push({
      ruleId,
      targetKey: firedEvent.targetKey,
      outcome: firedEvent.outcome,
      label: paired.verdict,
      firedAt: firedEvent.occurredAt,
      decidedAt: paired.occurredAt,
      ...(firedEvent.metadata !== undefined ? { metadata: firedEvent.metadata } : {}),
    });
  }
  return corpus;
}
