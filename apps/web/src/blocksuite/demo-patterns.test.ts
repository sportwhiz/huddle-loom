import { describe, expect, it } from "vitest";
import { DEMO_PATTERNS, FIFTY_NOTES_PATTERN, UPDATE_FLOW_PATTERN } from "./demo-patterns";

describe("editable demo patterns", () => {
  it("provides exactly fifty empty notes with room between them", () => {
    const notes = FIFTY_NOTES_PATTERN.nodes;
    expect(notes).toHaveLength(50);
    expect(notes.every(note => note.kind === "sticky" && note.text === "")).toBe(true);
    expect(new Set(notes.map(note => note.color)).size).toBe(5);
    for (const a of notes) for (const b of notes) {
      if (a.id === b.id) continue;
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
  });
  it("keeps every node inside its assigned frame with unique identities", () => {
    for (const pattern of DEMO_PATTERNS) {
      expect(new Set(pattern.nodes.map(node => node.id)).size).toBe(pattern.nodes.length);
      const children = pattern.frames.flatMap(frame => frame.children);
      expect(new Set(children).size).toBe(pattern.nodes.length);
      for (const frame of pattern.frames) for (const id of frame.children) {
        const node = pattern.nodes.find(node => node.id === id)!;
        expect(node.x).toBeGreaterThanOrEqual(frame.x);
        expect(node.y).toBeGreaterThanOrEqual(frame.y);
        expect(node.x + node.w).toBeLessThanOrEqual(frame.x + frame.w);
        expect(node.y + node.h).toBeLessThanOrEqual(frame.y + frame.h);
      }
    }
  });
  it("connects the full release path and both verification outcomes without dangling ends", () => {
    const pattern = UPDATE_FLOW_PATTERN;
    const ids = new Set(pattern.nodes.map(node => node.id));
    for (const edge of pattern.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
    const reachable = new Set(["release"]);
    for (let i = 0; i < pattern.nodes.length; i++) for (const edge of pattern.edges) {
      if (reachable.has(edge.source)) reachable.add(edge.target);
    }
    for (const id of ["installer", "fetch", "validate", "preserve", "deploy", "verify", "healthy", "success", "remember", "uncertain", "recheck", "retry"]) {
      expect(reachable.has(id), id).toBe(true);
    }
  });
});
