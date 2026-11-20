import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importanceOf, isLaunchTitle, isModelLaunchTitle, namesVersionedModel } from "./importance";
import { SCORE } from "./weights";

const total = (title: string): number => importanceOf(title).total;

describe("importance: launches", () => {
  it("counts a launch verb only next to a model or vendor name", () => {
    assert.ok(isLaunchTitle("Introducing Gemini 4 Neon"));
    assert.ok(isLaunchTitle("OpenAI Releases GPT-6.2 Astra and Sol With a 20% Cheaper Astra API"));
    assert.ok(isLaunchTitle("Google ships Gemini 4 Neon, its fourth new Gemini model in a month"));
    assert.ok(isLaunchTitle("Qwen3.8 is now available"));
    assert.ok(!isLaunchTitle("Introducing our new office in Lisbon"));
    assert.ok(!isLaunchTitle("Forum Is Now Available in Indonesia"));
    assert.ok(!isLaunchTitle("Gemini 4 Neon: GDM's Opus/Sol Contender"), "an entity without a launch verb");
  });

  it("adds the versioned-model bonus for a model family followed by a number", () => {
    const w = SCORE.importance;
    assert.equal(importanceOf("Introducing Gemini 4 Neon").launch, w.launch + w.versionedModel);
    assert.equal(importanceOf("Introducing Tool Retrieval in the Gemini API").launch, w.launch);
    for (const t of ["GPT-6.2 Astra", "Claude Fable 5.2", "Qwen3.8 LoRA", "Llama 4", "Gemini 4 Hydrogen", "o5 pro"]) assert.ok(namesVersionedModel(t), t);
    for (const t of ["llama.cpp b12549 released", "Top 5 tools", "Go 2 proposals", "Anthropic IPO"]) assert.ok(!namesVersionedModel(t), t);
  });

  it("tells a versioned model / product launch from an announcement", () => {
    for (const t of ["Introducing Gemini 4 Neon", "Introducing GPT-6.2 Astra and Sol", "Genie 4 is now available", "Gemini 4 Carbon is now available", "Inkling 2 Small released"]) assert.ok(isModelLaunchTitle(t), t);
    for (const t of ["Introducing Genie 4", "OpenAI Releases Sora 3", "Cognition ships Devin 3", "Kimi K3.1 Pro is now available"]) assert.ok(isModelLaunchTitle(t), t);
    const not = [
      "Introducing OpenAI for Chile",
      "Introducing ChatGPT for Sales",
      "OpenAI launches a $50 million fund",
      "OpenAI Launches Program With 12 Partners",
      "OpenAI releases report on November 19 outage",
      "Announcing our 2026 roadmap",
      "Gemini 4 Neon: a first look",
    ];
    for (const t of not) assert.ok(!isModelLaunchTitle(t), t);
  });

  it("ranks the frontier launch above PR vocabulary (V1: Meta microdrama 12, Gemini 4 Neon 9)", () => {
    assert.ok(total("Introducing Gemini 4 Neon") > total("Meta premieres India’s First Government-Led Microdrama Series on Scams Awareness"));
    assert.equal(total("Meta premieres India’s First Government-Led Microdrama Series on Scams Awareness"), 0);
  });
});

describe("importance: funding, regulatory, security", () => {
  it("needs an amount WITH a funding word, or an IPO / acquisition", () => {
    const w = SCORE.importance;
    assert.equal(importanceOf("LangChain Raises $300M Series C at $3B Valuation").funding, w.funding);
    assert.equal(importanceOf("Humyn Labs raises $47M to collect real-world data for robotics").funding, w.funding);
    assert.equal(importanceOf("Anthropic raises $81bn in record IPO").funding, w.funding);
    assert.equal(importanceOf("Palo Alto Networks acquires Applied Compute").funding, w.funding);
    assert.equal(importanceOf("China Railways Set Record With 4.13 Billion Trips in 10 Months").funding, 0);
    assert.equal(importanceOf("Nvidia's stock falls further. It has lost $611 billion in six trading days.").funding, 0);
    assert.equal(importanceOf("Season's Streamings and Savings: Black Friday Deals Come to GeForce NOW").funding, 0);
  });

  it("matches on word boundaries (V1: 'sues' fired on 'issues', 'valuation' on 'evaluation')", () => {
    assert.equal(total("How OpenAI's Performance Factory fixes performance issues"), 0);
    assert.equal(total("No commonly agreed evaluation for 11 kV cable models"), 0);
    assert.equal(total("arXiv:2611.23241v1 Announce Type: new"), 0);
    assert.equal(total("Dispatched: a history of batch scheduling"), 0);
    assert.equal(total("Building on Amazon Bedrock AgentCore"), 0, "'edr' / 'rce' inside words do not fire");
  });

  it("recognises regulatory actions", () => {
    const w = SCORE.importance;
    assert.equal(importanceOf("Arizona says it is investigating OpenAI, other firms over possible rogue agents").regulatory, w.regulatory);
    assert.equal(importanceOf("xAI sued over Grok images").regulatory, w.regulatory);
    assert.equal(importanceOf("EU fines Meta under the AI Act").regulatory, w.regulatory);
    assert.equal(importanceOf("UK court confirms British government served Apple with secret encryption notice").regulatory, w.regulatory);
    assert.equal(importanceOf("A gentle introduction to attention").regulatory, 0);
  });

  it("recognises security incidents", () => {
    const w = SCORE.importance;
    assert.equal(importanceOf("European Commission confirms cyberattack, says hackers used AI tool").security, w.security);
    assert.equal(importanceOf("CVE-2026-114938: Critical vulnerability in OpenJDK Java").security, w.security);
    assert.equal(importanceOf("Drupal patches critical RCE flaw, warns exploits may surface quickly").security, w.security);
    assert.equal(importanceOf("New prompt injection attack hijacks coding agents").security, w.security);
    assert.equal(importanceOf("Walter Isaacson on curiosity and creativity").security, 0);
  });

  it("is modest: the total never exceeds the cap and plain headlines score 0", () => {
    const loaded = "OpenAI launches GPT-7 after $40bn funding round as regulators probe data breach";
    const parts = importanceOf(loaded);
    assert.ok(parts.launch > 0 && parts.funding > 0 && parts.regulatory > 0 && parts.security > 0);
    assert.equal(parts.total, SCORE.importance.max);
    assert.ok(SCORE.importance.max <= 12);
    assert.equal(total("The Silent Consensus"), 0);
    assert.equal(total(""), 0);
  });
});
