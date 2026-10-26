/**
 * Interface primitives on Radix UI (radix-ui.com/primitives): keyboard navigation, focus management,
 * collision-aware positioning and ARIA come from the library; the look comes from styles/app.css.
 * Use these instead of hand-rolled menus, dialogs, tabs and button groups.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog as D, Tabs as T, ToggleGroup as TG, Tooltip as TT } from 'radix-ui';
import { Icon } from './Icons';
import ArcSegmented from './arc/segmented-control/segmented-control';

type Option<V> = V | { value: V; label: ReactNode; title?: string; disabled?: boolean };
interface Item<V> {
  value: V;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}
function items<V extends string | number>(opts: readonly Option<V>[]): Item<V>[] {
  return opts.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
}

/** Mutually exclusive choice (a radio group drawn as a segmented control). */
export function Segmented<V extends string | number>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  fill,
  className = '',
}: {
  value: V | null | undefined;
  onChange: (v: V) => void;
  options: readonly Option<V>[];
  label: string;
  size?: 'sm' | 'md';
  fill?: boolean;
  className?: string;
}) {
  const list = items(options);
  // Arc's segmented control (gliding selection) whenever the options are plain labels; Radix toggle group otherwise.
  if (list.every((i) => typeof i.label === 'string' && !i.disabled && !i.title))
    return (
      <ArcSegmented
        className={`arc-seg ${size} ${fill ? 'fill' : ''} ${className}`}
        label={label}
        value={value === null || value === undefined ? '' : String(value)}
        options={list.map((i) => ({ value: String(i.value), label: i.label as string }))}
        onValueChange={(v: string) => {
          const it = list.find((i) => String(i.value) === v);
          if (it) onChange(it.value);
        }}
      />
    );
  return (
    <TG.Root
      type="single"
      className={`seg ${size} ${fill ? 'fill' : ''} ${className}`}
      aria-label={label}
      value={value === null || value === undefined ? '' : String(value)}
      onValueChange={(v) => {
        const it = list.find((i) => String(i.value) === v);
        if (it) onChange(it.value);
      }}
    >
      {list.map((i) => (
        <TG.Item key={String(i.value)} value={String(i.value)} title={i.title} disabled={i.disabled} aria-label={i.title}>
          {i.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}

/** Switches between views of one page (underlined tab strip). Content is rendered by the caller. */
export function Tabs<V extends string>({ value, onChange, options, label, className = '' }: { value: V; onChange: (v: V) => void; options: readonly Option<V>[]; label: string; className?: string }) {
  const list = items(options);
  return (
    <T.Root value={value} onValueChange={(v) => onChange(v as V)} activationMode="manual" className={`tabs ${className}`}>
      <T.List aria-label={label} className="tabs-list">
        {list.map((i) => (
          <T.Trigger key={i.value} value={i.value} disabled={i.disabled} title={i.title} aria-controls={undefined} className="tab">
            {i.label}
          </T.Trigger>
        ))}
      </T.List>
    </T.Root>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TT.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </TT.Provider>
  );
}

/** Hover/focus hint. `children` must be a single focusable element. */
export function Tip({ content, children, side = 'top', disabled }: { content: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; disabled?: boolean }) {
  if (disabled || !content) return <>{children}</>;
  return (
    <TT.Root>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content side={side} sideOffset={6} collisionPadding={8} className="tip-pop">
          {content}
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}

/** How long a dialog takes to leave (the exit keyframes in app.css). The parent unmounts it after this, so the exit plays. */
const DIALOG_EXIT_MS = 160;

/** Modal dialog: focus trap, Escape and outside click close, focus returns to the opener. Closing plays the exit first,
 *  and onClose runs when it has finished, so a parent that unmounts the dialog on close does not cut the exit short. */
export function Dialog({ title, description, children, onClose, wide, footer }: { title: string; description?: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(onClose, DIALOG_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onClose]);
  return (
    <D.Root open={open} onOpenChange={(o) => !o && setOpen(false)}>
      <D.Portal>
        <D.Overlay className="modal-back" />
        <D.Content className={`modal ${wide ? 'wide' : ''}`} {...(description ? {} : { 'aria-describedby': undefined })}>
          <header className="modal-h">
            <div className="grow">
              <D.Title className="modal-title">{title}</D.Title>
              {description && <D.Description className="modal-desc">{description}</D.Description>}
            </div>
            <D.Close className="btn icon ghost small" aria-label="Close">
              <Icon.Close />
            </D.Close>
          </header>
          <div className="modal-body scroll">{children}</div>
          {footer && <footer className="modal-f">{footer}</footer>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
