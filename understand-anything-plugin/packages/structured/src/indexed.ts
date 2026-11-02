import { createHash } from 'node:crypto';

/** Disk-backed organizer. The caller budgets the immutable input. */
export interface IndexedDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}
export interface IndexedSink {
  node(node: Record<string, unknown>): void;
  edge(edge: Record<string, unknown>): void;
  reference(aggregate: string, relation: string): void;
  scene(scope: string, title: string, ids: string[]): void;
  lesson(ordinal: number, lesson: { id: string; title: string; objective: string; focusId: string; nodeIds: string[]; sourceIds: string[] }): void;
  check(): void;
  /** Host supplies batched writes; SQL-heavy navigation stays in the child. */
  write?(sql: string, ...args: unknown[]): unknown;
}
type Row = Record<string, string | number>;

/** Input tables: ua_nodes, ua_facts, ua_members and ua_sources. No eager graph export. */
export function organizeIndexed(db: IndexedDatabase, sink: IndexedSink) {
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[];
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Row | undefined;
  const count = (sql: string, ...args: unknown[]) => Number(one(sql, ...args)?.n ?? 0);
  const run = (sql: string, ...args: unknown[]) => { sink.check(); return sink.write ? sink.write(sql, ...args) : db.prepare(sql).run(...args); };
  function* scan(sql: string, args: unknown[] = []): Generator<Row> {
    let cursor = '';
    while (true) {
      sink.check();
      const page = rows(sql, ...args, cursor);
      if (!page.length) break;
      for (const row of page) yield row;
      cursor = String(page[page.length - 1]!.id);
    }
  }
  db.exec(`CREATE TABLE ua_navigation(parent TEXT,child TEXT,PRIMARY KEY(parent,child));
    CREATE INDEX ua_navigation_child ON ua_navigation(child,parent);
    CREATE TABLE ua_roots(id TEXT PRIMARY KEY);
    CREATE TABLE ua_reachable(id TEXT PRIMARY KEY);
    CREATE TABLE ua_scenes(id TEXT PRIMARY KEY,title TEXT,ids TEXT);
    CREATE TABLE ua_frontier(node TEXT,representative TEXT,PRIMARY KEY(node,representative));
    CREATE TABLE ua_visible(id TEXT PRIMARY KEY);
    CREATE TABLE ua_aggregates(source TEXT,target TEXT,type TEXT,direction TEXT,relation TEXT,PRIMARY KEY(source,target,type,direction,relation));
    CREATE TABLE ua_planned(id TEXT PRIMARY KEY);
    CREATE TABLE ua_covered(source TEXT PRIMARY KEY);
    CREATE TABLE ua_aliases(id TEXT PRIMARY KEY,canonical TEXT);
    CREATE TABLE ua_signatures(signature TEXT PRIMARY KEY,canonical TEXT);
    INSERT INTO ua_navigation SELECT m.parent,m.child FROM ua_members m JOIN ua_nodes n ON n.id=m.child;`);
  // Exact membership equality only; never infer that similarly named themes are equivalent.
  for (const type of ['topic', 'community', 'cluster']) {
    for (const group of scan('SELECT id FROM ua_nodes WHERE type=? AND id>? ORDER BY id LIMIT 128', [type])) {
      const id = String(group.id), hash = createHash('sha256'); let members = 0;
      for (const member of scan('SELECT child AS id FROM ua_navigation WHERE parent=? AND child>? ORDER BY child LIMIT 128', [id])) {
        hash.update(JSON.stringify(String(member.id))); members++;
      }
      if (!members) continue;
      const signature = hash.digest('hex'), canonical = one('SELECT canonical FROM ua_signatures WHERE signature=?', signature);
      if (canonical) run('INSERT INTO ua_aliases VALUES(?,?)', id, canonical.canonical);
      else run('INSERT INTO ua_signatures VALUES(?,?)', signature, id);
    }
  }
  run('INSERT OR IGNORE INTO ua_navigation SELECT canonical,id FROM ua_aliases');
  run("INSERT INTO ua_roots SELECT id FROM ua_nodes n WHERE type<>'source' AND NOT EXISTS(SELECT 1 FROM ua_navigation m WHERE m.child=n.id AND m.parent<>n.id)");
  // Include every disconnected cycle, while leaving shared descendants shared.
  const visit = (id: string) => run(`WITH RECURSIVE descendants(id) AS (VALUES(?) UNION SELECT m.child FROM ua_navigation m JOIN descendants d ON m.parent=d.id)
    INSERT OR IGNORE INTO ua_reachable SELECT id FROM descendants`, id);
  for (const row of scan('SELECT id FROM ua_roots WHERE id>? ORDER BY id LIMIT 128')) visit(String(row.id));
  for (const row of scan("SELECT id FROM ua_nodes WHERE type IN ('topic','community','cluster') AND id>? ORDER BY id LIMIT 128")) {
    const id = String(row.id);
    if (!one('SELECT 1 FROM ua_reachable WHERE id=?', id)) { run('INSERT OR IGNORE INTO ua_roots VALUES(?)', id); visit(id); }
  }
  let sequence = 0;
  const jsonNode = (id: string) => JSON.parse(String(one('SELECT json FROM ua_nodes WHERE id=?', id)!.json)) as Record<string, unknown>;
  const addCollection = (members: string[], title: string) => {
    const id = `ua:collection:${sequence++}`;
    const node = { id, type: 'topic', label: title, layer: 'knowledge', metadata: {
      presentationOnly: true, understandingGroup: { kind: 'collection', memberCount: members.length },
      content: 'Navigation collection; this grouping does not assert a semantic relationship.' } };
    run('INSERT INTO ua_nodes VALUES(?,?,?,?)', id, node.type, node.label, JSON.stringify(node));
    sink.node(node);
    for (const member of members) run('INSERT INTO ua_navigation VALUES(?,?)', id, member);
    return id;
  };
  // Reserve one slot for a group's own card: a scene always contains <=128 cards.
  const storeScene = (scope: string, title: string, members: string[]) => {
    const ids = scope ? [scope, ...members.filter(id => id !== scope)] : members;
    run('INSERT INTO ua_scenes VALUES(?,?,?)', scope, title, JSON.stringify(ids));
  };
  const sceneFor = (scope: string, title: string, sql: string, args: unknown[]) => {
    let members: string[] = [];
    const capacity = scope ? 127 : 128;
    let childLevel = 0;
    // Each level is a disk queue. Never retain all child collections in JS.
    db.exec('CREATE TABLE IF NOT EXISTS ua_queue(level INTEGER,id TEXT,PRIMARY KEY(level,id))');
    run('DELETE FROM ua_queue');
    for (const row of scan(sql, args)) {
      const id = String(row.id);
      if (id === scope) continue;
      members.push(id);
      if (members.length === capacity + 1) {
        const overflow = members.splice(127);
        const child = addCollection(members, `${title} · ${sequence + 1}`);
        storeScene(child, `${title} · ${sequence}`, members);
        run('INSERT INTO ua_queue VALUES(?,?)', 0, child);
        members = overflow;
      }
    }
    if (!count('SELECT count(*) n FROM ua_queue')) { storeScene(scope, title, members); return; }
    if (members.length) {
      const child = addCollection(members, `${title} · ${sequence + 1}`);
      storeScene(child, `${title} · ${sequence}`, members);
      run('INSERT INTO ua_queue VALUES(?,?)', 0, child);
    }
    while (count('SELECT count(*) n FROM ua_queue WHERE level=?', childLevel) > capacity) {
      members = [];
      for (const row of scan('SELECT id FROM ua_queue WHERE level=? AND id>? ORDER BY id LIMIT 128', [childLevel])) {
        members.push(String(row.id));
        if (members.length === 127) {
          const child = addCollection(members, `${title} · ${sequence + 1}`);
          storeScene(child, `${title} · ${sequence}`, members);
          run('INSERT INTO ua_queue VALUES(?,?)', childLevel + 1, child); members = [];
        }
      }
      if (members.length) {
        const child = addCollection(members, `${title} · ${sequence + 1}`);
        storeScene(child, `${title} · ${sequence}`, members);
        run('INSERT INTO ua_queue VALUES(?,?)', childLevel + 1, child);
      }
      childLevel++;
    }
    storeScene(scope, title, rows('SELECT id FROM ua_queue WHERE level=? ORDER BY id LIMIT 128', childLevel).map(row => String(row.id)));
  };
  for (const row of scan("SELECT id,label FROM ua_nodes n WHERE type IN ('topic','community','cluster') AND id NOT LIKE 'ua:collection:%' AND NOT EXISTS(SELECT 1 FROM ua_aliases a WHERE a.id=n.id) AND id>? ORDER BY id LIMIT 128")) {
    const id = String(row.id), title = String(row.label);
    const node = jsonNode(id);
    node.metadata = { ...(node.metadata as object ?? {}), understandingGroup: { kind: 'theme', memberCount: count('SELECT count(*) n FROM ua_navigation WHERE parent=?', id) } };
    sink.node(node);
    sceneFor(id, title, 'SELECT child AS id FROM ua_navigation WHERE parent=? AND child>? ORDER BY child LIMIT 128', [id]);
  }
  sceneFor('', 'Overview', 'SELECT id FROM ua_roots WHERE id>? ORDER BY id LIMIT 128', []);
  for (const row of scan("SELECT id,label FROM ua_nodes WHERE type='source' AND id>? ORDER BY id LIMIT 128")) {
    sceneFor(String(row.id), String(row.label), 'SELECT node AS id FROM ua_sources WHERE source=? AND node>? ORDER BY node LIMIT 128', [String(jsonNode(String(row.id)).sourceId ?? String(row.id).replace(/^source:/, ''))]);
  }
  let lessons = 0;
  for (const row of scan('SELECT id,title,ids FROM ua_scenes WHERE id>? ORDER BY id LIMIT 128')) {
    // The empty overview key is processed separately below.
    processScene(String(row.id), String(row.title), JSON.parse(String(row.ids)) as string[]);
  }
  const overview = one("SELECT title,ids FROM ua_scenes WHERE id=''")!;
  processScene('', String(overview.title), JSON.parse(String(overview.ids)) as string[]);
  function processScene(scope: string, title: string, ids: string[]) {
    sink.check(); sink.scene(scope, title, ids);
    if (scope.startsWith('source:')) return;
    const knowledge = ids.filter(id => one("SELECT 1 FROM ua_nodes WHERE id=? AND type IN ('concept','claim','entity','question','formula')", id));
    if (!knowledge.length) return;
    const placeholders = knowledge.map(() => '?').join(',');
    const sources = rows(`SELECT DISTINCT source FROM ua_sources WHERE node IN (${placeholders}) ORDER BY source LIMIT 129`, ...knowledge).map(row => String(row.source));
    if (sources.length > 128) throw new Error('UA reading scene exceeds 128 source references.');
    if (!sources.length) return;
    const nodeIds = ids.filter(id => id === scope || !one('SELECT 1 FROM ua_scenes WHERE id=?', id));
    sink.lesson(lessons++, { id: `reading:${scope ? `group:${scope}` : 'overview'}`, title, objective: `Explore ${title}: inspect concepts, recorded relationships and source evidence. No prerequisites or mastery assessment inferred.`, focusId: scope || knowledge[0]!, nodeIds, sourceIds: sources });
    for (const id of knowledge) run('INSERT OR IGNORE INTO ua_planned VALUES(?)', id);
    for (const source of sources) run('INSERT OR IGNORE INTO ua_covered VALUES(?)', source);
  }
  // Only Overview relationships belong to the initial publication. The full
  // navigation and reading catalog above remain complete and independently usable.
  organizeIndexedScene(db, sink, '');
  // Union-find lives on disk too; metrics do not need an eager adjacency graph.
  db.exec("CREATE TABLE ua_components(id TEXT PRIMARY KEY,parent TEXT,rank INTEGER); INSERT INTO ua_components SELECT id,id,0 FROM ua_nodes WHERE type='concept'");
  const root = (id: string): { id: string; rank: number } | undefined => {
    let row = one('SELECT parent,rank FROM ua_components WHERE id=?', id);
    if (!row) return;
    while (String(row.parent) !== id) { id = String(row.parent); row = one('SELECT parent,rank FROM ua_components WHERE id=?', id)!; }
    return { id, rank: Number(row.rank) };
  };
  let edgeCount = 0;
  for (const fact of scan('SELECT id,source,target FROM ua_facts WHERE id>? ORDER BY id LIMIT 128')) {
    const a = root(String(fact.source)), b = root(String(fact.target));
    if (!a || !b) continue;
    edgeCount++;
    if (a.id === b.id) continue;
    const [parent, child] = a.rank >= b.rank ? [a,b] : [b,a];
    run('UPDATE ua_components SET parent=? WHERE id=?', parent.id, child.id);
    if (a.rank === b.rank) run('UPDATE ua_components SET rank=rank+1 WHERE id=?', parent.id);
  }
  const communitySizes = one("SELECT count(*) AS n,coalesce(min(size),0) AS min,coalesce(max(size),0) AS max FROM (SELECT n.id,count(m.child) AS size FROM ua_nodes n LEFT JOIN ua_members m ON m.parent=n.id WHERE n.type='community' GROUP BY n.id)")!;
  const isolatedNodeCount = count("SELECT count(*) n FROM ua_nodes n WHERE type='concept' AND NOT EXISTS(SELECT 1 FROM ua_facts f JOIN ua_nodes b ON b.id=f.target AND b.type='concept' WHERE f.source=n.id) AND NOT EXISTS(SELECT 1 FROM ua_facts f JOIN ua_nodes a ON a.id=f.source AND a.type='concept' WHERE f.target=n.id)");
  return { totalModules: lessons, totalLessons: lessons, estimatedMinutes: 0, strategy: 'theme-reading' as const,
    graphMetrics: { knowledgeNodeCount: count('SELECT count(*) n FROM ua_components'), edgeCount, isolatedNodeCount,
      connectedComponentCount: count('SELECT count(*) n FROM ua_components WHERE id=parent'), communityCount: Number(communitySizes.n),
      minCommunitySize: Number(communitySizes.min), maxCommunitySize: Number(communitySizes.max) },
    coverage: { knowledgeNodeCount: count("SELECT count(*) n FROM ua_nodes WHERE type='concept'"),
      connectedKnowledgeNodeCount: count("SELECT count(*) n FROM ua_nodes n WHERE n.type='concept' AND (EXISTS(SELECT 1 FROM ua_facts f WHERE f.source=n.id) OR EXISTS(SELECT 1 FROM ua_facts f WHERE f.target=n.id))"),
      sourceCount: count("SELECT count(*) n FROM ua_nodes WHERE type='source'"), coveredSourceCount: count('SELECT count(*) n FROM ua_covered'),
      plannedKnowledgeNodeCount: count('SELECT count(*) n FROM ua_planned'),
      unclusteredNodeCount: count("SELECT count(*) n FROM ua_nodes n WHERE type='concept' AND NOT EXISTS(SELECT 1 FROM ua_planned p WHERE p.id=n.id)") } };
}

/** Expand one catalog scene. Call in a cancellable child, with atomic cache publication. */
export function organizeIndexedScene(db: IndexedDatabase, sink: Pick<IndexedSink, 'edge' | 'reference' | 'check' | 'write'>, scope: string) {
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[];
  const run = (sql: string, ...args: unknown[]) => { sink.check(); return sink.write ? sink.write(sql, ...args) : db.prepare(sql).run(...args); };
  const scene = db.prepare('SELECT ids FROM ua_scenes WHERE id=?').get(scope) as { ids: string } | undefined;
  if (!scene) throw new Error('UA scene is not in this catalog.');
  const ids = JSON.parse(scene.ids) as string[];
  const sceneId = scope ? `group:${scope}` : 'overview';
  run('DELETE FROM ua_frontier'); run('DELETE FROM ua_visible'); run('DELETE FROM ua_aggregates');
  for (const id of ids) if (id !== scope) run('INSERT INTO ua_visible VALUES(?)', id);
  for (const id of ids) if (id !== scope) {
    run(`WITH RECURSIVE descendants(id) AS (VALUES(?) UNION SELECT m.child FROM ua_navigation m JOIN descendants d ON m.parent=d.id
      WHERE NOT EXISTS(SELECT 1 FROM ua_visible v WHERE v.id=m.child) AND m.child<>?)
      INSERT OR IGNORE INTO ua_frontier SELECT id,? FROM descendants`, id, scope, id);
    if (scope) sink.edge({ id: `ua:contains:${scope}:${id}`, source: scope, target: id, type: 'contains', layer: 'knowledge', metadata: { presentationOnly: true, sceneId } });
  }
  run(`INSERT OR IGNORE INTO ua_aggregates SELECT a.representative,b.representative,f.type,
    coalesce(json_extract(f.json,'$.metadata.direction'),'forward'),f.id
    FROM ua_frontier a JOIN ua_facts f ON f.source=a.node JOIN ua_frontier b ON b.node=f.target
    WHERE a.representative<>b.representative AND (a.representative<>f.source OR b.representative<>f.target)`);
  // Aggregate once. Paginating an expression over GROUP BY repeated the entire
  // aggregation for every page. A disk table gives the continuation an index.
  db.exec('DROP TABLE IF EXISTS ua_links; CREATE TABLE ua_links(source TEXT,target TEXT,type TEXT,direction TEXT,n INTEGER,PRIMARY KEY(source,target,type,direction))');
  run('INSERT INTO ua_links SELECT source,target,type,direction,count(*) FROM ua_aggregates GROUP BY source,target,type,direction');
  let cursor = ['', '', '', ''];
  for (;;) {
    sink.check();
    const links = rows('SELECT * FROM ua_links WHERE (source,target,type,direction)>(?,?,?,?) ORDER BY source,target,type,direction LIMIT 128', ...cursor);
    if (!links.length) break;
    for (const link of links) {
      const aggregate = `ua:relation:${createHash('sha256').update(JSON.stringify([sceneId,link.source,link.target,link.type,link.direction])).digest('hex')}`;
      const args = [link.source,link.target,link.type,link.direction];
      const preview = rows('SELECT relation FROM ua_aggregates WHERE source=? AND target=? AND type=? AND direction=? ORDER BY relation LIMIT 16', ...args).map(r => String(r.relation));
      sink.edge({ id: aggregate,source:link.source,target:link.target,type:'group_relation',layer:'knowledge',label:`${link.n} ${String(link.type).replaceAll('_',' ')}`,
        metadata: { presentationOnly:true,sceneId,direction:link.direction,relationType:link.type,relationCount:link.n,relationIds:preview,relationReference:aggregate } });
      let last = '';
      for (;;) {
        sink.check();
        const refs = rows('SELECT relation FROM ua_aggregates WHERE source=? AND target=? AND type=? AND direction=? AND relation>? ORDER BY relation LIMIT 128', ...args,last);
        if (!refs.length) break;
        for (const ref of refs) sink.reference(aggregate,String(ref.relation));
        last = String(refs.at(-1)!.relation);
      }
    }
    const end = links.at(-1)!;
    cursor = [end.source,end.target,end.type,end.direction].map(String);
  }
}
