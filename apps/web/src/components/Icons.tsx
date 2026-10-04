import { Mark } from '../brand/Mark';

const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Icon = {
  Ops: () => (
    <svg {...p}>
      <path d="M3 17l6-3 6 3 6-3" />
      <path d="M3 12l6-3 6 3 6-3" />
      <path d="M3 7l6-3 6 3 6-3" />
    </svg>
  ),
  Incidents: () => (
    <svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  ),
  Sensors: () => (
    <svg {...p}>
      <path d="M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7" />
      <circle cx="12" cy="12" r="1.2" />
    </svg>
  ),
  Recon: () => (
    <svg {...p}>
      <path d="M4 20V9l8-5 8 5v11" />
      <path d="M4 14h16M9 20v-6M15 20v-6" />
    </svg>
  ),
  Evidence: () => (
    <svg {...p}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5M9 13h7M9 17h5" />
    </svg>
  ),
  Sim: () => (
    <svg {...p}>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />
      <path d="M7.5 15h9" />
    </svg>
  ),
  Health: () => (
    <svg {...p}>
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </svg>
  ),
  Audit: () => (
    <svg {...p}>
      <path d="M8 4h11v16H8z" />
      <path d="M5 7v13h11M11 8h5M11 12h5M11 16h3" />
    </svg>
  ),
  Admin: () => (
    <svg {...p}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5" />
    </svg>
  ),
  Forensics: () => (
    <svg {...p}>
      <rect x="3" y="5" width="14" height="11" rx="1" />
      <circle cx="16.5" cy="15.5" r="3.5" />
      <path d="M19 18l2.5 2.5M6 9h5M6 12h3" />
    </svg>
  ),
  Identity: () => (
    <svg {...p}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7.5 17a4.5 4.5 0 0 1 9 0" />
    </svg>
  ),
  Command: () => (
    <svg {...p}>
      <path d="M12 3l8 4v5c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V7z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  Camera: () => (
    <svg {...p}>
      <path d="M3 8h11l3-2v10l-3-2H3z" />
      <path d="M7 14v5M5 19h4" />
    </svg>
  ),
  Upload: () => (
    <svg {...p}>
      <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  ),
  Search: () => (
    <svg {...p} width={15} height={15}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </svg>
  ),
  Play: () => (
    <svg {...p} width={14} height={14}>
      <path d="M7 5l11 7-11 7z" fill="currentColor" />
    </svg>
  ),
  Pause: () => (
    <svg {...p} width={14} height={14}>
      <path d="M8 5v14M16 5v14" strokeWidth={2.4} />
    </svg>
  ),
  Reverse: () => (
    <svg {...p} width={14} height={14}>
      <path d="M17 5L6 12l11 7z" fill="currentColor" />
    </svg>
  ),
  StepB: () => (
    <svg {...p} width={14} height={14}>
      <path d="M17 6l-8 6 8 6zM7 6v12" />
    </svg>
  ),
  StepF: () => (
    <svg {...p} width={14} height={14}>
      <path d="M7 6l8 6-8 6zM17 6v12" />
    </svg>
  ),
  Close: () => (
    <svg {...p} width={14} height={14}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  Ask: () => (
    <svg {...p} width={16} height={16}>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M9 9h6M9 12h4" />
    </svg>
  ),
  Logo: ({ size = 16 }: { size?: number } = {}) => <Mark size={size} variant="line" />,
  Chevron: () => (
    <svg {...p} width={16} height={16}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  Bell: () => (
    <svg {...p} width={16} height={16}>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  ),
  BellOff: () => (
    <svg {...p} width={16} height={16}>
      <path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8" />
      <path d="M10 20.5a2 2 0 0 0 4 0M4 4l16 16" />
    </svg>
  ),
  Moon: () => (
    <svg {...p} width={16} height={16}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  ),
  Sun: () => (
    <svg {...p} width={16} height={16}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </svg>
  ),
  SignOut: () => (
    <svg {...p} width={16} height={16}>
      <path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h11" />
    </svg>
  ),
  Field: () => (
    <svg {...p}>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M10.5 18.5h3" />
      <path d="M12 7.5l2.5 4h-5z" />
    </svg>
  ),
  Grid: () => (
    <svg {...p} width={16} height={16}>
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </svg>
  ),
  Expand: () => (
    <svg {...p} width={16} height={16}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  ),
  Check: () => (
    <svg {...p} width={16} height={16}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  Alert: () => (
    <svg {...p} width={16} height={16}>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </svg>
  ),
  Target: () => (
    <svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
      <circle cx="12" cy="12" r="1.2" />
    </svg>
  ),
};
