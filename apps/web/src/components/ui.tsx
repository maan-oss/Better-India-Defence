/**
 * Interface primitives on Radix UI (radix-ui.com/primitives): keyboard navigation, focus management,
 * collision-aware positioning and ARIA come from the library; the look comes from styles/app.css.
 * Use these instead of hand-rolled menus, dialogs, tabs and button groups.
 */
import type { ReactNode } from 'react';
import { Dialog as D, DropdownMenu as DM, Tabs as T, ToggleGroup as TG, Tooltip as TT } from 'radix-ui';
import { Icon } from './Icons';

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
          <T.Trigger key={i.value} value={i.value} disabled={i.disabled} title={i.title} className="tab">
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

/** Dropdown menu. `trigger` must be a single button. */
export function Menu({ trigger, children, align = 'end', label }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; label?: string }) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} sideOffset={6} collisionPadding={8} className="menu" aria-label={label}>
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
export function MenuItem({ icon, children, onSelect, tone }: { icon?: ReactNode; children: ReactNode; onSelect: () => void; tone?: 'danger' }) {
  return (
    <DM.Item className={`m-item ${tone ?? ''}`} onSelect={onSelect}>
      {icon}
      <span className="grow">{children}</span>
    </DM.Item>
  );
}
export const MenuSeparator = () => <DM.Separator className="m-sep" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <DM.Label className="m-head">{children}</DM.Label>;

/** Modal dialog: focus trap, Escape and outside click close, focus returns to the opener. */
export function Dialog({ title, description, children, onClose, wide, footer }: { title: string; description?: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode }) {
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
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
