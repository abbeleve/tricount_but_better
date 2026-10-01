export interface ChartPoint {
  x: number;
  y: number;
}

/** Monotone cubic Hermite interpolation through points with increasing x.
 * Shared tangents make the joins smooth; slope limiting keeps the curve
 * between the two measured values, including peaks, zeroes, and refunds.
 */
export function smoothChartPath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  const first = points[0];
  let path = `M${first.x},${first.y}`;
  if (points.length === 1) return path;

  const widths = points.slice(1).map((point, i) => point.x - points[i].x);
  const slopes = points.slice(1).map((point, i) => (point.y - points[i].y) / widths[i]);
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === points.length - 1) return slopes[slopes.length - 1];
    const before = slopes[i - 1], after = slopes[i];
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) return 0;
    const a = 2 * widths[i] + widths[i - 1];
    const b = widths[i] + 2 * widths[i - 1];
    return (a + b) / (a / before + b / after);
  });

  for (let i = 0; i < slopes.length; i++) {
    const slope = slopes[i];
    if (slope === 0) {
      tangents[i] = tangents[i + 1] = 0;
      continue;
    }
    const magnitude = Math.hypot(tangents[i] / slope, tangents[i + 1] / slope);
    if (magnitude > 3) {
      tangents[i] *= 3 / magnitude;
      tangents[i + 1] *= 3 / magnitude;
    }
  }

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1];
    const third = widths[i] / 3;
    path += ` C${from.x + third},${from.y + tangents[i] * third} ${to.x - third},${to.y - tangents[i + 1] * third} ${to.x},${to.y}`;
  }
  return path;
}
