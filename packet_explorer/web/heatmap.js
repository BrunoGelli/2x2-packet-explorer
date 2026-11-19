import { fit, showTip } from "./detector.js";

const $ = (id) => document.getElementById(id);
const fmt = (value) =>
  value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const shared = {
  channel_count: "Channel occupancy (packets/window)",
  channel_id: "Channel ID",
  chip_id: "Chip ID",
};

const palettes = {
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  inferno: ["#000004", "#57106e", "#bc3754", "#f98e09", "#fcffa4"],
};
const ramps = Object.fromEntries(
  Object.entries(palettes).map(([name, stops]) => {
    const rgb = stops.map((hex) =>
      [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
    );
    const colors = Array.from({ length: 256 }, (_, i) => {
      const t = (i / 255) * (rgb.length - 1),
        k = Math.min(Math.floor(t), rgb.length - 2);
      return (
        "rgb(" +
        rgb[k]
          .map((v, j) => Math.round(v + (rgb[k + 1][j] - v) * (t - k)))
          .join(",") +
        ")"
      );
    });
    return [name, colors];
  }),
);

function makeAxisControls(dim, update) {
  const row = document.createElement("div");
  row.className = "axis-settings";
  const axis = dim.toUpperCase();
  const controls = {};
  for (const [key, name] of [
    ["mode", axis + " range"],
    ["min", "Min"],
    ["max", "Max"],
    ["width", "Bin width"],
  ]) {
    const label = document.createElement("label");
    label.textContent = name;
    const input = document.createElement(key === "mode" ? "select" : "input");
    if (key === "mode")
      input.append(new Option("Auto", "auto"), new Option("Fixed", "fixed"));
    else {
      input.type = "number";
      input.step = "any";
      if (key === "width") input.placeholder = "Auto";
    }
    input.id = "joint" + axis + key[0].toUpperCase() + key.slice(1);
    input.setAttribute(
      "aria-label",
      axis + " " + (key === "mode" ? "range" : name.toLowerCase()),
    );
    input.addEventListener("change", update);
    label.append(input);
    row.append(label);
    controls[key] = input;
  }
  $("axisControls").append(row);
  return controls;
}

function adjustAxis(axis, settings, key, detector) {
  if (!Object.keys(settings).length) return axis;
  const min = settings.min ?? axis.min,
    max = settings.max ?? axis.max;
  const continuousMap =
    key === "map_value" &&
    (["rate", "adc_corrected"].includes(detector.field) ||
      ["mean", "median", "full_fraction"].includes(detector.stat));
  const discrete = !continuousMap && axis.discrete;
  if (discrete && !Object.values(settings).every(Number.isSafeInteger))
    throw Error("Use whole numbers for discrete axis limits and bin widths.");
  const span = max - min + Number(discrete);
  const defaultWidth = discrete
    ? Math.max(1, Math.ceil(span / (key === "channel_count" ? 64 : 1024)))
    : span / 64 || 1;
  const width = settings.width ?? defaultWidth;
  if (
    !(width > 0) ||
    span < 0 ||
    !Number.isFinite(span / width) ||
    span / width > 1024
  )
    throw Error("Use a positive bin width with at most 1024 bins per axis.");
  return {
    min,
    max,
    width,
    discrete,
    size: Math.max(1, Math.ceil(span / width)),
  };
}

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

export function pixelPairs(detector, ids, maxCount, map, axes, settings) {
  const x = adjustAxis(
      pixelAxis(axes.x, maxCount, map),
      settings.x,
      axes.x,
      detector,
    ),
    y = adjustAxis(
      pixelAxis(axes.y, maxCount, map),
      settings.y,
      axes.y,
      detector,
    );
  const counts = new Float64Array(x.size * y.size);
  function bin(key, axis, id) {
    let value;
    if (key === "map_value") value = detector.value[id];
    else if (key === "channel_count") value = detector.count[id];
    else {
      const address = detector.address(id);
      value = key === "channel_id" ? address & 63 : address >> 6;
    }
    if (!Number.isFinite(value)) return -2;
    if (value < axis.min || value > axis.max) return -1;
    return Math.min(axis.size - 1, Math.floor((value - axis.min) / axis.width));
  }
  let missing = 0,
    outside = 0;
  for (const id of ids) {
    const bx = bin(axes.x, x, id),
      by = bin(axes.y, y, id);
    if (bx === -2 || by === -2) missing++;
    else if (bx < 0 || by < 0) outside++;
    else counts[by * x.size + bx]++;
  }
  return { x, y, counts, missing, outside };
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
    this.saved = new Map();
    this.controls = Object.fromEntries(
      ["x", "y"].map((dim) => [
        dim,
        makeAxisControls(dim, () => {
          const { mode, min, max } = this.controls[dim];
          const a = this.grid?.[dim];
          if (mode.value === "fixed" && a && (!min.value || !max.value)) {
            min.value = a.min;
            max.value = a.max;
          }
          min.disabled = max.disabled = mode.value !== "fixed";
          this.saveAxis(dim);
          refresh();
        }),
      ]),
    );
    $("jointColorMode").onchange = () => {
      const auto = $("jointColorMode").value === "auto";
      $("jointColorMin").disabled = $("jointColorMax").disabled = auto;
      this.draw();
    };
    for (const id of ["jointColorMin", "jointColorMax", "jointPalette"])
      $(id).addEventListener("change", () => this.draw());
    $("lockJoint").onclick = () => {
      if (!this.extent) return;
      for (const dim of ["x", "y"]) {
        const a = this.grid[dim],
          c = this.controls[dim];
        c.mode.value = "fixed";
        c.min.disabled = c.max.disabled = false;
        c.min.value = a.min + this.extent[dim + "0"] * a.width;
        c.max.value = Math.min(
          a.max,
          a.min + (this.extent[dim + "1"] + 1) * a.width - Number(a.discrete),
        );
        c.width.value = a.width;
        this.saveAxis(dim);
      }
      $("jointColorMode").value = "fixed";
      $("jointColorMin").disabled = $("jointColorMax").disabled = false;
      [$("jointColorMin").value, $("jointColorMax").value] = this.colorRange;
      refresh();
    };
    this.setMode("packets");
    $("jointLog").addEventListener("change", () => this.draw());
    for (const id of ["jointX", "jointY"])
      $(id).addEventListener("change", () => {
        this.choices[this.mode] = [$("jointX").value, $("jointY").value];
        this.restoreAxes();
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
  key(dim) {
    const field = $(dim === "x" ? "jointX" : "jointY").value;
    return [
      this.mode,
      dim,
      field,
      field === "map_value" ? this.mapKey : "",
    ].join("/");
  }
  saveAxis(dim) {
    this.saved.set(
      this.key(dim),
      Object.fromEntries(
        Object.entries(this.controls[dim]).map(([k, c]) => [k, c.value]),
      ),
    );
  }
  restoreAxes() {
    for (const dim of ["x", "y"]) {
      const c = this.controls[dim],
        stored = this.saved.get(this.key(dim)) || { mode: "auto" };
      for (const key of Object.keys(c)) c[key].value = stored[key] ?? "";
      c.min.disabled = c.max.disabled = c.mode.value !== "fixed";
    }
  }
  settings() {
    const result = {};
    for (const dim of ["x", "y"]) {
      const c = this.controls[dim],
        values = {};
      if (c.mode.value === "fixed") {
        values.min = c.min.valueAsNumber;
        values.max = c.max.valueAsNumber;
        if (
          ![values.min, values.max].every(Number.isFinite) ||
          values.max < values.min
        )
          throw Error(
            "Enter valid " + dim.toUpperCase() + " limits in ascending order.",
          );
      }
      if (c.width.value || c.width.validity.badInput) {
        values.width = c.width.valueAsNumber;
        if (!(values.width > 0)) throw Error("Bin width must be positive.");
      }
      result[dim] = values;
    }
    return result;
  }
  setMode(mode, mapKey) {
    if (this.mode === mode && this.mapKey === mapKey) return;
    this.mapKey = mapKey;
    this.mode = mode;
    const fields =
      mode === "packets" ? this.fields : { map_value: "Current map value" };
    for (const [i, id] of ["jointX", "jointY"].entries()) {
      $(id).replaceChildren(
        ...Object.entries({ ...shared, ...fields }).map(
          ([value, name]) => new Option(name, value),
        ),
      );
      const corrected = $(id).querySelector('[value="adc_corrected"]');
      if (corrected) corrected.disabled = !this.calibrated;
      $(id).value = this.choices[mode][i];
    }
    this.restoreAxes();
  }
  set(data, total, unit, mapLabel) {
    this.grid = data;
    this.unit = unit;
    this.names = ["jointX", "jointY"].map((id) =>
      $(id).value === "map_value" ? mapLabel : $(id).selectedOptions[0].text,
    );
    let peak = 0;
    if (data) {
      // The server sends occupied cells only. Pixel mode already has a bounded grid.
      if (data.bins) {
        const dense = new Float64Array(data.x.size * data.y.size);
        data.bins.forEach((b, i) => (dense[b] = data.counts[i]));
        this.grid = { x: data.x, y: data.y, counts: dense };
      }
      total = 0;
      for (const value of this.grid.counts) {
        peak = Math.max(peak, value);
        total += value;
      }
    }
    this.peak = peak;
    $("jointSummary").textContent =
      total !== null
        ? total.toLocaleString() +
          " " +
          (total === 1 ? unit.slice(0, -1) : unit) +
          (data?.missing
            ? " · " + fmt(data.missing) + " without pedestal"
            : "") +
          (data?.outside ? " · " + fmt(data.outside) + " outside axes" : "")
        : "";
    $("jointLegend").hidden = !data;
    $("lockJoint").disabled = !data;
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
    if (!grid) return;
    const nx = grid.x.size,
      ny = grid.y.size;
    let x0 = 0,
      x1 = nx - 1,
      y0 = 0,
      y1 = ny - 1;
    if (this.peak && this.mode === "packets" && $("histFit").checked) {
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
      if (this.controls.x.mode.value === "fixed") {
        x0 = 0;
        x1 = nx - 1;
      }
      if (this.controls.y.mode.value === "fixed") {
        y0 = 0;
        y1 = ny - 1;
      }
    }
    const { left, right, top, bottom } = margins;
    const width = w - left - right,
      height = h - top - bottom;
    if (width <= 0 || height <= 0) return;
    // Fixed limits can cut the final bin short. Keep the axes, cells and
    // pointer coordinates on the same numerical scale.
    const spanInBins = (axis, first, last) => {
      const end = (axis.max - axis.min + Number(axis.discrete)) / axis.width;
      return Math.min(last + 1, end) - first || 1;
    };
    const dx = width / spanInBins(grid.x, x0, x1);
    const dy = height / spanInBins(grid.y, y0, y1);
    this.extent = { x0, x1, y0, y1, dx, dy, height, width };
    const style = getComputedStyle(this.canvas);
    ctx.fillStyle = style.getPropertyValue("--surface");
    ctx.fillRect(left, top, width, height);
    const logarithmic = $("jointLog").checked;
    $("jointColorMin").min = logarithmic ? 1 : 0;
    const fixed = $("jointColorMode").value === "fixed";
    const low = fixed ? $("jointColorMin").valueAsNumber : 1;
    const high = fixed
      ? $("jointColorMax").valueAsNumber
      : Math.max(1, this.peak);
    if (
      !Number.isSafeInteger(low) ||
      !Number.isSafeInteger(high) ||
      low < (logarithmic ? 1 : 0) ||
      high < 1 ||
      high < low
    ) {
      $("settingsError").textContent = logarithmic
        ? "Log color requires positive whole counts in ascending order."
        : "Set whole-number color limits with a minimum of 0 or more and a maximum of at least 1.";
      this.extent = null;
      return;
    }
    $("settingsError").textContent = "";
    this.colorRange = [low, high];
    const palette = $("jointPalette").value,
      colors = ramps[palette];
    $("jointLegend").classList.toggle("single", low === high);
    $("jointLegend").querySelector("i").style.background =
      low === high
        ? colors[255]
        : "linear-gradient(to right," + palettes[palette].join(",") + ")";
    $("jointLow").textContent = fmt(low);
    const midpoint = logarithmic ? Math.sqrt(low * high) : (low + high) / 2;
    $("jointMid").textContent = high - low < 2 ? "" : fmt(Math.round(midpoint));
    $("jointPeak").textContent = fmt(high);
    const scaled = logarithmic ? Math.log : (v) => v;
    const first = scaled(low),
      span = scaled(high) - first;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const n = grid.counts[y * nx + x];
        if (!n) continue;
        const f = span ? (scaled(n) - first) / span : n >= high ? 1 : 0;
        ctx.fillStyle = colors[Math.round(255 * Math.max(0, Math.min(1, f)))];
        const px = (x - x0) * dx,
          py = (y - y0) * dy;
        const bw = Math.min(dx, width - px),
          bh = Math.min(dy, height - py);
        ctx.fillRect(
          left + px,
          top + height - py - bh,
          bw > 6 ? bw - 0.6 : bw,
          bh > 6 ? bh - 0.6 : bh,
        );
      }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.getPropertyValue("--line");
    ctx.strokeRect(left, top, width, height);
    ctx.fillStyle = style.getPropertyValue("--muted");
    ctx.font = "11px system-ui,sans-serif";
    ctx.textAlign = "right";
    function ticks(axis, start, end, step, length, limit) {
      if (axis.discrete)
        return tickIndices(start, end, limit).map((i) => {
          const offset = (i - start) * step;
          return [
            offset + Math.min(step, length - offset) / 2,
            interval(axis, i),
          ];
        });
      const lo = axis.min + start * axis.width;
      const hi = Math.min(axis.max, axis.min + (end + 1) * axis.width);
      return Array.from({ length: limit }, (_, i) => {
        const f = i / (limit - 1);
        return [f * length, fmt(lo + (hi - lo) * f)];
      });
    }
    for (const [pos, label] of ticks(grid.y, y0, y1, dy, height, 5))
      ctx.fillText(label, left - 6, top + height - pos + 4, left - 23);
    const limit = Math.max(2, Math.min(6, Math.floor(width / 88)));
    const xTicks = ticks(grid.x, x0, x1, dx, width, limit);
    xTicks.forEach(([pos, label], i) => {
      ctx.textAlign =
        xTicks.length === 1
          ? "center"
          : i === 0
            ? "left"
            : i === xTicks.length - 1
              ? "right"
              : "center";
      ctx.fillText(
        label,
        left + pos,
        top + height + 15,
        Math.max(42, width / limit),
      );
    });
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
      { x0, x1, y0, y1, dx, dy, height, width } = this.extent;
    const px = e.clientX - r.left - margins.left,
      py = e.clientY - r.top - margins.top;
    if (px < 0 || px >= width || py < 0 || py >= height) return showTip(e, "");
    const x = Math.min(x1, x0 + Math.floor(px / dx));
    const y = Math.min(y1, y0 + Math.floor((height - py) / dy));
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
