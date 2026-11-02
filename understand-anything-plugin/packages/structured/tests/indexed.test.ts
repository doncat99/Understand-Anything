import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { organizeIndexed } from '../src/indexed.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ua_nodes(id TEXT PRIMARY KEY,type TEXT,label TEXT,json TEXT);
    CREATE TABLE ua_facts(id TEXT PRIMARY KEY,source TEXT,target TEXT,type TEXT,json TEXT);
    CREATE INDEX f_source ON ua_facts(source); CREATE INDEX f_target ON ua_facts(target);
    CREATE TABLE ua_members(parent TEXT,child TEXT,PRIMARY KEY(parent,child)); CREATE INDEX m_child ON ua_members(child);
    CREATE TABLE ua_sources(node TEXT,source TEXT,PRIMARY KEY(node,source));`);
  const node = (id: string, type = 'concept') => db.prepare('INSERT INTO ua_nodes VALUES(?,?,?,?)').run(id, type, id, JSON.stringify({ id, type, label: id }));
  const member = (parent: string, child: string) => db.prepare('INSERT INTO ua_members VALUES(?,?)').run(parent, child);
  const fact = (id: string, source: string, target: string, direction = 'forward') => db.prepare('INSERT INTO ua_facts VALUES(?,?,?,?,?)').run(id, source, target, 'contradicts', JSON.stringify({ id, source, target, type: 'contradicts', metadata: { direction } }));
  const scenes = new Map<string, string[]>(), edges: any[] = [], lessons: any[] = [], refs: string[] = [];
  const sink = { node() {}, edge: (edge: any) => edges.push(edge), reference: (_: string, relation: string) => refs.push(relation),
    scene(scope: string, _: string, ids: string[]) { assert.ok(ids.length <= 128); scenes.set(scope, ids); },
    lesson(_: number, lesson: any) { lessons.push(lesson); }, check() {} };
  return { db, node, member, fact, scenes, edges, lessons, refs, sink };
}
test('indexed scenes retain nested/overlapping rollups, direction, provenance and source-backed reading', () => {
  const f = fixture();
  for (const id of ['outer','inner','other']) f.node(id, 'topic');
  for (const id of ['a','b','ungrouped']) f.node(id);
  f.member('outer','inner'); f.member('inner','a'); f.member('other','b');
  f.fact('r','a','b'); f.fact('back','a','b','backward'); f.fact('direct','a','ungrouped');
  f.db.prepare('INSERT INTO ua_sources VALUES(?,?)').run('a','pdf');
  const result = organizeIndexed(f.db as any, f.sink);
  assert.deepEqual(f.scenes.get(''), ['other','outer','ungrouped']);
  const rootEdges = f.edges.filter(edge => edge.metadata?.sceneId === 'overview');
  assert.ok(rootEdges.some(edge => edge.source === 'outer' && edge.target === 'other' && edge.metadata.direction === 'backward'));
  assert.ok(rootEdges.some(edge => edge.source === 'outer' && edge.target === 'ungrouped'));
  assert.ok(f.lessons.some(lesson => lesson.nodeIds.includes('a') && lesson.sourceIds.includes('pdf')));
  assert.equal(result.coverage.plannedKnowledgeNodeCount, 1);
  assert.ok(f.refs.includes('r')); f.db.close();
});
test('large themes stay fully reachable through bounded collections and cycles remain reachable', () => {
  const f = fixture(); f.node('theme','topic'); f.node('cycleA','topic'); f.node('cycleB','topic');
  f.member('cycleA','cycleB'); f.member('cycleB','cycleA');
  for (let i=0;i<500;i++) { f.node(`n${i}`); f.member('theme',`n${i}`); }
  organizeIndexed(f.db as any, f.sink);
  assert.ok(f.scenes.get('')!.includes('cycleA'));
  assert.ok(f.scenes.get('theme')!.length < 128);
  const seen = new Set<string>(); const visit = (id: string) => { if(seen.has(id))return; seen.add(id); for(const child of f.scenes.get(id) ?? []) if(child!==id)visit(child); };
  for(const id of f.scenes.get('')!)visit(id);
  for(let i=0;i<500;i++)assert.ok(seen.has(`n${i}`)); f.db.close();
});
test('exactly equivalent groups share one overview entry and source scenes use canonical source ids', () => {
  const f = fixture(); f.node('topic', 'topic'); f.node('community','community'); f.node('a');
  f.member('topic','a'); f.member('community','a');
  f.db.prepare('INSERT INTO ua_nodes VALUES(?,?,?,?)').run('source:card','source','PDF',JSON.stringify({id:'source:card',sourceId:'canonical-pdf'}));
  f.db.prepare('INSERT INTO ua_sources VALUES(?,?)').run('a','canonical-pdf');
  organizeIndexed(f.db as any,f.sink);
  assert.deepEqual(f.scenes.get(''),['topic']);
  assert.deepEqual(f.scenes.get('topic'),['topic','a','community']);
  assert.deepEqual(f.scenes.get('source:card'),['source:card','a']);
  assert.equal(f.lessons.length,1); f.db.close();
});
