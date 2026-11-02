import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assembleUnderstanding } from '../src/index.ts';

test('a visible ungrouped endpoint represents itself beside a collapsed theme', () => {
  const result = assembleUnderstanding({ nodes: [{ id: 'theme', type: 'topic' }, { id: 'a', type: 'concept' }, { id: 'b', type: 'concept' }],
    edges: [{ source: 'theme', target: 'a', type: 'contains' }, { id: 'r', source: 'a', target: 'b', type: 'contradicts' }] });
  assert.ok(result.edges.some(edge => edge.type === 'group_relation' && edge.source === 'theme' && edge.target === 'b'));
});

test('a parent scene never collapses its direct visible child into the parent', () => {
  const result = assembleUnderstanding({ nodes: [{ id: 'outer', type: 'topic' }, { id: 'inner', type: 'topic' }, { id: 'a', type: 'concept' }, { id: 'b', type: 'concept' }],
    edges: [{ source: 'outer', target: 'inner', type: 'contains' }, { source: 'outer', target: 'b', type: 'contains' },
      { source: 'inner', target: 'a', type: 'contains' }, { id: 'r', source: 'a', target: 'b', type: 'contradicts' }] });
  assert.ok(result.edges.some(edge => edge.type === 'group_relation' && edge.source === 'inner' && edge.target === 'b'));
  assert.ok(!result.edges.some(edge => edge.type === 'group_relation' && edge.source === 'inner' && edge.target === 'outer'));
});

test('large aggregates have bounded previews and lossless separate provenance references', () => {
  const result = assembleUnderstanding({ nodes: [{ id: 'x', type: 'topic' }, { id: 'y', type: 'topic' }, { id: 'a', type: 'concept' }, { id: 'b', type: 'concept' }],
    edges: [{ source: 'x', target: 'a', type: 'contains' }, { source: 'y', target: 'b', type: 'contains' },
      ...Array.from({ length: 2048 }, (_, i) => ({ id: `r${i}`, source: 'a', target: 'b', type: 'contradicts' }))] });
  const link = result.edges.find(edge => edge.type === 'group_relation') as any;
  assert.equal(link.metadata.relationCount, 2048);
  assert.ok(link.metadata.relationIds.length <= 16);
  assert.equal((result as any).relationReferences.filter((ref: any) => ref.aggregateId === link.id).length, 2048);
});
