function formatCell(value) {
  if (value === null || value === undefined) return { text: "NULL", isNull: true };
  if (value instanceof Date) return { text: value.toLocaleString(), isNull: false };
  if (typeof value === "object") {
    try {
      return { text: JSON.stringify(value), isNull: false };
    } catch {
      return { text: String(value), isNull: false };
    }
  }
  return { text: String(value), isNull: false };
}

export function ResultsGrid({ result }) {
  const columns = result?.columns || [];
  const rows = result?.rows || [];
  const hasResults = columns.length > 0;
  const elapsed = Number.isFinite(result?.ms) && result.ms > 0 ? `${result.ms} ms` : null;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-surface ring-1 ring-inset ring-edge/70">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-edge bg-surface2/50 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-lg bg-amber/15 text-amber" aria-hidden="true">
            <span className="grid grid-cols-2 gap-0.5">
              <span className="size-1.5 rounded-[1px] bg-current" />
              <span className="size-1.5 rounded-[1px] bg-current" />
              <span className="size-1.5 rounded-[1px] bg-current" />
              <span className="size-1.5 rounded-[1px] bg-current" />
            </span>
          </span>
          <div>
            <h2 className="font-mono text-[15px] font-semibold text-ink">Query results</h2>
            <p className="text-[12px] text-dim">
              {hasResults ? "Output from your SQL query" : "Run a query to display its results"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono text-[12px]">
          <span className="rounded-full bg-cyan/10 px-2.5 py-1 text-cyan ring-1 ring-inset ring-cyan/20">
            {rows.length} {rows.length === 1 ? "row" : "rows"}
          </span>
          {elapsed && (
            <span className="rounded-full bg-surface3/70 px-2.5 py-1 text-dim ring-1 ring-inset ring-edge">
              {elapsed}
            </span>
          )}
        </div>
      </header>

      {hasResults ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-max border-separate border-spacing-0 text-left font-mono text-[13px]">
            <thead className="sticky top-0 z-10">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-20 border-b border-edge bg-surface3 px-3 py-3 text-right text-[11px] font-medium text-dim"
                  aria-label="Row number"
                >
                  #
                </th>
                {columns.map((column, index) => (
                  <th
                    key={`${column}-${index}`}
                    scope="col"
                    className="whitespace-nowrap border-b border-edge bg-surface3 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-cyan"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="group">
                  <td className="sticky left-0 border-b border-edge/60 bg-surface2 px-3 py-2.5 text-right tabular-nums text-dim group-hover:bg-surface3">
                    {rowIndex + 1}
                  </td>
                  {columns.map((column, columnIndex) => {
                    const cell = formatCell(row?.[columnIndex]);
                    const numeric = typeof row?.[columnIndex] === "number" || typeof row?.[columnIndex] === "bigint";
                    return (
                      <td
                        key={`${column}-${columnIndex}`}
                        title={cell.text}
                        className={`max-w-[360px] whitespace-nowrap border-b border-edge/60 px-4 py-2.5 text-ink transition-colors group-hover:bg-surface3/60 ${
                          numeric ? "text-right tabular-nums" : "text-left"
                        } ${cell.isNull ? "italic text-dim" : ""}`}
                      >
                        <span className="inline-block max-w-[320px] truncate align-bottom">{cell.text}</span>
                      </td>
                    );
                  })}
                </tr>
              )) : (
                <tr>
                  <td colSpan={columns.length + 1} className="px-4 py-12 text-center">
                    <span className="font-sans text-[14px] text-mute">The query returned no rows.</span>
                    <span className="mt-1 block font-sans text-[12px] text-dim">Try changing the filters or running another query.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid min-h-[190px] flex-1 place-items-center px-6 py-8 text-center">
          <div>
            <span className="mx-auto grid size-11 place-items-center rounded-xl bg-surface3/70 text-cyan ring-1 ring-inset ring-edge">
              <span className="grid grid-cols-2 gap-1">
                <span className="size-2 rounded-sm bg-current/80" />
                <span className="size-2 rounded-sm bg-current/50" />
                <span className="size-2 rounded-sm bg-current/50" />
                <span className="size-2 rounded-sm bg-current/80" />
              </span>
            </span>
            <p className="mt-3 text-[14px] font-medium text-mute">Your results will appear here</p>
            <p className="mt-1 text-[12px] text-dim">Write a SELECT query above and press Run.</p>
          </div>
        </div>
      )}
    </section>
  );
}
