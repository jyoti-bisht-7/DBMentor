import { TONE_BADGE, TONE_RING, TONE_TEXT } from "./tone";

export function PlanSteps({ steps, active, onSelect, dense = true }) {
  return (
    <div className="p-3">
      {steps.map((s, i) => (
        <div key={i}>
          {i > 0 && <div className="ml-2.5 h-4 border-l border-edge2" />}
          <button
            type="button"
            onClick={() => onSelect?.(i)}
            style={{ animationDelay: `${i * 0.12}s` }}
            className={`animate-step-in flex w-full items-center gap-2.5 rounded-[9px] px-1.5 py-1 text-left transition-colors ${
              active === i ? "bg-surface3/70" : "hover:bg-surface3/40"
            }`}
          >
            <div
              className={`grid size-5 shrink-0 place-items-center rounded-full bg-surface3 font-mono text-[9px] ring-1 ring-inset ${TONE_TEXT[s.tone]} ${TONE_RING[s.tone]}`}
            >
              {i + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12px] text-ink">
                {s.node} <span className="text-dim">{s.target}</span>
              </div>
              <div className="truncate font-mono text-[10px] text-dim">{s.detail}</div>
              {!dense && <p className="mt-1 text-[12px] leading-relaxed text-mute">{s.story}</p>}
            </div>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset ${TONE_BADGE[s.tone]}`}
            >
              {s.rows} rows
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
