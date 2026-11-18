// Shared by the chat and alerts overlays: theme -> CSS variables, font loading, WebSocket with reconnect.

export const params = new URLSearchParams(location.search);
export const overlayKey = params.get('k') || '';

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(11,13,18,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

const SYSTEM_FONTS = new Set(['system-ui', 'Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Impact', 'Consolas', 'Comic Sans MS']);
let loadedFont = '';
export function loadFont(family) {
  if (!family || SYSTEM_FONTS.has(family) || loadedFont === family) return;
  loadedFont = family;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700;800;900&display=swap`;
  document.head.append(link);
}

export function applyTheme(t) {
  loadFont(t.fontFamily);
  const vars = {
    '--font': `"${t.fontFamily}", Inter, "Segoe UI", system-ui, sans-serif`,
    '--size': `${t.fontSize}px`,
    '--weight': t.fontWeight,
    '--text': t.textColor,
    '--bg': hexToRgba(t.bgColor, t.bgOpacity),
    '--radius': `${t.radius}px`,
    '--pad': `${t.padding}px`,
    '--gap': `${t.gap}px`,
    '--emote': `${1.6 * t.emoteScale}em`,
  };
  document.getElementById('theme-vars').textContent = `:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  const css = document.getElementById('custom-css');
  if (css) css.textContent = t.customCss || '';
}

export function connect(onMessage, onState) {
  let attempt = 0;
  let ws;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?role=overlay&k=${encodeURIComponent(overlayKey)}`);
    ws.onopen = () => { attempt = 0; onState?.('open'); };
    ws.onmessage = e => { if (e.data !== 'pong') onMessage(JSON.parse(e.data)); };
    ws.onclose = e => {
      onState?.(e.code === 4001 ? 'badkey' : 'closed');
      const delay = Math.min(15000, 1000 * 2 ** attempt++);
      setTimeout(open, e.code === 4001 ? 15000 : delay);
    };
  };
  open();
  setInterval(() => { if (ws?.readyState === 1) ws.send('ping'); }, 30000);
}

export function showNotice(text) {
  const n = document.getElementById('notice');
  if (!n) return;
  n.textContent = text || '';
  n.hidden = !text;
}
