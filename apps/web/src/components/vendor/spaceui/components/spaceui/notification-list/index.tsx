// @ts-nocheck — vendored third-party source (MIT, see LICENSE in this folder).

import * as React from 'react'
import { RotateCcw, ArrowUpRight } from 'lucide-react'
import { motion, type Transition } from 'motion/react'

export interface NotificationItem {
  id: string
  title: string
  subtitle: string
  time: string
  count?: number
  /** Adapted for STRATA: a status bar on the card's leading edge. */
  tone?: 'critical' | 'high' | 'medium' | 'low'
}

const transition: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 26,
}

const getCardVariants = (i: number) => ({
  collapsed: {
    marginTop: i === 0 ? 0 : -44,
    scaleX: 1 - i * 0.05,
  },
  expanded: {
    marginTop: i === 0 ? 0 : 4,
    scaleX: 1,
  },
})

const textSwitchTransition: Transition = {
  duration: 0.22,
  ease: 'easeInOut',
}

const notificationTextVariants = {
  collapsed: { opacity: 1, y: 0, pointerEvents: 'auto' },
  expanded: { opacity: 0, y: -16, pointerEvents: 'none' },
}

const viewAllTextVariants = {
  collapsed: { opacity: 0, y: 16, pointerEvents: 'none' },
  expanded: { opacity: 1, y: 0, pointerEvents: 'auto' },
}

/**
 * Adapted from Space UI (MIT): takes real items instead of the demo list, a label, and callbacks; colours
 * come from the console theme. Hover (or focus) fans the stack out.
 */
function NotificationList({ items: notifications, label = 'Notifications', onItem, onViewAll, className }: { items: NotificationItem[]; label?: string; onItem?: (id: string) => void; onViewAll?: () => void; className?: string }) {
  if (!notifications.length) return null
  return (
    <motion.div
      className={`bg-background p-2.5 rounded-2xl w-full space-y-2.5 ${className ?? ''}`}
      initial="collapsed"
      whileHover="expanded"
      whileFocus="expanded"
    >
      <div>
        {notifications.map((notification, i) => (
          <motion.div
            key={notification.id}
            className={`bg-card rounded-xl pl-4 pr-3 py-2 shadow-sm hover:shadow-lg transition-shadow duration-200 relative cursor-pointer nl-card nl-${notification.tone ?? 'low'}`}
            onClick={() => onItem?.(notification.id)}
            variants={getCardVariants(i)}
            transition={transition}
            style={{
              zIndex: notifications.length - i,
            }}
          >
            <div className="flex justify-between items-center">
              <h1 className="text-sm font-medium truncate">{notification.title}</h1>
              {notification.count && (
                <div className="flex items-center text-xs gap-0.5 font-medium text-muted-foreground">
                  <RotateCcw className="size-3" />
                  <span>{notification.count}</span>
                </div>
              )}
            </div>
            <div className="text-xs text-muted-foreground font-medium truncate">
              <span>{notification.time}</span>
              &nbsp;•&nbsp;
              <span>{notification.subtitle}</span>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="size-5 rounded-full bg-accent text-foreground text-xs flex items-center justify-center font-medium">
          {notifications.length}
        </div>
        <span className="grid">
          <motion.span
            className="text-sm font-medium text-muted-foreground row-start-1 col-start-1"
            variants={notificationTextVariants}
            transition={textSwitchTransition}
          >
            {label}
          </motion.span>
          <motion.span
            className="text-sm font-medium text-foreground flex items-center gap-1 cursor-pointer select-none row-start-1 col-start-1"
            onClick={onViewAll}
            variants={viewAllTextVariants}
            transition={textSwitchTransition}
          >
            View all <ArrowUpRight className="size-4" />
          </motion.span>
        </span>
      </div>
    </motion.div>
  )
}

export { NotificationList }
