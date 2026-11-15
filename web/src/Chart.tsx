import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { fmtValue, metricLabel } from "./format";

export interface SeriesData {
  t: number[]; // мс
  v: (number | null)[];
  min?: (number | null)[];
  max?: (number | null)[];
}

// Вставляє null там, де між точками більше gapS секунд, щоб графік показував розрив.
export function withGaps(s: SeriesData, gapS: number): uPlot.AlignedData {
  const xs: number[] = [];
  const v: (number | null)[] = [];
  const mn: (number | null)[] = [];
  const mx: (number | null)[] = [];
  for (let i = 0; i < s.t.length; i++) {
    const x = s.t[i] / 1000;
    if (i > 0 && x - xs[xs.length - 1] > gapS) {
      xs.push((xs[xs.length - 1] + x) / 2);
      v.push(null);
      mn.push(null);
      mx.push(null);
    }
    xs.push(x);
    v.push(s.v[i]);
    mn.push(s.min ? s.min[i] : null);
    mx.push(s.max ? s.max[i] : null);
  }
  return s.min ? [xs, v, mn, mx] : [xs, v];
}

interface Props {
  metric: string;
  data: uPlot.AlignedData;
  height?: number;
  xRange?: [number, number]; // секунди
  limits?: { min: number | null; max: number | null } | null; // межі норми: пунктирні лінії
}

function fmtTick(v: number, span: number) {
  const d = new Date(v * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const dm = `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
  if (span <= 600) return `${hm}:${p(d.getSeconds())}`;
  if (span <= 86400 * 1.1) return hm;
  if (span <= 86400 * 8) return `${dm} ${hm}`;
  return dm;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function Chart({ metric, data, height = 160, xRange, limits }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const lim = useRef(limits);
  lim.current = limits;
  const hasBand = data.length > 2;

  useEffect(() => {
    if (!ref.current) return;
    const axis = { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { stroke: css("--grid") } };
    const series: uPlot.Series[] = [
      { label: "Час", value: (_u, v) => (v == null ? "—" : new Date(v * 1000).toLocaleString("uk-UA")) },
      { label: metricLabel(metric), stroke: css("--accent"), width: 1.5, value: (_u, v) => fmtValue(metric, v), spanGaps: false },
    ];
    if (hasBand) {
      series.push({ label: "мін", stroke: css("--band"), width: 1, value: (_u, v) => fmtValue(metric, v) });
      series.push({ label: "макс", stroke: css("--band"), width: 1, value: (_u, v) => fmtValue(metric, v) });
    }
    const opts: uPlot.Options = {
      width: ref.current.clientWidth,
      height,
      series,
      axes: [{ ...axis, values: (u, vals) => vals.map((v) => fmtTick(v, (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0))) }, { ...axis, size: 60, values: (_u, vals) => vals.map((v) => fmtValue(metric, v)) }],
      scales: {
        x: { time: true },
        // межі норми завжди в полі зору
        y: {
          range: (_u, dmin, dmax) => {
            let lo = dmin, hi = dmax;
            for (const b of [lim.current?.min, lim.current?.max]) {
              if (b == null) continue;
              lo = lo == null ? b : Math.min(lo, b);
              hi = hi == null ? b : Math.max(hi, b);
            }
            if (lo == null || hi == null) return [0, 1];
            if (lo === hi) return [lo - 1, hi + 1];
            const pad = (hi - lo) * 0.08;
            return [lo - pad, hi + pad];
          },
        },
      },
      hooks: {
        draw: [
          (u) => {
            const l = lim.current;
            if (!l) return;
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = css("--alarm");
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 4]);
            for (const b of [l.min, l.max]) {
              if (b == null) continue;
              const y = Math.round(u.valToPos(b, "y", true)) + 0.5;
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, y);
              ctx.lineTo(u.bbox.left + u.bbox.width, y);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
      },
      legend: { live: true },
      cursor: { drag: { x: true, y: false } },
      bands: hasBand ? [{ series: [3, 2], fill: css("--band-fill") }] : undefined,
    };
    plot.current = new uPlot(opts, data, ref.current);
    if (xRange) plot.current.setScale("x", { min: xRange[0], max: xRange[1] });
    const ro = new ResizeObserver(() => {
      if (ref.current && plot.current) plot.current.setSize({ width: ref.current.clientWidth, height });
    });
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // перебудовуємо графік лише при зміні показника чи наявності смуги мін/макс
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, hasBand, height]);

  useEffect(() => {
    if (!plot.current) return;
    plot.current.setData(data, !xRange);
    if (xRange) plot.current.setScale("x", { min: xRange[0], max: xRange[1] });
  }, [data, xRange]);

  useEffect(() => {
    plot.current?.redraw(true);
  }, [limits?.min, limits?.max]);

  return <div ref={ref} className="chart" />;
}
