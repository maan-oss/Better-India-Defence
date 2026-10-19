import { AnimatedCounter } from './arc/animated-counter/animated-counter';

/**
 * A count that tweens to its new value rather than jumping: rail and bell badges, the more-areas count. A count
 * above `cap` reads as "99+", and the badge keeps its place in the layout while the number changes.
 */
export function Tally({ value, cap, className }: { value: number; cap?: number; className?: string }) {
  const over = cap !== undefined && value > cap;
  return (
    <span className={`tally ${className ?? ''}`}>
      <AnimatedCounter value={over ? cap : value} suffix={over ? '+' : ''} />
    </span>
  );
}
