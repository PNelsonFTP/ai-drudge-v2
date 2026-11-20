// "Same running story" for TOP STORIES. Clustering answers "is this the same EVENT?"; on the day of
// a very big story its follow-ups are different events ("Anthropic shares jump 17% after record
// Wall Street listing", "Anthropic goes public: $1.5 trillion beast targets other verticals") and
// rightly stay separate stories - but three of twelve TOP slots for one subject reads as repetition
// (live 2026-11-20: TOP #1, #6 and #8).
//
// A story B is a FOLLOW-UP of a story A when
//   1. entity - the two CORES share a token (core = the name-like title tokens that at least
//               `coreShare` of a story's headlines carry: "anthropic"), and
//   2. event  - beyond that, B's headlines carry at least `minShared` tokens of A's vocabulary (the
//               title tokens several of A's headlines use: "record", "share", "trading", "public").
// Two stories belong to one running story when either is a follow-up of the other. Title tokens
// only, lower-cased, plural "s" removed: a stage may not import the cluster stage's vectors, and
// the explain tool can show the words.
//
// Deliberately narrow. A small story's vocabulary is only what two of its headlines share, so a
// story is folded under it only when it repeats two of those words besides the name; a big story's
// vocabulary is wide, and the two-word test is what keeps "Anthropic Adds Code Mode to Claude Code"
// out of the IPO's running story.

import type { ArticleId } from "../../../shared/contract";
import { tokenize } from "../../../shared/text";
import type { ScoredStory } from "../types";
import { ROUTE_POLICY } from "./rules";

export interface StorySignature {
  /** Name-like tokens nearly all of the story's headlines carry. Empty = the story has no subject. */
  core: ReadonlySet<string>;
  /** Tokens at least two of its headlines carry (and `vocabularyShare` of them), core included. */
  vocabulary: ReadonlySet<string>;
  /** Every token of every headline. */
  all: ReadonlySet<string>;
}

/** Plural / third-person "s" only; versions and identifiers are left alone (same rule as the cluster stage's stem). */
function singular(token: string): string {
  if (token.length <= 3 || /[\d._]/.test(token)) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

export function titleTokens(title: string): Set<string> {
  return new Set(tokenize(title).map(singular));
}

export function signatureOf(story: ScoredStory): StorySignature {
  const { coreShare, vocabularyShare, minTokenLength } = ROUTE_POLICY.runningStory;
  const counts = new Map<string, number>();
  for (const item of story.items) for (const t of titleTokens(item.title)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const n = story.items.length;
  const coreNeed = Math.ceil(coreShare * n - 1e-9);
  const vocabularyNeed = Math.max(2, Math.ceil(vocabularyShare * n - 1e-9));
  const core = new Set<string>();
  const vocabulary = new Set<string>();
  for (const [t, c] of counts) {
    if (c >= coreNeed && t.length >= minTokenLength && !/\d/.test(t)) core.add(t);
    if (c >= vocabularyNeed) vocabulary.add(t);
  }
  return { core, vocabulary, all: new Set(counts.keys()) };
}

/**
 * Is `b` a follow-up of `a`? Entity: the two cores share a token (a's subject is b's subject - the
 * WHOLE of a's core is not required, because a big story's core may hold its event word too: six of
 * six headlines say "IPO", the follow-up says "Wall Street listing"). Event: beyond those shared
 * tokens, b's headlines carry `minShared` tokens of a's vocabulary.
 */
export function isFollowUp(b: StorySignature, a: StorySignature): boolean {
  const entity = new Set<string>();
  for (const t of a.core) if (b.core.has(t)) entity.add(t);
  if (entity.size === 0) return false;
  let shared = 0;
  for (const t of b.all) if (!entity.has(t) && a.vocabulary.has(t)) shared++;
  return shared >= ROUTE_POLICY.runningStory.minShared;
}

export function sameRunningStory(a: StorySignature, b: StorySignature): boolean {
  return isFollowUp(a, b) || isFollowUp(b, a);
}

export interface RunningResult {
  /** The stories that keep their place, input order. */
  kept: ScoredStory[];
  /** Lead id of a kept story -> lead ids of the follow-ups folded under it, input order. */
  related: Record<ArticleId, ArticleId[]>;
}

/**
 * Walk a RANKED list. A story that belongs to the running story of one already kept takes a place
 * only when it has independent weight (`independentPublishers` coverage publishers of its own) and
 * that running story holds fewer than `maxSlots` places; otherwise it is folded under the first
 * kept story it follows. Pure and order-preserving.
 */
export function foldRunningStories(ranked: readonly ScoredStory[]): RunningResult {
  const { independentPublishers, maxSlots } = ROUTE_POLICY.runningStory;
  const kept: ScoredStory[] = [];
  const related: Record<ArticleId, ArticleId[]> = {};
  // Parallel to `kept`: its signature and the index (into `kept`) of the head of its running story.
  const signatures: StorySignature[] = [];
  const head: number[] = [];
  const slots = new Map<number, number>();
  for (const story of ranked) {
    const sig = signatureOf(story);
    const of = signatures.findIndex((s) => sameRunningStory(sig, s));
    if (of < 0) {
      kept.push(story);
      signatures.push(sig);
      head.push(kept.length - 1);
      slots.set(kept.length - 1, 1);
      continue;
    }
    const group = head[of];
    const taken = slots.get(group) ?? 1;
    if (story.publishers.length >= independentPublishers && taken < maxSlots) {
      kept.push(story);
      signatures.push(sig);
      head.push(group);
      slots.set(group, taken + 1);
      continue;
    }
    (related[kept[of].lead] ??= []).push(story.lead);
  }
  return { kept, related };
}
