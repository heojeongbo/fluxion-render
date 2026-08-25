/**
 * Pick an aesthetically pleasing step for an axis covering [min, max] with
 * ~`targetTicks` divisions. Based on the standard nice-number heuristic.
 */
export function niceStep(range: number, targetTicks: number): number {
  const rough = range / Math.max(1, targetTicks);
  const pow10 = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow10;
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 3) nice = 2;
  else if (norm < 7) nice = 5;
  else nice = 10;
  return nice * pow10;
}

/** Generate ticks at fixed `interval` boundaries spanning [min, max]. */
export function intervalTicks(min: number, max: number, interval: number): number[] {
  if (!isFinite(min) || !isFinite(max) || max <= min || interval <= 0) return [];
  const start = Math.ceil(min / interval) * interval;
  const out: number[] = [];
  for (let v = start; v <= max + interval * 1e-6; v += interval) {
    out.push(Number(v.toFixed(12)));
  }
  return out;
}

export function niceTicks(min: number, max: number, targetTicks = 6): number[] {
  if (!isFinite(min) || !isFinite(max) || max <= min) return [];
  const step = niceStep(max - min, targetTicks);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    out.push(Number(v.toFixed(12)));
  }
  return out;
}
