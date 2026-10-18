import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

/**
 * Text that cross-fades when its value changes. The label of a control changes state (slide to confirm, then "sent"),
 * and the old and new words soften into each other rather than switching. Built on the animation library the app
 * already uses, so no third-party component has to inject its own stylesheet, which the Content Security Policy refuses.
 */
export function CrossfadeText({ children }: { children: string }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      <motion.span
        key={children}
        initial={reduce ? false : { opacity: 0, filter: 'blur(2px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, filter: 'blur(2px)' }}
        transition={{ duration: reduce ? 0 : 0.2 }}
        style={{ display: 'inline-block' }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}
