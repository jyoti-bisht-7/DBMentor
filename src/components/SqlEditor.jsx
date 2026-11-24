import { tokenizeSql } from "@/lib/dbmentor";

const KIND = {
  keyword: "text-violet",
  string: "text-mint",
  number: "text-mint",
  operator: "text-amber",
  plain: "text-ink",
};

export function SqlHighlight({ sql, gutter = true }) {
  const lines = (sql || "").split("\n");
  return (
    <pre className="overflow-auto p-4 font-mono text-[18px] leading-[1.7]">
      {lines.map((line, i) => (
        <div key={i}>
          {gutter && <span className="select-none text-dim">{String(i + 1).padStart(2, " ")}  </span>}
          {tokenizeSql(line).map((t, j) => (
            <span key={j} className={KIND[t.kind]}>
              {t.text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}

export function SqlEditor({ value, onChange, onRun, label = "SQL Query", running, error }) {
  return (
    <div className="flex min-h-0 flex-col bg-surface2/30">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-edge px-4">
        <span className="border-l-4 border-l-amber pl-3 font-mono text-[17.2px] font-semibold text-amber">{label}</span>
        <button
          type="button"
          onClick={onRun}
          className="landing-button inline-flex items-center gap-2 px-3 py-1.5 font-mono text-[17.2px] font-medium transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
        >
          <span className="text-[18.7px] leading-none">▶</span>
          {running ? "Running" : "Run"}
        </button>
      </div>
      <div className="relative min-h-[180px] flex-1">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <SqlHighlight sql={value} />
        </div>
        <textarea
          spellCheck="false"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-full resize-none bg-transparent p-4 pl-[4.75rem] font-mono text-[18px] leading-[1.7] text-transparent caret-cyan outline-none"
        />
      </div>
      {error && <div role="alert" className="shrink-0 border-t border-rose/30 bg-rose/10 px-4 py-2.5 font-mono text-[17.2px] leading-relaxed text-rose">Query error: {error}</div>}
    </div>
  );
}
