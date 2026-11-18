// Tiny logger that also keeps the last lines in memory for the app's diagnostics panel.

const lines: string[] = [];

function write(level: string, scope: string, args: unknown[]) {
  const text = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${new Date().toISOString().slice(11, 19)} ${level} [${scope}] ${text}`;
  lines.push(line);
  if (lines.length > 400) lines.shift();
  (level === 'ERR' ? console.error : console.log)(line);
}

export function logger(scope: string) {
  return {
    info: (...a: unknown[]) => write('INF', scope, a),
    warn: (...a: unknown[]) => write('WRN', scope, a),
    error: (...a: unknown[]) => write('ERR', scope, a),
  };
}

export function recentLog() {
  return lines.slice();
}
