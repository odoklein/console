// Five-field cron expressions (minute hour day-of-month month day-of-week), evaluated in UTC,
// as the CRM's /api/instance/cron catalog publishes them. Supports *, n, a-b, */s, a-b/s and lists.
// Day-of-month and day-of-week: when both are restricted, either one matching is enough (cron's rule).

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function field(spec: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let from = lo;
    let to = hi;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(Number);
      from = a!;
      to = b ?? (m[2] ? hi : a!);
    }
    if (from < lo || to > hi || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export type CronSpec = { sets: Set<number>[]; domStar: boolean; dowStar: boolean };

export function parseCron(expr: string): CronSpec | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = field(parts[i]!, RANGES[i]!);
    if (!s) return null;
    sets.push(s);
  }
  if (sets[4]!.has(7)) sets[4]!.add(0); // 7 = Sunday too
  return { sets, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

export function cronMatches(expr: string | CronSpec, d: Date): boolean {
  const spec = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!spec) return false;
  const [min, hour, dom, mon, dow] = spec.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(d.getUTCMinutes()) || !hour.has(d.getUTCHours()) || !mon.has(d.getUTCMonth() + 1)) return false;
  const domOk = dom.has(d.getUTCDate());
  const dowOk = dow.has(d.getUTCDay());
  if (spec.domStar || spec.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}
