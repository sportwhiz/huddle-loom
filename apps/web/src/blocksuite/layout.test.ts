import { describe, expect, it } from "vitest";
import {
  arrangeBoxes,
  findOpenPosition,
  connectedPosition,
  CONNECTION_PORTS,
} from "./layout";

describe("quick note placement", () => {
  it("keeps a free position and moves past a chain of obstructing objects", () => {
    const desired = { id: "new", x: 300, y: 0, w: 208, h: 208 };
    const blockers = [
      { id: "first", x: 304, y: 0, w: 208, h: 208 },
      { id: "second", x: 304, y: 240, w: 208, h: 208 },
      { id: "unrelated", x: 900, y: 0, w: 208, h: 800 },
    ];
    expect(findOpenPosition(desired, [])).toEqual(desired);
    expect(findOpenPosition(desired, blockers)).toEqual({ ...desired, y: 480 });
    expect(desired.y).toBe(0);
  });
});

describe("selection arrangement", () => {
  const boxes = [
    { id: "a", x: 10, y: 30, w: 80, h: 50 },
    { id: "b", x: 180, y: 10, w: 120, h: 70 },
    { id: "c", x: 400, y: 120, w: 60, h: 90 },
  ];
  it("aligns different-sized objects to their shared right edge without mutating input", () => {
    const result = arrangeBoxes(boxes, "right");
    expect(result.map((b) => b.x + b.w)).toEqual([460, 460, 460]);
    expect(result.map((b) => b.y)).toEqual([30, 10, 120]);
    expect(boxes[0].x).toBe(10);
  });
  it("distributes by equal edge gaps while retaining the two outside objects", () => {
    const result = arrangeBoxes(boxes, "horizontal");
    expect(result[0].x).toBe(10);
    expect(result[2].x).toBe(400);
    expect(result[1].x - result[0].x - result[0].w).toBe(
      result[2].x - result[1].x - result[1].w,
    );
  });
  it("orders a tidy grid by visual position and leaves room for the largest object", () => {
    const result = arrangeBoxes(boxes, "grid");
    expect(result.map((b) => b.id)).toEqual(["b", "a", "c"]);
    expect(result[1].x - result[0].x).toBe(152);
    expect(result[2].y - result[0].y).toBe(122);
  });
  it("does not attempt distribution with only two objects", () => {
    expect(arrangeBoxes(boxes.slice(0, 2), "vertical")).toEqual(
      boxes.slice(0, 2),
    );
  });
});

describe("connected branch placement", () => {
  const source = { id: "s", x: 500, y: 500, w: 160, h: 240 };
  it("keeps dimensions and points outward in all four directions", () => {
    expect(connectedPosition(source, "left", []).x).toBe(244);
    expect(connectedPosition(source, "right", []).x).toBe(756);
    expect(connectedPosition(source, "up", []).y).toBe(164);
    expect(connectedPosition(source, "down", []).y).toBe(836);
    for (const ports of Object.values(CONNECTION_PORTS)) {
      expect(ports.source[0] + ports.target[0]).toBe(1);
      expect(ports.source[1] + ports.target[1]).toBe(1);
    }
  });
  it("moves an upward branch sideways to avoid a chain without crossing below its source", () => {
    const obstacle = { id: "a", x: 500, y: 164, w: 160, h: 240 };
    const next = connectedPosition(source, "up", [
      source,
      obstacle,
      { ...obstacle, id: "b", x: 692 },
    ]);
    expect(next.y).toBe(164);
    expect(next.x).toBe(884);
    expect(next.w).toBe(160);
    expect(next.h).toBe(240);
    expect(source.x).toBe(500);
  });
});
