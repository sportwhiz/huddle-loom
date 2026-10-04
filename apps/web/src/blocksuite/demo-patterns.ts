/** Plain geometry keeps previews and native editable patterns in agreement. */
export type DemoPatternId = "update-flow" | "fifty-notes";
export type PatternBox = { id: string; x: number; y: number; w: number; h: number };
export type PatternNode = PatternBox & {
  kind: "sticky" | "shape";
  text: string;
  color: string;
  shape?: "roundedRect" | "diamond";
};
export type PatternEdge = {
  source: string;
  target: string;
  sourcePort: [number, number];
  targetPort: [number, number];
};
export type DemoPattern = {
  id: DemoPatternId;
  title: string;
  description: string;
  width: number;
  height: number;
  nodes: PatternNode[];
  frames: Array<PatternBox & { title: string; children: string[] }>;
  edges: PatternEdge[];
};
const indigo = "#ded6ff", saffron = "#fff0a6", moss = "#d2f2d0", blue = "#cceaff", peach = "#ffd6b0";
const step = (id: string, x: number, y: number, text: string, color = blue): PatternNode =>
  ({ id, x, y, w: 280, h: 160, text, color, kind: "shape", shape: "roundedRect" });
const edge = (source: string, target: string, sourcePort: [number, number] = [1, .5], targetPort: [number, number] = [0, .5]): PatternEdge =>
  ({ source, target, sourcePort, targetPort });
const nodes: PatternNode[] = [
  step("release", 50, 90, "1 · Publish a release\nPublic Open Whiteboard repo\nManifest pins the exact commit", indigo),
  step("discover", 410, 90, "2 · Check for updates\nYour Studio reads stable releases\nNo deploy hook needed", indigo),
  step("approve", 770, 90, "3 · Owner approves\nConfirm identity with MFA\nD1 records the selected release", saffron),
  step("hook", 1130, 90, "4 · Trigger deploy hook\nCloudflare rebuilds your copy\nOne active deployment at a time", saffron),
  step("installer", 1490, 90, "5 · Run your installer\nYour repo starts the runner\nIt does not need an upstream sync", saffron),
  step("fetch", 1490, 410, "6 · Fetch approved source\nDownload the exact upstream commit\nUse its pinned lockfile", blue),
  step("validate", 1130, 410, "7 · Validate before building\nCommit, version and schema digest\nReject incompatible formats", blue),
  step("preserve", 770, 410, "8 · Keep your installation\nWorker, domain, sign-in and secrets\nExisting D1, R2 and board rooms", moss),
  step("deploy", 410, 410, "9 · Checkpoint and deploy\nSave a D1 recovery bookmark\nApply migrations and publish", blue),
  step("verify", 50, 410, "10 · Verify live deployment\nRequested build and schema match\nCatalog can be queried", blue),
  { ...step("healthy", 50, 720, "Requested build\nhealthy?", saffron), h: 220, shape: "diamond" },
  step("success", 440, 745, "YES · Update complete\nHistory records the release\nYour existing boards stay available", moss),
  step("remember", 800, 745, "Remember installed release\nFuture builds of your old repo\nkeep deploying this release", moss),
  { id: "patches", kind: "sticky", x: 1160, y: 715, w: 260, h: 260, color: indigo,
    text: "Automatic security patches\nOptional. Same major/minor and compatible data. Feature releases need approval." },
  { id: "stores", kind: "sticky", x: 1480, y: 715, w: 260, h: 260, color: moss,
    text: "Data stays yours\nD1: catalog + settings\nBoard rooms: board state\nR2: files\nD1 bookmark ≠ full backup." },
  step("uncertain", 50, 1080, "NO · Pause new updates\nPublication may have happened\nInspect Cloudflare build history", peach),
  step("recheck", 440, 1080, "Owner recovery + fresh MFA\nRecheck the requested deployment\nor confirm the old build stopped", peach),
  step("retry", 800, 1080, "Retry the same deployment\nRetain release and checkpoint\nFence the previous runner", peach),
  { id: "rollback", kind: "sticky", x: 1160, y: 1045, w: 260, h: 220, color: peach,
    text: "Compatible rollback\nReturn to the previous release only when schema and board format match. Board edits are never reversed." },
  { id: "hosting", kind: "sticky", x: 1480, y: 1045, w: 260, h: 220, color: blue,
    text: "Cloudflare update demo\nNode.js shares versioning and history. GoDaddy currently updates by replacing the deployment ZIP." },
];
export const UPDATE_FLOW_PATTERN: DemoPattern = {
  id: "update-flow", title: "How updates work", width: 1820, height: 1320,
  description: "A complete, editable release-to-deployment demo with approval, verification, and recovery.",
  nodes,
  frames: [
    { id: "release-frame", x: 0, y: 0, w: 1820, h: 290, title: "01 · Release and approval →", children: nodes.slice(0, 5).map(n => n.id) },
    { id: "build-frame", x: 0, y: 330, w: 1820, h: 290, title: "02 · Build and preserve your Studio ←", children: nodes.slice(5, 10).map(n => n.id) },
    { id: "verify-frame", x: 0, y: 650, w: 1820, h: 330, title: "03 · Verification", children: nodes.slice(10, 15).map(n => n.id) },
    { id: "recovery-frame", x: 0, y: 1000, w: 1820, h: 320, title: "04 · Recovery", children: nodes.slice(15).map(n => n.id) },
  ],
  edges: [
    edge("release", "discover"), edge("discover", "approve"), edge("approve", "hook"), edge("hook", "installer"),
    edge("installer", "fetch", [.5, 1], [.5, 0]),
    edge("fetch", "validate", [0, .5], [1, .5]), edge("validate", "preserve", [0, .5], [1, .5]),
    edge("preserve", "deploy", [0, .5], [1, .5]), edge("deploy", "verify", [0, .5], [1, .5]),
    edge("verify", "healthy", [.5, 1], [.5, 0]), edge("healthy", "success"), edge("success", "remember"),
    edge("healthy", "uncertain", [.5, 1], [.5, 0]), edge("uncertain", "recheck"), edge("recheck", "retry"),
  ],
};
export const FIFTY_NOTES_PATTERN: DemoPattern = {
  id: "fifty-notes", title: "50 ideas", width: 2432, height: 1264,
  description: "Fifty blank sticky notes in a roomy grid. Start writing, then move and group your ideas.",
  nodes: Array.from({ length: 50 }, (_, index) => ({
    id: `idea-${index + 1}`, kind: "sticky" as const, text: "",
    x: 48 + (index % 10) * 232, y: 80 + Math.floor(index / 10) * 232,
    w: 208, h: 208, color: [saffron, peach, "#ffd2df", indigo, blue, moss][Math.floor(index / 10)],
  })),
  frames: [{ id: "ideas-frame", x: 0, y: 0, w: 2432, h: 1264, title: "50 ideas · Room for every thought", children: Array.from({ length: 50 }, (_, index) => `idea-${index + 1}`) }],
  edges: [],
};
export const DEMO_PATTERNS = [UPDATE_FLOW_PATTERN, FIFTY_NOTES_PATTERN];
export function demoPattern(id: DemoPatternId) {
  return DEMO_PATTERNS.find(pattern => pattern.id === id)!;
}
