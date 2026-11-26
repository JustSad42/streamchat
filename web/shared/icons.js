// Inline SVG icons used by the app and overlays (no external icon font needed).

const svg = (body, vb = '0 0 24 24', extra = '') =>
  `<svg viewBox="${vb}" width="1em" height="1em" aria-hidden="true" ${extra}>${body}</svg>`;
const stroke = body => svg(body, '0 0 24 24', 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"');

export const ICONS = {
  settings: stroke('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  layers: stroke('<path d="m12.83 2.18 8.58 3.91a1 1 0 0 1 0 1.83l-8.58 3.9a2 2 0 0 1-1.66 0L2.6 7.92a1 1 0 0 1 0-1.83l8.58-3.9a2 2 0 0 1 1.66 0Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  reply: stroke('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'),
  trash: stroke('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  clock: stroke('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  ban: stroke('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
  user: stroke('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  send: stroke('<path d="M14.54 21.69a.5.5 0 0 0 .93-.02l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>'),
  smile: stroke('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>'),
  x: stroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  copy: stroke('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  refresh: stroke('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
  at: stroke('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
  zap: stroke('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'),
  check: stroke('<path d="M20 6 9 17l-5-5"/>'),
  external: stroke('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  plus: stroke('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  search: stroke('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  play: stroke('<polygon points="6 3 20 12 6 21 6 3"/>'),
  arrowDown: stroke('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  pause: stroke('<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'),
  heart: stroke('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'),
  star: stroke('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  gift: stroke('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>'),
  users: stroke('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  share: stroke('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>'),
  gem: stroke('<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>'),
  coins: stroke('<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/>'),
  megaphone: stroke('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
  radio: stroke('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/>'),
  sparkles: stroke('<path d="M9.94 14.06 4 20"/><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/>'),
  key: stroke('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  link: stroke('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  palette: stroke('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>'),
  bell: stroke('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  highlighter: stroke('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  terminal: stroke('<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>'),
  monitor: stroke('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  logout: stroke('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'),
  more: stroke('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  undo: stroke('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
  shield: stroke('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'),
  columns: stroke('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>'),
  eye: stroke('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: stroke('<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.97 0 8.9 3.28 9.94 6.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>'),
  type: stroke('<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>'),
  popout: stroke('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  activity: stroke('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'),
  keyboard: stroke('<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>'),
  note: stroke('<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>'),
  download: stroke('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  minus: stroke('<path d="M5 12h14"/>'),
  filter: stroke('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  sliders: stroke('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
  sprout: stroke('<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>'),
  broom: stroke('<path d="m13 11 9-9"/><path d="M14.6 12.6c.8.8.9 2.1.2 3L10 22l-8-8 6.4-4.8c.9-.7 2.2-.6 3 .2Z"/><path d="m6.8 10.4 6.8 6.8"/><path d="m5 17 1.4-1.4"/>'),
};

// Platform marks: simplified glyphs drawn for this app, colored per platform.
export const PLATFORM = {
  twitch: { name: 'Twitch', color: '#9146FF', icon: svg('<path fill="currentColor" d="M4.3 3 3 6.4v13.4h4.6V22h2.6l2.4-2.2h3.7L21 15V3H4.3Zm1.6 1.7h13.4v9.6l-2.9 2.8h-4.6l-2.4 2.3v-2.3H5.9V4.7Zm4.5 8.2h1.7V7.8h-1.7v5.1Zm4.6 0h1.7V7.8H15v5.1Z"/>') },
  kick: { name: 'Kick', color: '#53FC18', icon: svg('<path fill="currentColor" d="M3 3h6v4.5h2.2V5.2h2.3V3H21v6h-2.3v2.2h-2.2v1.6h2.2V15H21v6h-7.5v-2.2h-2.3v-2.3H9V21H3V3Z"/>') },
  tiktok: { name: 'TikTok', color: '#FE2C55', icon: svg('<path fill="currentColor" d="M16.6 2h-3.4v13.3a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9.1a6.4 6.4 0 1 0 5.4 6.3V8.6a8.2 8.2 0 0 0 4.4 1.3V6.5a4.8 4.8 0 0 1-4.4-4.5Z"/>') },
  youtube: { name: 'YouTube', color: '#FF0033', icon: svg('<path fill="currentColor" d="M7 4.5v15L20 12 7 4.5Z"/>') },
};

// Built-in badge art for badges that don't come with an image.
const badgeSvg = (bg, body) => svg(`<rect width="18" height="18" rx="4" fill="${bg}"/>${body}`, '0 0 18 18');
const BADGES = {
  broadcaster: badgeSvg('#e91916', '<path fill="#fff" d="M5 6h6v6H5zM11.5 8l2.5-1.5v5L11.5 10z"/>'),
  moderator: badgeSvg('#00ad03', '<path fill="#fff" d="M4 13.5 9.5 8l-1-1 1-1 3 3-1 1-1-1L5 14.5z M10 4.5l3.5 3.5"/><path stroke="#fff" stroke-width="1.6" d="m10.5 4 3.5 3.5"/>'),
  vip: badgeSvg('#e005b9', '<path fill="#fff" d="M5 6.5h8L9 13z"/>'),
  subscriber: badgeSvg('#8b5cf6', '<path fill="#fff" d="m9 3.8 1.6 3.3 3.6.5-2.6 2.5.6 3.6L9 12l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z"/>'),
  sub_gifter: badgeSvg('#f59e0b', '<path fill="#fff" d="M4 8h10v2H4zM5 10h8v4H5zM8.2 6h1.6v8H8.2z"/>'),
  og: badgeSvg('#1e88e5', '<text x="9" y="12.5" font-size="7.5" font-weight="800" text-anchor="middle" fill="#fff" font-family="Arial">OG</text>'),
  founder: badgeSvg('#d4a017', '<path fill="#fff" d="m4 12 1.5-6 3.5 3 3.5-3 1.5 6z"/>'),
  verified: badgeSvg('#1da1f2', '<path fill="none" stroke="#fff" stroke-width="2" d="m5 9 3 3 5-6"/>'),
  staff: badgeSvg('#111', '<path fill="#53fc18" d="M5 5h3v3h2V5h3v8h-3v-3H8v3H5z"/>'),
  fan: badgeSvg('#fe2c55', '<path fill="#fff" d="M9 14S4 11 4 7.6A2.6 2.6 0 0 1 9 6.4a2.6 2.6 0 0 1 5 1.2C14 11 9 14 9 14z"/>'),
};
export function badgeArt(id) {
  const key = id.replace(/^(kick|tiktok|youtube):/, '').split('/')[0];
  return BADGES[key] || null;
}
