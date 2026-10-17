import React from 'react';

/** Lightweight inline stroke-icon set (24×24, Feather-like). */
const P: Record<string, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></>,
  edu: <><path d="M2 8.5 12 4l10 4.5-10 4.5z"/><path d="M6 11v5c0 1.2 2.7 2.5 6 2.5s6-1.3 6-2.5v-5"/><path d="M22 8.5V15"/></>,
  intern: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></>,
  work: <><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M12 12v3"/></>,
  project: <><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7V6a2 2 0 0 1 2-2h4l2 2"/></>,
  badge: <><circle cx="12" cy="9" r="5"/><path d="M9 13.5 8 22l4-2 4 2-1-8.5"/></>,
  practice: <><path d="M12 21s-7-4.6-9.2-9A5.2 5.2 0 0 1 12 6.5 5.2 5.2 0 0 1 21.2 12C19 16.4 12 21 12 21z"/></>,
  award: <><circle cx="12" cy="9" r="6"/><path d="M8.5 14 7 22l5-3 5 3-1.5-8"/></>,
  paper: <><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M15 2v5h5"/><path d="M9 13h6M9 17h6"/></>,
  family: <><circle cx="8" cy="8" r="3.2"/><circle cx="17" cy="9" r="2.6"/><path d="M2.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><path d="M15 14.5c3 0 6.5 1.6 6.5 5.5"/></>,
  doc: <><path d="M7 2h7l5 5v15H7z"/><path d="M14 2v5h5"/><path d="M10 13h5M10 17h5"/></>,
  resume: <><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="9.5" cy="9" r="2"/><path d="M6.5 17c.6-2 1.7-3 3-3s2.4 1 3 3"/><path d="M15 8h2M15 12h3M15 16h3"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></>,
  mail: <><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/></>,
  inbox: <><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/></>,
  send: <><path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="M21 3 10 13"/></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></>,
  check: <><path d="m4 12.5 5 5L20 6.5"/></>,
  x: <><path d="M6 6l12 12M18 6 6 18"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  minus: <><path d="M5 12h14"/></>,
  chevron: <><path d="m6 9 6 6 6-6"/></>,
  chevronR: <><path d="m9 6 6 6-6 6"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></>,
  sun: <><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></>,
  moon: <><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></>,
  trash: <><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1.2"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></>,
  edit: <><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14.5 6.5 17.5 9.5"/></>,
  external: <><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></>,
  download: <><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></>,
  upload: <><path d="M12 21V9"/><path d="m7 13 5-5 5 5"/><path d="M4 4h16"/></>,
  filter: <><path d="M3 5h18l-7 8v6l-4 2v-8z"/></>,
  video: <><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 11 6-3.5v9l-6-3.5z"/></>,
  trophy: <><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3"/><path d="M10 14h4l.5 4h-5z"/><path d="M8 21h8"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></>,
  alert: <><path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17.2v.1"/></>,
  sparkles: <><path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/></>,
  settings: <><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5 7.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/></>,
  menu: <><path d="M3 6h18M3 12h18M3 18h18"/></>,
  more: <><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></>,
  phone: <><path d="M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L15 13l5 2v3a2 2 0 0 1-2.2 2A17 17 0 0 1 3 5.2 2 2 0 0 1 5 3z"/></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M10 21v-3h4v3"/></>,
  bell: <><path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.5 20a2 2 0 0 0 3 0"/></>,
  logo: <><path d="M4 17c0-4.4 3.6-8 8-8s8 3.6 8 8"/><circle cx="12" cy="6" r="3"/></>,
  star: <><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.1"/></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></>,
  palette: <><path d="M12 3a9 9 0 0 0 0 18c1.15 0 1.9-.78 1.9-1.72 0-.46-.18-.86-.47-1.16a1.72 1.72 0 0 1 1.25-2.92h2.1A5.22 5.22 0 0 0 22 9.98C22 6.02 17.52 3 12 3z"/><circle cx="7.7" cy="12.3" r="1.05"/><circle cx="10.3" cy="8.2" r="1.05"/><circle cx="15" cy="8.6" r="1.05"/></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, className, strokeWidth = 1.8 }: {
  name: string; size?: number; className?: string; strokeWidth?: number;
}) {
  const d = P[name] ?? P.doc;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">
      {d}
    </svg>
  );
}
