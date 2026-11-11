/** Canonical semantics supplied by the knowledge owner, never inferred by the UI. */
export interface SemanticDetailsData {
  kind: 'assertion' | 'conflict' | 'entity' | 'formula';
  subject?: string;
  predicate?: string;
  object?: unknown;
  qualifiers?: unknown;
  status?: string;
  assertionIds?: string[];
  description?: string;
  attributes?: unknown;
  expression?: unknown;
}

export interface SemanticDetailsLabels {
  assertion: string; conflict: string; entity: string; formula: string;
  subject: string; predicate: string; object: string; qualifiers: string;
  status: string; assertions: string; description: string; attributes: string; expression: string;
}

function display(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Shared by node and relation inspectors. Missing fields are not fabricated. */
export function SemanticDetails({ data, labels, onSelectAssertion }: {
  data: SemanticDetailsData; labels: SemanticDetailsLabels; onSelectAssertion?: (id: string) => void;
}) {
  const fields = [
    [labels.subject, data.subject], [labels.predicate, data.predicate], [labels.object, data.object],
    [labels.qualifiers, data.qualifiers], [labels.status, data.status],
    [labels.description, data.description], [labels.attributes, data.attributes], [labels.expression, data.expression],
  ] as const;
  return <section aria-label={labels[data.kind]} className="space-y-2 text-xs break-words">
    <h4 className="font-medium text-text-primary">{labels[data.kind]}</h4>
    <dl className="space-y-2">
      {fields.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}>
        <dt className="text-text-muted">{label}</dt>
        <dd className="whitespace-pre-wrap text-text-secondary overflow-x-auto">{display(value)}</dd>
      </div>)}
    </dl>
    {data.assertionIds?.length ? <div>
      <p className="text-text-muted">{labels.assertions}</p>
      <ul className="space-y-1">{data.assertionIds.map(id => <li key={id}>
        {onSelectAssertion ? <button type="button" className="text-accent underline focus-visible:outline" onClick={() => onSelectAssertion(id)}>{id}</button> : id}
      </li>)}</ul>
    </div> : null}
  </section>;
}
