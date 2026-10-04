import { useRef, useState, type ReactNode } from 'react';

/** Fixed-row-height virtualised list: renders only rows in view (event lists can hold thousands of rows). */
export function VirtualList<T>({ items, rowHeight, render, empty, overscan = 6 }: { items: T[]; rowHeight: number; render: (item: T, index: number) => ReactNode; empty?: string; overscan?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scroll + height) / rowHeight) + overscan);
  if (!items.length) return <div className="empty">{empty ?? 'Nothing to show.'}</div>;
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el && el.clientHeight !== height) setHeight(el.clientHeight || 600);
      }}
      className="scroll"
      style={{ height: '100%', position: 'relative' }}
      onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        {items.slice(start, end).map((it, i) => (
          <div key={start + i} style={{ position: 'absolute', top: (start + i) * rowHeight, left: 0, right: 0 }}>
            {render(it, start + i)}
          </div>
        ))}
      </div>
    </div>
  );
}
