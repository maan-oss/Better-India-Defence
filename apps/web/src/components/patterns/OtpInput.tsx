/**
 * One-time code entry: one cell per character, paste-aware, with a spring caret and a shake on rejection.
 * Interaction pattern after Bencho's "One-time code" block (bencho.dev); implementation is original.
 */
import { useEffect, useRef } from 'react';
import { motion, useAnimationControls, useReducedMotion } from 'motion/react';
import './patterns.css';

export function OtpInput({ length = 8, value, onChange, onComplete, invalid, disabled, groupAt = 4, label = 'Setup code' }: { length?: number; value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; invalid?: boolean; disabled?: boolean; groupAt?: number; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const shake = useAnimationControls();
  const reduce = useReducedMotion();
  useEffect(() => {
    if (invalid && !reduce) void shake.start({ x: [0, -8, 8, -5, 5, -2, 0], transition: { duration: 0.42 } });
  }, [invalid, reduce, shake]);
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length);
  const chars = value.split('');
  const focusAt = Math.min(value.length, length - 1);
  return (
    <motion.div animate={shake} className={`otp ${invalid ? 'invalid' : ''}`} onClick={() => input.current?.focus()}>
      <input
        ref={input}
        aria-label={label}
        className="otp-input"
        value={value}
        disabled={disabled}
        autoFocus
        autoComplete="one-time-code"
        inputMode="text"
        spellCheck={false}
        onChange={(e) => {
          const v = clean(e.target.value);
          onChange(v);
          if (v.length === length) onComplete?.(v);
        }}
      />
      {Array.from({ length }, (_, i) => (
        <span key={i} className="otp-group-wrap">
          {i === groupAt && <span className="otp-sep" aria-hidden="true" />}
          <span className={`otp-cell ${chars[i] ? 'filled' : ''}`} aria-hidden="true">
            {chars[i] ? (
              <motion.span key={chars[i] + i} initial={reduce ? false : { y: 6, opacity: 0, filter: 'blur(3px)' }} animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }} transition={{ type: 'spring', visualDuration: 0.22, bounce: 0.2 }}>
                {chars[i]}
              </motion.span>
            ) : i === focusAt ? (
              <motion.span layoutId="otp-caret" className="otp-caret" transition={{ type: 'spring', visualDuration: 0.2, bounce: 0.1 }} />
            ) : null}
          </span>
        </span>
      ))}
    </motion.div>
  );
}
