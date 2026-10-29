import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = join(process.cwd(), 'understand-anything-plugin/skills/understand-knowledge/assemble-semantica-graph.py');

describe('Semantica structured input', () => {
  it('preserves stable IDs, evidence lineage, distinct same-name entities, and supplied tour', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ua-structured-'));
    try {
      const input = join(root, 'input.json');
      const output = join(root, 'output.json');
      await writeFile(input, JSON.stringify({
        project: { id: 'p1', name: 'Research' },
        snapshot: { snapshot_id: 'snap-1', evidence_spans: [{ id: 'ev-1', quote: 'A verified quote', sourceId: 'source-a', locator: { page: 2 } }] },
        entities: [
          { id: 'entity-a', canonical_name: 'Mercury', evidence_ids: ['ev-1'] },
          { id: 'entity-b', canonical_name: 'Mercury', evidence_ids: ['ev-1'] },
        ],
        relations: [{ id: 'rel-1', source_entity_id: 'entity-a', target_entity_id: 'entity-b', type: 'related', evidence_ids: ['ev-1'] }],
        tour: [{ order: 1, title: 'Start', nodeIds: ['entity-a'], focusNodeIds: ['entity-a'] }],
      }));
      await run('python3', [script, input, output]);
      const graph = JSON.parse(await readFile(output, 'utf8'));
      expect(graph.nodes.map((node) => node.id)).toEqual(['entity-a', 'entity-b']);
      expect(graph.nodes[0].knowledgeMeta.evidence[0].id).toBe('ev-1');
      expect(graph.edges[0].source).toBe('entity-a');
      expect(graph.tour[0].title).toBe('Start');
      expect(graph.nodes.every((node) => !('complexity' in node))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
