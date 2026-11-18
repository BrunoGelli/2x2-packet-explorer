const $ = (id) => document.getElementById(id);
const el = (tag, css, text) => {
  const node = document.createElement(tag);
  if (css) node.className = css;
  if (text !== undefined) node.textContent = text;
  return node;
};
const palette = Array.from({ length: 256 }, (_, i) => {
  const stops = [
    [81, 115, 204],
    [57, 185, 189],
    [241, 215, 119],
  ];
  const f = (i / 255) * 2,
    k = Math.min(1, Math.floor(f));
  return stops[k].map((v, j) =>
    Math.round(v + (stops[k + 1][j] - v) * (f - k)),
  );
});
const occupied = [101, 223, 189],
  held = [101, 120, 145];
export function showTip(e, text) {
  const tip = $("tooltip");
  if (!text) {
    tip.hidden = true;
    return;
  }
  tip.hidden = false;
  tip.textContent = text;
  tip.style.left =
    Math.max(
      2,
      Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 5),
    ) + "px";
  tip.style.top =
    Math.max(
      2,
      Math.min(e.clientY + 12, window.innerHeight - tip.offsetHeight - 5),
    ) + "px";
}
export function fit(canvas) {
  const r = canvas.getBoundingClientRect(),
    dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr),
    h = Math.round(r.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

export class Detector {
  constructor(tiles, selectPixel, focus) {
    this.tiles = tiles.map((t) => {
      const raster = el("canvas");
      raster.width = t.width;
      raster.height = t.height;
      const context = raster.getContext("2d");
      return {
        ...t,
        raster,
        context,
        image: context.createImageData(t.width, t.height),
      };
    });
    const size = this.tiles.reduce((n, t) => n + t.width * t.height, 0);
    this.tileOf = new Uint8Array(size);
    this.count = new Float64Array(size);
    this.value = new Float64Array(size);
    this.active = new Uint8Array(size);
    this.ids = [];
    this.canvases = [];
    this.modules = [];
    this.panes = [];
    this.tiles.forEach((t, k) =>
      this.tileOf.fill(k, t.start, t.start + t.width * t.height),
    );
    for (let mod = 0; mod < 4; mod++) {
      const box = el("section", "module"),
        planes = el("div", "planes");
      box.append(el("h3", null, "Module " + mod), planes);
      $("modules").append(box);
      this.modules.push(box);
      for (let side = 1; side <= 2; side++) {
        const iog = 2 * mod + side,
          pane = el("div", "plane"),
          canvas = el("canvas");
        canvas.setAttribute("aria-label", "IOG " + iog + " detector map");
        pane.append(el("div", "plane-title", "IOG " + iog), canvas);
        planes.append(pane);
        this.canvases[iog] = canvas;
        this.panes[iog] = pane;
        canvas.addEventListener("pointermove", (e) => {
          const id = this.underPointer(e, canvas, iog);
          if (id === null) {
            showTip(e, "");
            return;
          }
          const t = this.tiles[this.tileOf[id]],
            cell = id - t.start;
          let s =
            "IOG " +
            iog +
            " · tile " +
            t.tile +
            " · col " +
            (cell % t.width) +
            " · row " +
            (t.height - 1 - Math.floor(cell / t.width));
          if (this.active[id])
            s += this.count[id]
              ? "\n" +
                this.count[id] +
                " packet(s) · " +
                this.value[id].toLocaleString(undefined, {
                  maximumFractionDigits: 3,
                })
              : "\nHeld from an earlier tick";
          showTip(e, s);
        });
        canvas.addEventListener("pointerleave", (e) => showTip(e, ""));
        canvas.addEventListener("click", (e) => {
          const id = this.underPointer(e, canvas, iog);
          if (id !== null) selectPixel(id);
        });
        canvas.addEventListener("dblclick", () => focus(iog));
      }
    }
    this.observer = new ResizeObserver(() => this.paint());
    this.canvases.forEach((c) => this.observer.observe(c));
  }
  underPointer(e, canvas, iog) {
    const rect = canvas.getBoundingClientRect(),
      x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    const t = this.tiles.find(
      (t) =>
        t.iog === iog &&
        t.rect &&
        x >= t.rect.x &&
        x < t.rect.x + t.rect.w &&
        y >= t.rect.y &&
        y < t.rect.y + t.rect.h,
    );
    if (!t) return null;
    return (
      t.start +
      Math.floor(((y - t.rect.y) / t.rect.h) * t.height) * t.width +
      Math.floor(((x - t.rect.x) / t.rect.w) * t.width)
    );
  }
  filter(iog) {
    this.modules.forEach(
      (m, i) => (m.hidden = !!iog && Math.floor((iog - 1) / 2) !== i),
    );
    this.panes.forEach((p, i) => (p.hidden = !!iog && iog !== i));
    $("modules").classList.toggle("focus", !!iog);
    this.paint();
  }
  set(buffer, field, stat, heldTicks, width) {
    const data = new DataView(buffer),
      n = data.byteLength / 20;
    if (!Number.isInteger(n)) throw Error("Incomplete detector map.");
    for (const id of this.ids) {
      const t = this.tiles[this.tileOf[id]];
      t.image.data[4 * (id - t.start) + 3] = 0;
      t.dirty = true;
      this.active[id] = 0;
    }
    this.ids = new Uint32Array(n);
    let nPacket = 0,
      nCurrent = 0,
      peak = 0;
    for (let i = 0; i < n; i++) {
      const at = i * 20,
        id = data.getUint32(at, true),
        c = data.getFloat64(at + 4, true),
        v = data.getFloat64(at + 12, true);
      this.ids[i] = id;
      this.count[id] = c;
      this.value[id] = v;
      this.active[id] = 1;
      if (c) {
        nPacket += c;
        nCurrent++;
        peak = Math.max(peak, v);
      }
    }
    const fixed = {
      adc: 255,
      local_fifo: 3,
      shared_fifo: 3,
      trigger_type: 3,
      first_packet: 1,
      downstream_marker: 1,
      occupancy: 1,
    };
    const max = stat === "full_fraction" ? 1 : (fixed[field] ?? peak);
    for (const id of this.ids) {
      const t = this.tiles[this.tileOf[id]],
        k = (id - t.start) * 4;
      const rgb = !this.count[id]
        ? held
        : field === "occupancy"
          ? occupied
          : palette[Math.round(255 * Math.min(1, this.value[id] / (max || 1)))];
      const a = t.image.data;
      a[k] = rgb[0];
      a[k + 1] = rgb[1];
      a[k + 2] = rgb[2];
      a[k + 3] = 255;
      t.dirty = true;
    }
    this.tiles.forEach((t) => {
      if (t.dirty) {
        t.context.putImageData(t.image, 0, 0);
        t.dirty = false;
      }
    });
    $("mapSummary").textContent =
      nPacket.toLocaleString() +
      " packets · " +
      nCurrent.toLocaleString() +
      " active pixels" +
      (heldTicks > width
        ? " · " + (n - nCurrent).toLocaleString() + " held"
        : "");
    const legend = $("legend");
    legend.replaceChildren();
    if (field === "occupancy")
      legend.append(el("i", "dot"), document.createTextNode("In window"));
    else
      legend.append(
        document.createTextNode("0"),
        el("i", "ramp"),
        document.createTextNode(
          max.toLocaleString(undefined, { maximumFractionDigits: 2 }) +
            (field === "first_hit" ? " ticks" : field === "rate" ? " Hz" : ""),
        ),
      );
    if (heldTicks > width)
      legend.append(el("i", "held"), document.createTextNode("Held"));
    this.paint();
  }
  paint() {
    this.canvases.forEach((c, g) => {
      if (!c.clientWidth) return;
      const { ctx, w, h } = fit(c),
        tiles = this.tiles.filter((t) => t.iog === g);
      const xmin = Math.min(...tiles.map((t) => t.x - t.pitch / 2)),
        xmax = Math.max(...tiles.map((t) => t.x + (t.width - 0.5) * t.pitch));
      const ymin = Math.min(...tiles.map((t) => t.y - t.pitch / 2)),
        ymax = Math.max(...tiles.map((t) => t.y + (t.height - 0.5) * t.pitch));
      const s = Math.min((w - 8) / (xmax - xmin), (h - 6) / (ymax - ymin));
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      for (const t of tiles) {
        const x = (w - (xmax - xmin) * s) / 2 + (t.x - t.pitch / 2 - xmin) * s,
          y =
            (h - (ymax - ymin) * s) / 2 +
            (ymax - t.y - (t.height - 0.5) * t.pitch) * s;
        const tw = t.width * t.pitch * s,
          th = t.height * t.pitch * s;
        t.rect = { x, y, w: tw, h: th };
        ctx.fillStyle = "#0a131f";
        ctx.fillRect(x, y, tw, th);
        ctx.drawImage(t.raster, x, y, tw, th);
        ctx.strokeStyle = "#2c4054";
        ctx.lineWidth = 0.75;
        ctx.strokeRect(x, y, tw, th);
        if (tw > 22) {
          ctx.fillStyle = "#738397";
          ctx.font = "9px monospace";
          ctx.fillText("T" + t.tile, x + 3, y + 10);
        }
      }
    });
    // Keep isolated hits visible when several physical cells share a screen pixel.
    if (this.ids.length < 8000) {
      for (const id of this.ids) {
        const t = this.tiles[this.tileOf[id]],
          c = this.canvases[t.iog],
          r = t.rect;
        if (!r || this.panes[t.iog].hidden || r.w / t.width >= 1.8) continue;
        const cell = id - t.start,
          k = 4 * cell,
          a = t.image.data,
          ctx = c.getContext("2d");
        ctx.fillStyle = "rgb(" + a[k] + "," + a[k + 1] + "," + a[k + 2] + ")";
        ctx.fillRect(
          r.x + (((cell % t.width) + 0.5) * r.w) / t.width - 0.8,
          r.y + ((Math.floor(cell / t.width) + 0.5) * r.h) / t.height - 0.8,
          1.6,
          1.6,
        );
      }
    }
  }
}
