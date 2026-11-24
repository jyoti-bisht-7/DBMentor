import { Link } from "@tanstack/react-router";

const links = [
  { to: "/workspace", label: "Schema" },
  { to: "/query-lab", label: "Query Lab" },
  { to: "/nl-query", label: "NL → Query" },
];

export function TopBar() {
  return (
    <div className="flex h-14 items-center gap-3 border-b border-edge bg-surface2/90 px-3 backdrop-blur-md sm:gap-4 sm:px-5">
      <Link to="/" className="flex items-center gap-2.5">
        <div className="grid size-7 place-items-center rounded-[9px] bg-amber ring-1 ring-inset ring-ink/30">
          <span className="font-mono text-[16.9px] font-semibold text-cyanink">◍</span>
        </div>
        <span className="font-mono text-[16.9px] font-semibold tracking-tight text-ink">DBMentor</span>
      </Link>
      <nav className="flex min-w-0 items-center gap-2 overflow-x-auto border-l border-edge pl-3 font-mono text-[14.3px] text-mute sm:gap-5 sm:pl-4">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="landing-button inline-flex shrink-0 items-center whitespace-nowrap px-3 py-1.5 text-[14.3px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
