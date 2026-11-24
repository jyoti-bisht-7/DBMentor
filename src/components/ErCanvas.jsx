import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TONE_CARD, TONE_CARD_TEXT, TONE_HEADER, TONE_RING, TONE_STROKE, TONE_TEXT } from "./tone";

const CARD_WIDTH = 240;
const CARD_PADDING = 48;
const COLUMN_GAP = 144;
const ROW_GAP = 120;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

function createCanvasLayout(tables, availableWidth) {
  const columnCount = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(tables.length))));
  const rowCount = Math.ceil(tables.length / columnCount);
  const rowHeights = Array(rowCount).fill(0);
  const minWidth = CARD_PADDING * 2 + columnCount * CARD_WIDTH + (columnCount - 1) * COLUMN_GAP;
  const width = Math.max(minWidth, availableWidth);

  tables.forEach((table, index) => {
    const row = Math.floor(index / columnCount);
    rowHeights[row] = Math.max(rowHeights[row], 48 + table.columns.length * 34);
  });

  const positions = {};
  let top = CARD_PADDING;
  for (let row = 0; row < rowCount; row += 1) {
    const rowTables = tables.slice(row * columnCount, (row + 1) * columnCount);
    rowTables.forEach((table, column) => {
      positions[table.name] = {
        x:
          columnCount === 1
            ? (width - CARD_WIDTH) / 2
            : CARD_PADDING + column * ((width - CARD_PADDING * 2 - CARD_WIDTH) / (columnCount - 1)),
        y: top,
      };
    });
    top += rowHeights[row] + ROW_GAP;
  }

  return {
    positions,
    width,
    height: Math.max(CARD_PADDING * 2, top - ROW_GAP + CARD_PADDING),
  };
}

function TableCard({ table, position, zoom, onMove, onHover, active }) {
  const drag = useRef(null);
  const keyLabels = ["pk", "fk"]
    .filter((key) => table.columns.some((column) => column.key === key))
    .map((key) => key.toUpperCase())
    .join("·") || "—";

  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: position.x,
      y: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    onMove(table.name, {
      x: drag.current.x + (event.clientX - drag.current.startX) / zoom,
      y: drag.current.y + (event.clientY - drag.current.startY) / zoom,
    });
  };

  const handlePointerUp = (event) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event) => {
    const distance = event.shiftKey ? 48 : 24;
    const movement = {
      ArrowDown: { x: 0, y: distance },
      ArrowLeft: { x: -distance, y: 0 },
      ArrowRight: { x: distance, y: 0 },
      ArrowUp: { x: 0, y: -distance },
    }[event.key];
    if (!movement) return;
    event.preventDefault();
    onMove(table.name, { x: position.x + movement.x, y: position.y + movement.y });
  };

  return (
    <div
      data-table={table.name}
      role="group"
      tabIndex={0}
      aria-label={`Move ${table.name} table with drag or arrow keys`}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseEnter={() => onHover?.(table.name)}
      onMouseLeave={() => onHover?.(null)}
      className={`animate-card-in absolute w-[240px] select-none overflow-hidden rounded-[12px] shadow-[0_12px_30px_rgba(0,0,0,0.2)] ring-1 ring-inset touch-none cursor-grab active:cursor-grabbing ${
        TONE_CARD[table.tone] || TONE_CARD.cyan
      } ${active ? TONE_RING[table.tone] : "ring-white/35"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber`}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      <div
        className={`flex items-center justify-between border-b border-black/15 px-4 py-2.5 ${TONE_HEADER[table.tone] || TONE_HEADER.cyan}`}
      >
        <span className="truncate font-mono text-[18.7px] font-semibold">{table.name}</span>
        <span className="ml-2 shrink-0 font-mono text-[14px] opacity-80">
          {keyLabels}
        </span>
      </div>
      <div className="p-1">
        {table.columns.map((column) => (
          <div
            key={column.name}
            className="flex items-center gap-2.5 border-b border-black/15 px-2.5 py-1.5 font-mono text-[17.2px] last:border-b-0"
          >
            <span className={column.key ? TONE_TEXT[table.tone] : TONE_CARD_TEXT[table.tone]}>
              {column.key === "pk" ? "◆" : column.key === "fk" ? "◇" : "·"}
            </span>
            <span className={TONE_CARD_TEXT[table.tone]}>{column.name}</span>
            <span className={`ml-auto ${TONE_CARD_TEXT[table.tone]} opacity-75`}>{column.type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErCanvas({ schema, hovered, onHover }) {
  const stageRef = useRef(null);
  const viewportRef = useRef(null);
  const hasMovedTable = useRef(false);
  const previousTables = useRef(schema.tables);
  const [lines, setLines] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [availableWidth, setAvailableWidth] = useState(0);
  const layout = useMemo(
    () => createCanvasLayout(schema.tables, availableWidth),
    [schema.tables, availableWidth],
  );
  const [positions, setPositions] = useState(layout.positions);
  const [canvasSize, setCanvasSize] = useState(layout);

  useEffect(() => {
    const tablesChanged = previousTables.current !== schema.tables;
    previousTables.current = schema.tables;
    if (tablesChanged) hasMovedTable.current = false;
    if (tablesChanged || !hasMovedTable.current) {
      setPositions(layout.positions);
      setCanvasSize(layout);
    }
  }, [layout, schema.tables]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const updateWidth = () => setAvailableWidth(viewport.clientWidth);
    updateWidth();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const tables = new Map(
      Array.from(stage.querySelectorAll("[data-table]")).map((table) => [table.dataset.table, table]),
    );
    const nextLines = [];
    let right = CARD_PADDING;
    let bottom = CARD_PADDING;
    for (const table of tables.values()) {
      right = Math.max(right, table.offsetLeft + table.offsetWidth + CARD_PADDING);
      bottom = Math.max(bottom, table.offsetTop + table.offsetHeight + CARD_PADDING);
    }
    setCanvasSize((current) => {
      const width = Math.max(layout.width, right);
      const height = Math.max(layout.height, bottom);
      return current.width === width && current.height === height ? current : { width, height };
    });
    for (const edge of schema.edges) {
      const from = tables.get(edge.from);
      const to = tables.get(edge.to);
      if (!from || !to) continue;
      nextLines.push({
        ...edge,
        x1: from.offsetLeft + from.offsetWidth / 2,
        y1: from.offsetTop + from.offsetHeight / 2,
        x2: to.offsetLeft + to.offsetWidth / 2,
        y2: to.offsetTop + to.offsetHeight / 2,
      });
    }
    setLines(nextLines);
  }, [layout, schema.edges]);

  useLayoutEffect(measure, [measure, positions, zoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    stage.querySelectorAll("[data-table]").forEach((table) => observer.observe(table));
    return () => observer.disconnect();
  }, [measure, schema]);

  const moveTable = (name, nextPosition) => {
    hasMovedTable.current = true;
    setPositions((current) => ({
      ...current,
      [name]: {
        x: Math.max(CARD_PADDING, nextPosition.x),
        y: Math.max(CARD_PADDING, nextPosition.y),
      },
    }));
  };

  const changeZoom = (amount) => {
    setZoom((current) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number((current + amount).toFixed(2)))));
  };

  return (
    <div className="flex min-h-[70vh] flex-col bg-surface">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-edge bg-surface2/30 px-4">
        <span className="font-mono text-[14px] text-dim">Drag tables to rearrange · Scroll to pan</span>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[14px]">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => changeZoom(-ZOOM_STEP)}
            className="landing-button size-9 font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            −
          </button>
          <span className="min-w-[48px] text-center text-ink" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => changeZoom(ZOOM_STEP)}
            className="landing-button size-9 font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="landing-button h-9 px-3 font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
          >
            Reset
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="dotgrid min-h-[calc(70vh-3rem)] overflow-x-auto overscroll-x-contain bg-surface"
      >
        <div
          className="relative"
          style={{ width: `${canvasSize.width * zoom}px`, height: `${canvasSize.height * zoom}px` }}
        >
          <div
            ref={stageRef}
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: `${canvasSize.width}px`,
              height: `${canvasSize.height}px`,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              className="pointer-events-none absolute inset-0 size-full"
              width={canvasSize.width}
              height={canvasSize.height}
              aria-hidden="true"
            >
              {lines.map((line, index) => {
                const lit = !hovered || hovered === line.from || hovered === line.to;
                return (
                  <g key={index} opacity={lit ? 1 : 0.2}>
                    <line
                      x1={line.x1}
                      y1={line.y1}
                      x2={line.x2}
                      y2={line.y2}
                      stroke={TONE_STROKE[line.tone]}
                      strokeWidth="2"
                      strokeOpacity="0.7"
                    />
                    <circle cx={line.x1} cy={line.y1} r="4" fill={TONE_STROKE[line.tone]} />
                    <circle cx={line.x2} cy={line.y2} r="4" fill={TONE_STROKE[line.tone]} />
                    <text
                      x={(line.x1 + line.x2) / 2}
                      y={(line.y1 + line.y2) / 2 - 8}
                      textAnchor="middle"
                      fill={TONE_STROKE[line.tone]}
                      className="font-mono"
                      fontSize="14"
                    >
                      {line.label}
                    </text>
                  </g>
                );
              })}
            </svg>
            {schema.tables.map((table) => (
              <TableCard
                key={table.name}
                table={table}
                position={positions[table.name] || layout.positions[table.name]}
                zoom={zoom}
                onMove={moveTable}
                onHover={onHover}
                active={hovered === table.name}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
