import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assembleUnderstanding } from '../src/index.ts';

test('a disconnected cyclic group remains reachable beside an ordinary theme', () => {
  const result = assembleUnderstanding({ nodes: ['root', 'a', 'b'].map(id => ({ id, type: 'topic' })).concat([{ id: 'n', type: 'concept' }]),
    edges: [{ source: 'root', target: 'n', type: 'contains' }, { source: 'a', target: 'b', type: 'contains' }, { source: 'b', target: 'a', type: 'contains' }] });
  assert.deepEqual(result.understanding.scenes.find(scene => scene.id === 'overview')!.nodeIds, ['root', 'a']);
});

test('documents do not replace content themes and tours retain the complete bounded theme scene', () => {
  const concepts = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, type: 'concept', sourceId: 'pdf', label: `Concept ${i}` }));
  const result = assembleUnderstanding({ nodes: [{ id: 'source:pdf', type: 'source', sourceId: 'pdf' }, { id: 'theme', type: 'topic', label: 'Climate' }, ...concepts],
    edges: concepts.map(node => ({ source: 'theme', target: node.id, type: 'contains' })) });
  assert.deepEqual(result.understanding.scenes.find(scene => scene.id === 'overview')!.nodeIds, ['theme']);
  assert.equal(result.understanding.learning.length, 1);
  assert.equal(result.understanding.learning[0].focusId, 'theme');
  assert.ok(concepts.every(node => result.understanding.learning[0].nodeIds.includes(node.id)));
  assert.deepEqual(result.understanding.learning[0].sourceIds, ['pdf']);
});

test('overlapping themes preserve each relation type and canonical provenance', () => {
  const result = assembleUnderstanding({ nodes: ['x', 'y', 'z'].map(id => ({ id, type: 'topic' })).concat(['a', 'b'].map(id => ({ id, type: 'concept' }))),
    edges: [{ source: 'x', target: 'a', type: 'contains' }, { source: 'z', target: 'a', type: 'contains' }, { source: 'y', target: 'b', type: 'contains' },
      { source: 'z', target: 'b', type: 'contains' }, { id: 'r1', source: 'a', target: 'b', type: 'contradicts' }, { id: 'r2', source: 'a', target: 'b', type: 'builds_on' }] });
  const aggregates = result.edges.filter(edge => edge.type === 'group_relation') as unknown as { source: string; target: string; metadata: { relationType: string; relationIds: string[] } }[];
  assert.ok(aggregates.some(edge => edge.source === 'z' && edge.target === 'y' && edge.metadata.relationIds.includes('r1')));
  assert.deepEqual(new Set(aggregates.filter(edge => edge.source === 'x' && edge.target === 'y').map(edge => edge.metadata.relationType)), new Set(['contradicts', 'builds_on']));
});
