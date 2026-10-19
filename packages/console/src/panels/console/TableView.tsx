/** console.table rendering from the serialized preview (first two levels). */
import type { SerializedValue, PropertyPreview } from '@bxconsole/protocol';
import { Inline } from './ObjectTree';

export function TableView({ value }: { value: SerializedValue }) {
  const rows = rowsOf(value);
  if (!rows) return null;
  const columns = Array.from(new Set(rows.flatMap((r) => r.cells.map((c) => c.name))));
  const hasValueColumn = rows.some((r) => r.value !== undefined);

  return (
    <table className="console-table">
      <thead>
        <tr>
          <th>(index)</th>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
          {hasValueColumn && <th>Value</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.index}>
            <td>{r.index}</td>
            {columns.map((c) => {
              const cell = r.cells.find((x) => x.name === c);
              return <td key={c}>{cell ? <Inline value={cell.value} mode="nested" /> : ''}</td>;
            })}
            {hasValueColumn && <td>{r.value ? <Inline value={r.value} mode="nested" /> : ''}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function rowsOf(value: SerializedValue): Array<{ index: string; cells: PropertyPreview[]; value?: SerializedValue }> | null {
  let entries: PropertyPreview[];
  if (value.t === 'array') entries = value.preview.map((v, i) => ({ name: String(i), value: v }));
  else if (value.t === 'object') entries = value.preview;
  else return null;

  return entries.map((e) => {
    if (e.value.t === 'object') return { index: e.name, cells: e.value.preview };
    if (e.value.t === 'array') return { index: e.name, cells: e.value.preview.map((v, i) => ({ name: String(i), value: v })) };
    return { index: e.name, cells: [], value: e.value };
  });
}
