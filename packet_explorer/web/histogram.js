import { Heatmap, pixelPairs } from "./heatmap.js";
import { fit, showTip } from "./detector.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const fieldNames = {
  adc: "ADC dataword",
  local_fifo: "Local FIFO",
  shared_fifo: "Shared FIFO",
  trigger_type: "Trigger type",
  first_packet: "First-packet flag",
  downstream_marker: "Downstream flag",
};
const left = 58,
  right = 16;

function pixelHistogram(detector, region, axes) {
  const ids = axes ? [] : null;
  let maxCount = 0;
  const values = [];
  const boxes = new Map((region.boxes || []).map((box) => [box[0], box]));
  let min = Infinity,
    max = -Infinity,
    sum = 0,
    integers = true;
  for (const id of detector.ids) {
    if (!detector.count[id]) continue;
    const tile = detector.tiles[detector.tileOf[id]];
    if (region.iog && tile.iog !== region.iog) continue;
    if (boxes.size) {
      const box = boxes.get(tile.tile);
      if (!box) continue;
      const cell = id - tile.start,
        x = cell % tile.width,
        y = Math.floor(cell / tile.width);
      if (x < box[1] || y < box[2] || x >= box[3] || y >= box[4]) continue;
    }
    const v = detector.value[id];
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    integers &&= Number.isInteger(v);
    values.push(v);
    if (ids) {
      ids.push(id);
      maxCount = Math.max(maxCount, detector.count[id]);
    }
  }
  if (!values.length) return { counts: [], total: 0 };
  // Use exact codes when possible. Continuous bins include the maximum in the last bin.
  const discrete = min === max || (integers && max - min < 256);
  const n = discrete ? max - min + 1 : 64;
  const width = discrete ? 1 : (max - min) / n;
  const counts = Array(n).fill(0);
  for (const v of values)
    counts[Math.min(n - 1, Math.floor((v - min) / width))]++;
  const data = {
    counts,
    min,
    width,
    discrete,
    total: values.length,
    mean: sum / values.length,
  };
  if (axes) data.joint = pixelPairs(detector, ids, maxCount, data, axes);
  return data;
}

function binLabel(data, i) {
  const low = data.min + i * data.width;
  if (data.discrete) return fmt(low);
  const high = data.min + (i + 1) * data.width;
  return (
    "[" +
    fmt(low) +
    ", " +
    fmt(high) +
    (i === data.counts.length - 1 ? "]" : ")")
  );
}

export class Histogram {
  constructor(detector, fetchBins, pause) {
    this.detector = detector;
    this.fetchBins = fetchBins;
    this.pause = pause;
    this.panel = $("histogram");
    this.canvas = $("histPlot");
    this.heatmap = new Heatmap(fieldNames, () => this.refresh());
    for (const [value, label] of Object.entries(fieldNames))
      $("histField").add(new Option(label, value));
    this.panel.addEventListener("toggle", () => {
      this.setDrawing(false);
      this.refresh();
    });
    for (const id of ["histField", "histSamples", "histArea"]) {
      $(id).addEventListener("change", () => {
        this.setDrawing(false);
        this.refresh();
      });
    }
    $("drawRegion").addEventListener("click", () => {
      this.pause();
      this.setDrawing(!this.drawing);
      if (this.drawing) $("regionPrompt").scrollIntoView({ block: "start" });
    });
    $("histFit").addEventListener("change", () => this.draw());
    $("cancelRegion").addEventListener("click", () => this.setDrawing(false));
    document.addEventListener("keydown", (e) => {
      if (this.drawing && e.key === "Escape") this.setDrawing(false);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect(),
        data = this.displayBins;
      const i = Math.floor(
        ((e.clientX - r.left - left) / (r.width - left - right)) *
          (data?.counts.length || 0),
      );
      if (
        !data?.total ||
        i < 0 ||
        i >= data.counts.length ||
        e.clientY > r.bottom - 26
      )
        return showTip(e, "");
      showTip(
        e,
        this.label +
          " " +
          binLabel(data, i) +
          "\n" +
          data.counts[i].toLocaleString() +
          " " +
          this.unit,
      );
    });
    this.canvas.addEventListener("pointerleave", (e) => showTip(e, ""));
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(this.canvas);
    this.observer.observe(this.heatmap.canvas);
    this.reset(0);
  }
  reset(iog) {
    this.frame = null;
    this.plane = iog;
    this.drawn = null;
    const area = $("histArea");
    area.replaceChildren(
      new Option(iog ? "IOG " + iog : "All selected planes", "all"),
    );
    for (const layout of this.detector.layouts) {
      if (!layout) continue;
      const group = layout.tiles[0].iog;
      if (iog && iog !== group) continue;
      const options = document.createElement("optgroup");
      options.label = "IOG " + group;
      if (!iog)
        options.append(new Option("IOG " + group + " · All tiles", group));
      for (const t of layout.tiles)
        options.append(
          new Option(
            "IOG " + group + " · Tile " + t.tile,
            group + "/" + t.tile,
          ),
        );
      area.append(options);
    }
    this.setDrawing(false);
    this.refresh();
  }
  area() {
    const value = $("histArea").value;
    if (value === "drawn") return this.drawn;
    if (value === "all") return { iog: this.plane };
    const [iog, tile] = value.split("/").map(Number);
    if (!tile) return { iog };
    const t = this.detector.layouts[iog].tiles.find((t) => t.tile === tile);
    return { iog, boxes: [[tile, 0, 0, t.width, t.height]] };
  }
  setDrawing(enabled) {
    this.drawing = enabled;
    $("drawRegion").setAttribute("aria-pressed", String(enabled));
    $("regionPrompt").hidden = !enabled;
    const finish = (region) => {
      this.drawn = region;
      const select = $("histArea");
      select.querySelector('[value="drawn"]')?.remove();
      select.add(
        new Option(
          "IOG " + region.iog + " · Drawn region",
          "drawn",
          false,
          true,
        ),
      );
      this.setDrawing(false);
      this.refresh();
      this.panel.scrollIntoView({ block: "nearest" });
    };
    this.detector.setRegion(
      this.panel.open && this.frame ? this.area() : null,
      enabled ? finish : null,
    );
  }
  setFrame(frame) {
    const wasEmpty = !this.frame;
    this.frame = frame;
    if (!this.panel.open) return;
    if (wasEmpty) this.setDrawing(false);
    return this.refresh();
  }
  async refresh() {
    this.pending?.abort();
    const pixels = $("histSamples").value === "pixels";
    this.heatmap.setMode($("histSamples").value);
    const axes = this.heatmap.axes;
    this.heatmap.set(null, null, pixels ? "pixels" : "packets", "Map value");
    $("histFieldLabel").hidden = $("histFitLabel").hidden = pixels;
    $("drawRegion").disabled = !this.frame;
    this.data = null;
    if (!this.panel.open || !this.frame) {
      $("histWindow").textContent = "Current window";
      $("histTitle").textContent = "";
      $("histSummary").textContent = this.frame
        ? ""
        : "Open a recording to see its histogram.";
      this.draw();
      return;
    }
    const { lo, hi } = this.frame;
    $("histWindow").textContent =
      hi === lo + 1
        ? "Tick " + lo.toLocaleString()
        : "Ticks " + lo.toLocaleString() + " – " + (hi - 1).toLocaleString();
    const region = this.area();
    const field = $("histField").value;
    const optionText = (id, value) =>
      Array.from($(id).options).find((o) => o.value === value)?.textContent;
    const stat = optionText("stat", this.detector.stat);
    this.label = pixels
      ? [optionText("field", this.detector.field), stat !== "—" && stat]
          .filter(Boolean)
          .join(" · ")
      : fieldNames[field];
    this.unit = pixels ? "pixels" : "packets";
    $("histTitle").textContent = this.label;
    if (pixels) {
      this.data = pixelHistogram(this.detector, region, axes);
    } else {
      const ctrl = new AbortController();
      this.pending = ctrl;
      $("histSummary").textContent = "Counting packets…";
      this.draw();
      try {
        const { counts, joint } = await this.fetchBins(
          {
            ...this.frame,
            ...axes,
            iog: region.iog,
            field,
            boxes: region.boxes && JSON.stringify(region.boxes),
          },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        const total = counts.reduce((a, b) => a + b, 0);
        const sum = counts.reduce((s, n, i) => s + n * i, 0);
        this.data = {
          joint,
          counts,
          total,
          mean: total ? sum / total : 0,
          min: 0,
          width: 1,
          discrete: true,
        };
      } catch (e) {
        if (!ctrl.signal.aborted) $("histSummary").textContent = e.message;
        return;
      }
    }
    const data = this.data;
    this.heatmap.set(data.joint, data.total, this.unit, this.label);
    $("histSummary").textContent = data.total
      ? data.total.toLocaleString() +
        " " +
        (data.total === 1 ? this.unit.slice(0, -1) : this.unit) +
        " · Mean " +
        fmt(data.mean)
      : "0 " + this.unit + " in this window";
    this.draw();
  }
  draw() {
    if (!this.panel.open || !this.canvas.clientWidth) return;
    this.heatmap.draw();
    const { ctx, w, h } = fit(this.canvas);
    ctx.clearRect(0, 0, w, h);
    let data = this.data;
    if (data?.total && this.unit === "packets" && $("histFit").checked) {
      let start = data.counts.findIndex((n) => n > 0),
        end = data.counts.length;
      while (end > start + 1 && !data.counts[end - 1]) end--;
      start = Math.max(0, start - 1);
      data = { ...data, min: start, counts: data.counts.slice(start, end + 1) };
    }
    this.displayBins = data;
    if (!data?.total) return;
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue("--" + name);
    const bottom = h - 28,
      top = 26,
      width = w - left - right,
      height = bottom - top;
    const peak = Math.max(...data.counts);
    const n = data.counts.length,
      step = width / n;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = color("muted");
    ctx.fillText(
      (this.unit === "pixels" ? "Pixels" : "Packets") + " / bin",
      10,
      15,
    );
    ctx.textAlign = "right";
    for (const count of new Set([0, Math.round(peak / 2), peak])) {
      const y = bottom - (count / peak) * height;
      ctx.fillStyle = color("muted");
      ctx.fillText(
        count.toLocaleString(undefined, { notation: "compact" }),
        left - 8,
        y + 3,
      );
      ctx.strokeStyle = color("line");
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w - right, y);
      ctx.stroke();
    }
    ctx.fillStyle = color("mint");
    for (let i = 0; i < n; i++) {
      const bh = (data.counts[i] / peak) * height;
      if (bh > 0)
        ctx.fillRect(
          left + i * step + step * 0.06,
          bottom - bh,
          Math.max(0.8, step * 0.88),
          bh,
        );
    }
    ctx.fillStyle = color("muted");
    const ticks = Math.min(5, Math.max(2, Math.floor(width / 85)));
    if (data.discrete) {
      for (const i of new Set(
        Array.from({ length: ticks }, (_, j) =>
          Math.round((j * (n - 1)) / (ticks - 1)),
        ),
      )) {
        ctx.textAlign =
          n === 1
            ? "center"
            : i === 0
              ? "left"
              : i === n - 1
                ? "right"
                : "center";
        ctx.fillText(fmt(data.min + i), left + (i + 0.5) * step, h - 8);
      }
    } else {
      for (let j = 0; j < ticks; j++) {
        const f = j / (ticks - 1);
        ctx.textAlign = j === 0 ? "left" : j === ticks - 1 ? "right" : "center";
        ctx.fillText(
          fmt(data.min + f * n * data.width),
          left + f * width,
          h - 8,
        );
      }
    }
  }
}
