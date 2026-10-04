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
  Logo: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ece6dc" strokeWidth="1.5">
      <path d="M3 18h18" />
      <path d="M5 13.5h14" opacity="0.75" />
      <path d="M7 9h10" opacity="0.5" />
      <path d="M9 4.5h6" opacity="0.3" />
    </svg>
  ),
};
