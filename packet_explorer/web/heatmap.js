import { fit, showTip } from "./detector.js";

const $ = (id) => document.getElementById(id);
const fmt = (value) =>
  value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const shared = {
  channel_count: "Channel occupancy (packets/window)",
  channel_id: "Channel ID",
  chip_id: "Chip ID",
};

function pixelAxis(key, maxCount, map) {
  if (key === "map_value")
    return {
      min: map.min,
      max: map.discrete
        ? map.min + map.counts.length - 1
        : map.min + map.counts.length * map.width,
      width: map.width,
      size: map.counts.length,
      discrete: map.discrete,
    };
  const min = key === "channel_count" ? 1 : 0;
  const max =
    key === "channel_count" ? maxCount : key === "channel_id" ? 63 : 255;
  const width = key === "channel_count" ? Math.ceil(maxCount / 64) : 1;
  return {
    min,
    max,
    width,
    size: Math.ceil((max - min + 1) / width),
    discrete: true,
  };
}

export function pixelPairs(detector, ids, maxCount, map, axes) {
  if (!ids.length) return null;
  const x = pixelAxis(axes.x, maxCount, map),
    y = pixelAxis(axes.y, maxCount, map);
  const counts = new Float64Array(x.size * y.size);
  function bin(key, axis, id) {
    let value;
    if (key === "map_value") value = detector.value[id];
    else if (key === "channel_count") value = detector.count[id];
    else {
      const address = detector.address(id);
      value = key === "channel_id" ? address & 63 : address >> 6;
    }
    return Math.min(axis.size - 1, Math.floor((value - axis.min) / axis.width));
  }
  for (const id of ids)
    counts[bin(axes.y, y, id) * x.size + bin(axes.x, x, id)]++;
  return { x, y, counts };
}

function interval(axis, i) {
  const lo = axis.min + i * axis.width;
  if (axis.discrete) {
    const hi = Math.min(axis.max, lo + axis.width - 1);
    return hi === lo ? fmt(lo) : fmt(lo) + "–" + fmt(hi);
  }
  const last = i === axis.size - 1;
  return (
    "[" +
    fmt(lo) +
    ", " +
    fmt(last ? axis.max : lo + axis.width) +
    (last ? "]" : ")")
  );
}

const margins = { left: 78, right: 15, top: 12, bottom: 42 };
function tickIndices(first, last, limit) {
  const n = Math.min(limit, last - first + 1);
  return Array.from(
    { length: n },
    (_, i) => first + Math.round((i * (last - first)) / Math.max(1, n - 1)),
  );
}

export class Heatmap {
  constructor(fields, refresh) {
    this.canvas = $("jointPlot");
    this.fields = fields;
    this.choices = {
      packets: ["channel_count", "local_fifo"],
      pixels: ["channel_count", "map_value"],
    };
    this.mode = null;
    this.setMode("packets");
    $("jointLog").addEventListener("change", () => this.draw());
    for (const id of ["jointX", "jointY"])
      $(id).addEventListener("change", () => {
        this.choices[this.mode] = [$("jointX").value, $("jointY").value];
        refresh();
      });
    $("jointEnabled").addEventListener("change", () => {
      $("jointPane").hidden = !this.enabled;
      $("histPlots").classList.toggle("paired", this.enabled);
      refresh();
    });
    this.canvas.addEventListener("pointermove", (e) => this.hover(e));
    this.canvas.addEventListener("pointerleave", (e) => showTip(e, ""));
  }
  get enabled() {
    return $("jointEnabled").checked;
  }
  get axes() {
    return this.enabled ? { x: $("jointX").value, y: $("jointY").value } : null;
  }
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    const fields =
      mode === "packets" ? this.fields : { map_value: "Current map value" };
    for (const [i, id] of ["jointX", "jointY"].entries()) {
      $(id).replaceChildren(
        ...Object.entries({ ...shared, ...fields }).map(
          ([value, name]) => new Option(name, value),
        ),
      );
      $(id).value = this.choices[mode][i];
    }
  }
  set(data, total, unit, mapLabel) {
    this.grid = data;
    this.unit = unit;
    this.names = ["jointX", "jointY"].map((id) =>
      $(id).value === "map_value" ? mapLabel : $(id).selectedOptions[0].text,
    );
    let peak = 0;
    if (data && total) {
      // The server sends occupied cells only. Pixel mode already has a bounded grid.
      if (data.bins) {
        const dense = new Float64Array(data.x.size * data.y.size);
        data.bins.forEach((b, i) => (dense[b] = data.counts[i]));
        this.grid = { x: data.x, y: data.y, counts: dense };
      }
      for (const value of this.grid.counts) peak = Math.max(peak, value);
    }
    this.peak = peak;
    $("jointSummary").textContent =
      total !== null
        ? total.toLocaleString() +
          " " +
          (total === 1 ? unit.slice(0, -1) : unit)
        : "";
    $("jointLegend").hidden = !peak;
    $("jointLegend").classList.toggle("single", peak === 1);
    $("jointPeak").textContent = peak.toLocaleString();
    $("jointUnit").textContent =
      unit === "pixels" ? "Pixels / bin" : "Packets / bin";
    this.extent = null;
  }
  draw() {
    if (!this.enabled || !this.canvas.clientWidth) return;
    const { ctx, w, h } = fit(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const grid = this.grid;
    if (!this.peak || !grid) return;
    const nx = grid.x.size,
      ny = grid.y.size;
    let x0 = 0,
      x1 = nx - 1,
      y0 = 0,
      y1 = ny - 1;
    if (this.mode === "packets" && $("histFit").checked) {
      x0 = nx;
      y0 = ny;
      x1 = 0;
      y1 = 0;
      for (let i = 0; i < grid.counts.length; i++)
        if (grid.counts[i]) {
          const x = i % nx,
            y = Math.floor(i / nx);
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      x0 = Math.max(0, x0 - 1);
      x1 = Math.min(nx - 1, x1 + 1);
      y0 = Math.max(0, y0 - 1);
      y1 = Math.min(ny - 1, y1 + 1);
    }
    const { left, right, top, bottom } = margins;
    const width = w - left - right,
      height = h - top - bottom;
    if (width <= 0 || height <= 0) return;
    const dx = width / (x1 - x0 + 1),
      dy = height / (y1 - y0 + 1);
    this.extent = { x0, x1, y0, y1, dx, dy };
    const style = getComputedStyle(this.canvas);
    ctx.fillStyle = style.getPropertyValue("--surface");
    ctx.fillRect(left, top, width, height);
    ctx.fillStyle = style.getPropertyValue("--mint");
    const logarithmic = $("jointLog").checked;
    const scale = logarithmic ? Math.log(this.peak) : this.peak - 1;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const n = grid.counts[y * nx + x];
        if (!n) continue;
        ctx.globalAlpha =
          scale === 0
            ? 1
            : 0.28 + (0.72 * (logarithmic ? Math.log(n) : n - 1)) / scale;
        const px = left + (x - x0) * dx,
          py = top + (y1 - y) * dy;
        ctx.fillRect(px, py, dx > 6 ? dx - 0.6 : dx, dy > 6 ? dy - 0.6 : dy);
      }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.getPropertyValue("--line");
    ctx.strokeRect(left, top, width, height);
    ctx.fillStyle = style.getPropertyValue("--muted");
    ctx.font = "11px system-ui,sans-serif";
    ctx.textAlign = "right";
    const axisTick = (axis, i) =>
      axis.discrete
        ? interval(axis, i)
        : fmt(axis.min + (i + 0.5) * axis.width);
    for (const y of tickIndices(y0, y1, 5))
      ctx.fillText(
        axisTick(grid.y, y),
        left - 6,
        top + (y1 - y + 0.5) * dy + 4,
        left - 23,
      );
    ctx.textAlign = "center";
    const limit = Math.max(2, Math.min(6, Math.floor(width / 88)));
    for (const x of tickIndices(x0, x1, limit)) {
      const pos = left + (x - x0 + 0.5) * dx;
      ctx.textAlign =
        x1 === x0
          ? "center"
          : x === x0
            ? "left"
            : x === x1
              ? "right"
              : "center";
      ctx.fillText(
        axisTick(grid.x, x),
        pos,
        top + height + 15,
        Math.max(42, width / limit),
      );
    }
    ctx.textAlign = "center";
    ctx.fillText(this.names[0], left + width / 2, h - 6, width);
    ctx.save();
    ctx.translate(13, top + height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(this.names[1], 0, 0, height);
    ctx.restore();
  }
  hover(e) {
    if (!this.extent) return showTip(e, "");
    const r = this.canvas.getBoundingClientRect(),
      { x0, x1, y0, y1, dx, dy } = this.extent;
    const x = x0 + Math.floor((e.clientX - r.left - margins.left) / dx);
    const y = y1 - Math.floor((e.clientY - r.top - margins.top) / dy);
    if (x < x0 || x > x1 || y < y0 || y > y1) return showTip(e, "");
    const grid = this.grid,
      n = grid.counts[y * grid.x.size + x];
    showTip(
      e,
      this.names[0] +
        " · " +
        interval(grid.x, x) +
        "\n" +
        this.names[1] +
        " · " +
        interval(grid.y, y) +
        "\n" +
        n.toLocaleString() +
        " " +
        (n === 1 ? this.unit.slice(0, -1) : this.unit),
    );
  }
}
