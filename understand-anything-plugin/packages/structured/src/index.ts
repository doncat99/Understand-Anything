export interface UnderstandingScene { id: string; title: string; nodeIds: string[]; groupId?: string }
export interface UnderstandingPresentation {
  protocol: 'understand-anything.scenes.v1';
  overviewSceneIds: string[];
  scenes: UnderstandingScene[];
  layers: { id: string; name: string; description: string; nodeIds: string[] }[];
}

/** Organize canonical facts into bounded reading scenes, without inferring new facts. */
export function assembleUnderstanding<N extends { id: string; type: string; label?: string }, E extends { source: string; target: string; type: string }>(input: { nodes: N[]; edges: E[] }) {
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  const groups = new Map(input.nodes.filter(node => ['community', 'topic', 'cluster'].includes(node.type)).map(node => [node.id, new Set<string>()]));
  for (const edge of input.edges) if (edge.type === 'contains' && groups.has(edge.source) && byId.has(edge.target)) groups.get(edge.source)!.add(edge.target);
  const equivalent = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  for (const [id, members] of groups) {
    if (!members.size) continue;
    const key = JSON.stringify([...members].sort());
    const prior = equivalent.get(key);
    if (!prior) { equivalent.set(key, id); continue; }
    if (byId.get(id)?.type === 'topic' && byId.get(prior)?.type !== 'topic') {
      equivalent.set(key, id);
      aliases.set(id, [prior, ...(aliases.get(prior) ?? [])]);
      aliases.delete(prior);
    } else aliases.set(prior, [...(aliases.get(prior) ?? []), id]);
  }
  const canonical = [...equivalent.values()];
  const scenes: UnderstandingScene[] = [];
  const layers: UnderstandingPresentation['layers'] = [];
  const covered = new Set<string>();
  const pages = (ids: string[], prefix: string, title: string, groupId?: string) => {
    const result: string[] = [];
    for (let offset = 0; offset < ids.length; offset += groupId ? 63 : 64) {
      const id = `${prefix}:${result.length + 1}`;
      const nodeIds = groupId ? [groupId, ...ids.slice(offset, offset + 63)] : ids.slice(offset, offset + 64);
      scenes.push({ id, title, nodeIds, ...(groupId ? { groupId } : {}) });
      result.push(id);
      nodeIds.forEach(nodeId => covered.add(nodeId));
    }
    return result;
  };
  const overviewSceneIds = pages(canonical, 'overview', 'Overview');
  for (const id of canonical) {
    const members = [...groups.get(id)!];
    const name = byId.get(id)?.label ?? id;
    layers.push({ id, name, description: name, nodeIds: members });
    pages([...members, ...(aliases.get(id) ?? [])], `group:${id}`, name, id);
  }
  const ungrouped = input.nodes.filter(node => !covered.has(node.id)).map(node => node.id);
  overviewSceneIds.push(...pages(ungrouped, 'ungrouped', 'Other knowledge'));
  return { ...input, understanding: { protocol: 'understand-anything.scenes.v1' as const, overviewSceneIds, scenes, layers } };
}
