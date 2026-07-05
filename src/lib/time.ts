const pad2 = (n: number) => String(n).padStart(2, '0');
const pad3 = (n: number) => String(n).padStart(3, '0');

export function msToSrt(ms: number): string {
  ms = Math.max(0, Math.round(ms));
  const msPart = ms % 1000;
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(msPart)}`;
}

export function msToAss(ms: number): string {
  ms = Math.max(0, Math.round(ms));
  const cs = Math.floor(ms / 10);
  const totalSec = Math.floor(cs / 100);
  const c = cs % 100;
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(c)}`;
}

export function msToClock(ms: number): string {
  ms = Math.max(0, Math.round(ms));
  const msPart = ms % 1000;
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${pad2(m)}:${pad2(s)}.${pad3(msPart)}`;
}

export function parseTimeToMs(str: string): number | null {
  const t = str.trim().replace(',', '.');
  if (!t) return null;
  const parts = t.split(':').map((s) => s.trim());
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts.map(Number);
  else if (parts.length === 2) [m, s] = parts.map(Number);
  else if (parts.length === 1) s = Number(parts[0]);
  else return null;
  if ([h, m, s].some((n) => Number.isNaN(n))) return null;
  return Math.round(((h * 60 + m) * 60 + s) * 1000);
}
