import type { DemoPattern } from "./demo-patterns";

/** Render the same geometry that insertion uses, rather than an unrelated thumbnail. */
export function PatternPreview({ pattern }: { pattern: DemoPattern }) {
  const byId = new Map(pattern.nodes.map(node => [node.id, node]));
  return <svg className="pattern-diagram-preview" viewBox={`-24 -24 ${pattern.width + 48} ${pattern.height + 48}`} aria-hidden="true">
    {pattern.frames.map(frame => <rect key={frame.id} x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx="14" className="pattern-preview-frame" />)}
    {pattern.edges.map((edge, index) => {
      const source = byId.get(edge.source)!, target = byId.get(edge.target)!;
      const sx = source.x + source.w * edge.sourcePort[0], sy = source.y + source.h * edge.sourcePort[1];
      const tx = target.x + target.w * edge.targetPort[0], ty = target.y + target.h * edge.targetPort[1];
      return <path key={index} d={`M ${sx} ${sy} L ${tx} ${ty}`} className="pattern-preview-edge" />;
    })}
    {pattern.nodes.map(node => node.shape === "diamond"
      ? <path key={node.id} d={`M ${node.x + node.w / 2} ${node.y} L ${node.x + node.w} ${node.y + node.h / 2} L ${node.x + node.w / 2} ${node.y + node.h} L ${node.x} ${node.y + node.h / 2} Z`} fill={node.color} />
      : <rect key={node.id} x={node.x} y={node.y} width={node.w} height={node.h} rx={node.kind === "sticky" ? 4 : 18} fill={node.color} />)}
  </svg>;
}
