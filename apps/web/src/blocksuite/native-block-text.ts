type TextBlock = {
  id: string;
  props: object;
  children?: TextBlock[];
};
type SearchableProps = {
  text?: unknown;
  title?: unknown;
  caption?: unknown;
  cells?: unknown;
};
/** Include nested records and database cells in the product's board finder. */
export function nativeBlockText(
  block: TextBlock,
  visited = new Set<string>(),
): string {
  if (visited.has(block.id)) return '';
  visited.add(block.id);
  const props = block.props as SearchableProps;
  const cells = props.cells as
    | Record<string, Record<string, { value?: unknown }>>
    | undefined;
  return [
    String(props.text ?? props.title ?? props.caption ?? ''),
    ...Object.values(cells ?? {}).flatMap((row) =>
      Object.values(row).map((cell) => String(cell.value ?? '')),
    ),
    ...(block.children ?? []).map((child) => nativeBlockText(child, visited)),
  ]
    .filter(Boolean)
    .join('\n');
}
