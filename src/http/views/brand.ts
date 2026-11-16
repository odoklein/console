// The Console's identity: the mark (a "C" with three rays, redrawn as paths from the supplied logo)
// and the small icons of the navigation. Everything is inline SVG in currentColor, so the mark is
// white on the ink sidebar, ink on paper, and crisp at any size. No image files, no icon font.

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';

// Geometry of the supplied logo (700 x 650 canvas): circle centred at (330, 325); the "C" is a ring
// from r = 147 to r = 245 opening on the right between y = 240 and y = 410; three rays (68 thick)
// run from r = 245 in to a concave end on the circle r = 118, at 135°, 180° and 225°.
const RAY = 'M85 291H217A118 118 0 0 0 217 359H85Z';
const MARK_PATHS = `
  <path d="M330 80A245 245 0 0 1 559.8 240H449.9A147 147 0 0 0 330 178Z"/>
  <path d="M330 570A245 245 0 0 0 559.8 410H449.9A147 147 0 0 1 330 472Z"/>
  <path d="${RAY}"/>
  <path d="${RAY}" transform="rotate(45 330 325)"/>
  <path d="${RAY}" transform="rotate(-45 330 325)"/>`;

const VIEWBOX = '75 70 510 510';

/** The mark, in the current text colour. */
export function mark(size = 24, label?: string): Html {
  return html`<svg class="mark" width="${size}" height="${size}" viewBox="${VIEWBOX}" fill="currentColor" xmlns="http://www.w3.org/2000/svg" ${label ? html`role="img" aria-label="${label}"` : html`aria-hidden="true"`}>${raw(MARK_PATHS)}</svg>`;
}

/** Favicon: white mark on the solar tile. */
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#FF5A1F"/><svg x="10" y="10" width="44" height="44" viewBox="${VIEWBOX}" fill="#fff">${MARK_PATHS}</svg></svg>`,
)}`;

const ICONS: Record<string, string> = {
  fleet: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  new: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  alerts: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  support: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z"/><path d="M8.5 10.5h7M8.5 13.8h4.5"/>',
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.4A7.5 7.5 0 1 1 20 11.5Z"/>',
  clip: '<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  platform: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  audit: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5M15 12H3"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 18): Html {
  return html`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONS[name] ?? '')}</svg>`;
}

/** Initials tile for an agency (stable colour from its slug). */
export function avatar(name: string, slug: string): Html {
  const initials = name.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return html`<span class="avatar avatar-${h % 6}" aria-hidden="true">${initials}</span>`;
}
