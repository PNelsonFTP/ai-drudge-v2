import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECTION_IDS, type SectionId } from "../../../shared/sections";
import { createFakeServices } from "../../../test/helpers/fakeServices";
import { SECTION_PRESETS, sectionPresetById } from "../../app/presets";
import { DEFAULT_SETTINGS, type BackupPreview, type MigrationCounts, type MigrationReport, type SectionPreset } from "../../app/services";
import {
  BACKUP_MAX_BYTES,
  activePreset,
  applyLayout,
  applyPreset,
  backupDryRun,
  moveSection,
  muteRows,
  pinSection,
  sectionSettings,
  storedOrder,
  toggleHidden,
  v1ImportLine,
  v1ImportedParts,
  v1SkippedLine,
} from "./model";

const DEFAULT = [...SECTION_IDS];

describe("settings/model - section order", () => {
  it("moving a section down swaps it with its neighbour and stores the full order", () => {
    const next = moveSection(null, "models", 1)!;
    assert.deepEqual(next.slice(0, 3), ["industry", "models", "ai_security"]);
    assert.equal(next.length, SECTION_IDS.length);
    assert.equal(new Set(next).size, SECTION_IDS.length);
  });

  it("moving back restores the default, which is stored as null", () => {
    const down = moveSection(null, "models", 1);
    assert.equal(moveSection(down, "models", -1), null);
  });

  it("moves at the edges are no-ops", () => {
    assert.equal(moveSection(null, "models", -1), null);
    assert.equal(moveSection(null, "releases", 1), null);
    const custom: SectionId[] = ["cyber", "models"];
    assert.deepEqual(moveSection(custom, "cyber", -1)?.slice(0, 3), ["cyber", "models", "industry"]);
  });

  it("works from a partial stored order and ignores unknown or duplicate ids", () => {
    const next = moveSection(["cyber", "bogus", "cyber", "policy"], "policy", -1)!;
    assert.deepEqual(next.slice(0, 3), ["policy", "cyber", "models"]);
    assert.equal(next.length, SECTION_IDS.length);
  });

  it("repeated moves walk a section through the list (keyboard reordering)", () => {
    let order: SectionId[] | null = null;
    for (let i = 0; i < SECTION_IDS.length - 1; i++) order = moveSection(order, "models", 1);
    assert.equal(order?.[SECTION_IDS.length - 1], "models");
    assert.deepEqual(order?.slice(0, -1), DEFAULT.slice(1));
    for (let i = 0; i < SECTION_IDS.length - 1; i++) order = moveSection(order, "models", -1);
    assert.equal(order, null);
  });

  it("pinSection moves a section to the top", () => {
    assert.deepEqual(pinSection(null, "cyber")?.slice(0, 3), ["cyber", "models", "industry"]);
    assert.equal(pinSection(null, "models"), null, "already first");
    assert.deepEqual(pinSection(["cyber", "policy"], "policy")?.slice(0, 2), ["policy", "cyber"]);
  });

  it("storedOrder normalises and collapses the default to null", () => {
    assert.equal(storedOrder(DEFAULT), null);
    assert.equal(storedOrder([]), null);
    assert.equal(storedOrder(["cyber"])?.[0], "cyber");
  });

  it("toggleHidden adds and removes, keeps default order and drops unknown ids", () => {
    assert.deepEqual(toggleHidden([], "quantum"), ["quantum"]);
    assert.deepEqual(toggleHidden(["quantum", "robotics", "bogus"], "models"), ["models", "robotics", "quantum"]);
    assert.deepEqual(toggleHidden(["quantum", "robotics"], "quantum"), ["robotics"]);
  });

  it("sectionSettings lists all sections in the reader's order with positions and flags", () => {
    const rows = sectionSettings({ sectionOrder: ["cyber", "ai_security"], hiddenSections: ["quantum"] });
    assert.equal(rows.length, SECTION_IDS.length);
    assert.deepEqual(rows.slice(0, 3).map((r) => [r.id, r.position, r.label]), [
      ["cyber", 1, "CYBER WIRE"],
      ["ai_security", 2, "AI SECURITY"],
      ["models", 3, "MODELS & LABS"],
    ]);
    assert.deepEqual([rows[0].canUp, rows[0].canDown], [false, true]);
    assert.deepEqual([rows.at(-1)!.canUp, rows.at(-1)!.canDown], [true, false]);
    assert.deepEqual(rows.filter((r) => r.hidden).map((r) => r.id), ["quantum"]);
  });
});

describe("settings/model - presets", () => {
  it("applyPreset turns each shipped preset into settings; Default clears the order", () => {
    assert.deepEqual(applyPreset(sectionPresetById("default")!), { sectionOrder: null, hiddenSections: [] });
    for (const p of SECTION_PRESETS.filter((x) => x.order)) {
      const s = applyPreset(p);
      assert.deepEqual(s.sectionOrder, p.order, p.id);
      assert.equal(s.sectionOrder?.length, SECTION_IDS.length);
    }
    assert.equal(applyPreset(sectionPresetById("ciso")!).sectionOrder?.[0], "ai_security");
    assert.equal(applyPreset(sectionPresetById("local-lab")!).sectionOrder?.[0], "open_local");
    assert.equal(applyPreset(sectionPresetById("markets")!).sectionOrder?.[0], "money");
  });

  it("ignores unknown section ids in a preset and completes a partial order", () => {
    const preset = { id: "x", label: "X", order: ["cyber", "retired_section", "models"], hidden: ["quantum", "retired_section"] } as unknown as SectionPreset;
    const s = applyPreset(preset);
    assert.deepEqual(s.sectionOrder?.slice(0, 3), ["cyber", "models", "industry"]);
    assert.equal(s.sectionOrder?.length, SECTION_IDS.length);
    assert.deepEqual(s.hiddenSections, ["quantum"]);
  });

  it("activePreset recognises the layout in use and reports custom layouts as null", () => {
    assert.equal(activePreset(DEFAULT_SETTINGS, SECTION_PRESETS), "default");
    for (const p of SECTION_PRESETS) assert.equal(activePreset(applyPreset(p), SECTION_PRESETS), p.id);
    assert.equal(activePreset({ sectionOrder: moveSection(null, "models", 1), hiddenSections: [] }, SECTION_PRESETS), null);
    assert.equal(activePreset({ sectionOrder: null, hiddenSections: ["quantum"] }, SECTION_PRESETS), null);
  });

  it("applyLayout writes order and hidden sections in ONE patch", () => {
    const layout = applyPreset(sectionPresetById("markets")!);
    const s = createFakeServices();
    applyLayout(s.settings, layout);
    assert.deepEqual(s.calls, ["settings.patch sectionOrder,hiddenSections"]);
    assert.equal(activePreset(s.settings.get(), SECTION_PRESETS), "markets");
  });

  it("presets round-trip through the settings store", () => {
    const s = createFakeServices();
    const next = applyPreset(sectionPresetById("ciso")!);
    s.settings.set("sectionOrder", next.sectionOrder);
    s.settings.set("hiddenSections", next.hiddenSections);
    assert.equal(activePreset(s.settings.get(), SECTION_PRESETS), "ciso");
    assert.equal(sectionSettings(s.settings.get())[0].id, "ai_security");
    s.settings.reset();
    assert.equal(activePreset(s.settings.get(), SECTION_PRESETS), "default");
  });
});

describe("settings/model - mutes", () => {
  it("lists sections first (homepage order), then sources by resolved name; unknown ids stay removable", () => {
    const names: Record<string, string> = { "the-verge-ai": "The Verge AI", "ars-ai": "Ars Technica AI" };
    const rows = muteRows({ sources: new Set(["the-verge-ai", "gone-feed", "ars-ai"]), sections: new Set<SectionId>(["quantum", "cyber"]) }, (id) => names[id]);
    assert.deepEqual(rows, [
      { kind: "section", id: "cyber", label: "CYBER WIRE" },
      { kind: "section", id: "quantum", label: "QUANTUM WATCH" },
      { kind: "source", id: "ars-ai", label: "Ars Technica AI" },
      { kind: "source", id: "gone-feed", label: "gone-feed" },
      { kind: "source", id: "the-verge-ai", label: "The Verge AI" },
    ]);
    assert.deepEqual(muteRows({ sources: new Set(), sections: new Set() }, () => undefined), []);
  });
});

describe("settings/model - backup dry run", () => {
  it("maps the service's preview to lines (replace) and warnings (skip)", () => {
    const calls: string[] = [];
    const service = {
      previewJson(text: string): BackupPreview {
        calls.push(text);
        return {
          ok: true,
          exportedAt: "2026-11-19T20:30:00.000Z",
          items: [
            { key: "aid2:saved", label: "Bookmarks and read later", action: "replace", detail: "12 bookmarks, 3 read later" },
            { key: "aid2:watchlist", label: "Watchlist", action: "replace", detail: "5 terms" },
            { key: "aid2:lastVisit", label: "Last visit", action: "skip", detail: "this device only" },
          ],
        };
      },
    };
    assert.deepEqual(backupDryRun(service, "{}"), {
      ok: true,
      lines: ["exported 2026-11-19 20:30 UTC", "Bookmarks and read later: 12 bookmarks, 3 read later", "Watchlist: 5 terms"],
      warnings: ["Last visit will not be restored (this device only)."],
    });
    assert.deepEqual(calls, ["{}"]);
  });

  it("passes a rejection through and refuses oversized input before parsing", () => {
    assert.deepEqual(backupDryRun({ previewJson: () => ({ ok: false, error: "This is not an AI DRUDGE backup file." }) }, "{}"), { ok: false, error: "This is not an AI DRUDGE backup file." });
    let asked = 0;
    const big = backupDryRun({ previewJson: () => (asked++, { ok: false, error: "x" }) }, "a".repeat(BACKUP_MAX_BYTES + 1));
    assert.ok(!big.ok && big.error.includes("too large"));
    assert.equal(asked, 0);
  });

  it("is a dry run: previewing what a services instance exports changes nothing", () => {
    const s = createFakeServices({ watchTerms: ["Qwen", "MCP"], mutedSources: ["a"] });
    const before = s.backup.exportJson();
    s.calls.length = 0;
    const summary = backupDryRun(s.backup, before);
    assert.ok(summary.ok);
    assert.ok(summary.lines.length > 0);
    assert.deepEqual(s.calls, ["backup.previewJson"]);
    assert.equal(s.backup.exportJson(), before);
  });
});

describe("settings/model - import from V1", () => {
  const counts = (over: Partial<MigrationCounts> = {}): MigrationCounts => ({ bookmarks: 0, later: 0, snapshots: 0, mutedSources: 0, pendingSourceNames: 0, mutedSections: 0, seen: 0, theme: false, lastVisit: false, ...over });

  it("already: date and what was imported come from the report", () => {
    const report: MigrationReport = { status: "already", at: "2026-11-19T20:30:00.000Z", imported: counts({ bookmarks: 12, later: 1, snapshots: 13, mutedSources: 2, mutedSections: 1, seen: 310, theme: true }) };
    assert.deepEqual(v1ImportedParts(report.imported), ["12 bookmarks", "1 read-later item", "2 muted sources", "1 muted section", "310 seen stories", "the theme"]);
    assert.equal(
      v1ImportLine(report),
      "Reader state from the previous version (V1) was imported on 2026-11-19: 12 bookmarks, 1 read-later item, 2 muted sources, 1 muted section, 310 seen stories, the theme.",
    );
    assert.equal(v1ImportLine({ status: "already", imported: counts() }), "Reader state from the previous version (V1) was imported.");
    assert.equal(v1ImportLine({ status: "already", at: "1", imported: counts() }), "Reader state from the previous version (V1) was imported.");
  });

  it("migrated: this page load imported; pending names are named as awaiting a match", () => {
    assert.equal(
      v1ImportLine({ status: "migrated", at: "2026-11-19T20:30:00.000Z", imported: counts({ bookmarks: 1, pendingSourceNames: 2 }) }),
      "Reader state from the previous version (V1) was imported: 1 bookmark, 2 muted sources awaiting a match.",
    );
    assert.match(v1ImportLine({ status: "migrated", imported: counts() }), /nothing new was found/);
  });

  it("names the V1 category mutes the import left out, the section each is now part of, and where to mute it", () => {
    assert.equal(v1SkippedLine(counts()), "");
    assert.equal(v1SkippedLine(counts({ skippedCategories: [] })), "");
    assert.equal(
      v1ImportLine({ status: "migrated", imported: counts({ mutedSections: 1, skippedCategories: ["local_models"] }) }),
      "Reader state from the previous version (V1) was imported: 1 muted section. Not carried over: the V1 mute of “local models” (now part of LOCAL & OPEN MODELS). A section is muted here only when every V1 category merged into it was muted; mute the section under Mutes if you want it hidden.",
    );
    assert.match(
      v1ImportLine({ status: "already", at: "2026-11-19T20:30:00.000Z", imported: counts({ bookmarks: 2, skippedCategories: ["funding", "products", "funding"] }) }),
      /imported on 2026-11-19: 2 bookmarks\. Not carried over: the V1 mute of “funding” \(now part of MARKETS & DEALS\) and “products” \(now part of AGENTS & TOOLS\)\. A section is muted here only when/,
    );
    assert.match(v1SkippedLine(counts({ skippedCategories: ["crypto"] })), /the V1 mute of “crypto” \(not a section here\)\./, "an id no section knows");
    // Untrusted V1 storage: long lists are cut, long names shortened, junk ignored.
    const many = v1SkippedLine(counts({ skippedCategories: ["a", "b", "c", "d", "e", "f", "g", "h", "  ", "x".repeat(90), 7 as unknown as string] }));
    assert.match(many, /“f” \(not a section here\) and 3 more\./);
    assert.ok(!many.includes("x".repeat(41)));
    // Nothing is said when the import did not run.
    assert.ok(!v1ImportLine({ status: "nothing", imported: counts({ skippedCategories: ["funding"] }) }).includes("Not carried over"));
    assert.ok(!v1ImportLine({ status: "failed", imported: counts({ skippedCategories: ["funding"] }) }).includes("Not carried over"));
  });

  it("nothing and failed have their own sentences", () => {
    assert.match(v1ImportLine({ status: "nothing", imported: counts() }), /nothing to import/);
    assert.match(v1ImportLine({ status: "failed", imported: counts({ bookmarks: 3 }) }), /tried again/);
  });
});
