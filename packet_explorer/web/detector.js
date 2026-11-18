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
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const format = (n) =>
  n.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const fixedMax = {
  adc: 255,
  local_fifo: 3,
  shared_fifo: 3,
  trigger_type: 3,
  first_packet: 1,
  downstream_marker: 1,
};
const units = { first_hit: " ticks", rate: " Hz", adc: " ADC" };
const resetCamera = () => ({ zoom: 1, x: 0, y: 0 });

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
  constructor(tiles, addresses, selectPixel) {
    this.addresses = addresses;
    this.cameras = [];
    this.field = "occupancy";
    this.scaleByField = new Map();
    this.hover = null;
    this.region = this.draftRegion = this.onRegion = null;
    this.focused = this.filtered = 0;
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
    this.layouts = [];
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
        const expand = el("button", "plane-title", "IOG " + iog);
        expand.type = "button";
        expand.append(el("span", "zoom-value", ""));
        expand.title = "Expand IOG " + iog;
        expand.setAttribute("aria-label", "Expand IOG " + iog);
        expand.setAttribute("aria-pressed", "false");
        expand.addEventListener("click", () => this.expand(iog));
        pane.append(expand, canvas);
        planes.append(pane);
        this.canvases[iog] = canvas;
        this.panes[iog] = pane;
        const group = this.tiles.filter((t) => t.iog === iog);
        this.layouts[iog] = {
          tiles: group,
          xmin: Math.min(...group.map((t) => t.x - t.pitch / 2)),
          xmax: Math.max(...group.map((t) => t.x + (t.width - 0.5) * t.pitch)),
          ymin: Math.min(...group.map((t) => t.y - t.pitch / 2)),
          ymax: Math.max(...group.map((t) => t.y + (t.height - 0.5) * t.pitch)),
        };
        this.cameras[iog] = resetCamera();
        this.bindPlane(canvas, iog, selectPixel);
      }
    }
    for (const [id, factor] of [
      ["mapIn", 1.5],
      ["mapOut", 1 / 1.5],
      ["mapFit", 0],
    ]) {
      $(id).addEventListener("click", () => {
        this.canvases.forEach((c, iog) => {
          if (c.clientWidth) this.zoomAt(iog, factor, 0.5, 0.5);
        });
        this.paint();
      });
    }
    $("mapFill").addEventListener("click", () => {
      const iog = this.filtered || this.focused;
      if (!iog) return;
      const r = this.canvases[iog].getBoundingClientRect();
      const { xmin, xmax, ymin, ymax } = this.layouts[iog];
      const sx = (r.width - 6) / (xmax - xmin);
      const sy = (r.height - 6) / (ymax - ymin);
      this.cameras[iog] = resetCamera();
      this.zoomAt(iog, Math.max(sx, sy) / Math.min(sx, sy), 0.5, 0.5);
      this.paint();
    });
    $("scale").addEventListener("change", () => {
      const state = this.scaleState();
      const [lo, hi] = this.range();
      state.mode = $("scale").value;
      if (state.mode === "custom" && !state.range) {
        state.range = [lo, hi > lo ? hi : lo + 1];
      }
      this.syncScaleControls();
      this.recolor();
    });
    for (const id of ["scaleMin", "scaleMax"]) {
      $(id).addEventListener("input", () => {
        const lo = $("scaleMin").valueAsNumber,
          hi = $("scaleMax").valueAsNumber;
        const valid = Number.isFinite(lo) && Number.isFinite(hi) && lo < hi;
        $("scaleMax").setCustomValidity(
          valid ? "" : "Maximum must be greater than minimum.",
        );
        if (valid) {
          this.scaleState().range = [lo, hi];
          this.recolor();
        }
      });
      $(id).addEventListener("change", () => {
        if (!$("scaleMin").reportValidity()) return;
        $("scaleMax").reportValidity();
      });
    }
    this.observer = new ResizeObserver(() => this.paint());
    this.canvases.forEach((c) => this.observer.observe(c));
  }
  bindPlane(canvas, iog, selectPixel) {
    let drag = null,
      moved = false,
      clickTimer;
    const position = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    };
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (this.onRegion) return;
        const delta =
          e.deltaY *
          (e.deltaMode === 1
            ? 16
            : e.deltaMode === 2
              ? canvas.clientHeight
              : 1);
        this.zoomAt(
          iog,
          Math.exp(-clamp(delta, -400, 400) * 0.0025),
          ...position(e),
        );
        this.hover = { iog, clientX: e.clientX, clientY: e.clientY };
        this.paint();
      },
      { passive: false },
    );
    canvas.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      moved = false;
      drag = {
        x: e.clientX,
        y: e.clientY,
        camera: { ...this.cameras[iog] },
        selecting: !!this.onRegion,
      };
      if (drag.selecting) this.draftRegion = null;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!e.isPrimary) return;
      this.hover = { iog, clientX: e.clientX, clientY: e.clientY };
      if (drag?.selecting) {
        if (this.onRegion) {
          this.draftRegion = this.pixelRegion(iog, drag, e);
          this.paint();
        }
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x,
          dy = e.clientY - drag.y;
        moved ||= Math.hypot(dx, dy) > 4;
        if (moved) {
          this.cameras[iog].x = drag.camera.x + dx / canvas.clientWidth;
          this.cameras[iog].y = drag.camera.y + dy / canvas.clientHeight;
          canvas.classList.add("panning");
          this.paint();
          return;
        }
      }
      this.readPixel();
    });
    const end = () => {
      drag = null;
      canvas.classList.remove("panning");
    };
    canvas.addEventListener("pointerup", (e) => {
      if (!e.isPrimary || !drag?.selecting) return;
      moved = true;
      if (this.onRegion) {
        const region = this.pixelRegion(iog, drag, e);
        this.draftRegion = null;
        if (region.boxes.length) this.onRegion(region);
        else this.paint();
      }
    });
    canvas.addEventListener("lostpointercapture", () => {
      if (this.draftRegion) {
        this.draftRegion = null;
        this.paint();
      }
      end();
    });
    canvas.addEventListener("pointercancel", () => {
      moved = true;
      end();
    });
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.readPixel();
    });
    canvas.addEventListener("click", (e) => {
      clearTimeout(clickTimer);
      if (moved || e.detail > 1) return;
      const id = this.underPointer(e, canvas, iog);
      if (id !== null) clickTimer = setTimeout(() => selectPixel(id), 300);
    });
    canvas.addEventListener("dblclick", () => {
      clearTimeout(clickTimer);
      if (!moved && !this.onRegion) this.expand(iog);
    });
  }
  pixelRegion(iog, start, end) {
    const canvas = this.canvases[iog].getBoundingClientRect();
    const x = (value) => clamp(value - canvas.left, 0, canvas.width);
    const y = (value) => clamp(value - canvas.top, 0, canvas.height);
    const boxes = [];
    for (const t of this.layouts[iog].tiles) {
      const r = t.rect;
      if (!r) continue;
      const col = (px) => ((px - r.x) * t.width) / r.w;
      const row = (py) => ((py - r.y) * t.height) / r.h;
      const x0 = Math.max(
        0,
        Math.floor(col(x(Math.min(start.x, end.clientX)))),
      );
      const x1 = Math.min(
        t.width,
        1 + Math.floor(col(x(Math.max(start.x, end.clientX)))),
      );
      const y0 = Math.max(
        0,
        Math.floor(row(y(Math.min(start.y, end.clientY)))),
      );
      const y1 = Math.min(
        t.height,
        1 + Math.floor(row(y(Math.max(start.y, end.clientY)))),
      );
      if (x0 < x1 && y0 < y1) boxes.push([t.tile, x0, y0, x1, y1]);
    }
    return { iog, boxes };
  }
  setRegion(region, onRegion = null) {
    this.region = region;
    this.onRegion = onRegion;
    this.draftRegion = null;
    this.paint();
  }
  zoomAt(iog, factor, x, y) {
    const cam = this.cameras[iog];
    const zoom = clamp(cam.zoom * factor, 1, 32);
    this.panes[iog].querySelector(".zoom-value").textContent =
      zoom === 1 ? "" : zoom.toFixed(1).replace(/\.0$/, "") + "×";
    if (zoom === 1) {
      this.cameras[iog] = resetCamera();
      return;
    }
    const ratio = zoom / cam.zoom;
    cam.x = (x - 0.5) * (1 - ratio) + cam.x * ratio;
    cam.y = (y - 0.5) * (1 - ratio) + cam.y * ratio;
    cam.zoom = zoom;
  }
  readPixel() {
    const h = this.hover;
    const id = h ? this.underPointer(h, this.canvases[h.iog], h.iog) : null;
    let text = "Hover a pixel for its address";
    if (id !== null) {
      const t = this.tiles[this.tileOf[id]];
      const addr = this.addresses.getUint16(
        2 * (t.address_start + id - t.start),
        true,
      );
      text =
        "IOG " +
        t.iog +
        " · Tile " +
        t.tile +
        (addr === 65535
          ? " · Unmapped pixel"
          : " · Chip " + (addr >> 6) + " · Channel " + (addr & 63));
      if (this.active[id]) {
        if (!this.count[id]) text += "  |  Held";
        else {
          text +=
            "  |  " +
            format(this.count[id]) +
            (this.count[id] === 1 ? " packet" : " packets");
          if (!["occupancy", "count"].includes(this.field))
            text += " · " + format(this.value[id]) + (units[this.field] || "");
        }
      }
    }
    if ($("pixelReadout").textContent !== text)
      $("pixelReadout").textContent = text;
  }
  underPointer(e, canvas, iog) {
    const rect = canvas.getBoundingClientRect(),
      x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    const t = this.layouts[iog].tiles.find(
      (t) =>
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
    this.filtered = iog;
    this.focused = 0;
    this.layout();
  }
  expand(iog) {
    if (this.filtered) return;
    this.focused = this.focused === iog ? 0 : iog;
    this.layout();
  }
  layout() {
    const iog = this.filtered || this.focused;
    this.hover = null;
    this.panes.forEach((p, i) => {
      const button = p.querySelector("button");
      button.disabled = !!this.filtered;
      button.setAttribute("aria-pressed", String(i === this.focused));
      button.setAttribute(
        "aria-label",
        i === this.focused ? "Show all planes" : "Expand IOG " + i,
      );
      button.title = this.filtered
        ? "Plane selected in the Planes filter"
        : button.getAttribute("aria-label");
    });
    this.modules.forEach(
      (m, i) => (m.hidden = !!iog && Math.floor((iog - 1) / 2) !== i),
    );
    this.panes.forEach((p, i) => (p.hidden = !!iog && iog !== i));
    $("modules").classList.toggle("focus", !!iog);
    $("mapFill").hidden = !iog;
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
      peak = -Infinity,
      low = Infinity;
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
        low = Math.min(low, v);
      }
    }
    const previous = this.scaleKey();
    this.field = field;
    this.stat = stat;
    this.showHeld = heldTicks > width;
    this.extent = nCurrent ? [low, peak] : null;
    $("mapSummary").textContent =
      nPacket.toLocaleString() +
      " packets · " +
      nCurrent.toLocaleString() +
      " active pixels" +
      (heldTicks > width
        ? " · " + (n - nCurrent).toLocaleString() + " held"
        : "");
    if (previous !== this.scaleKey()) this.syncScaleControls();
    this.recolor();
  }
  scaleKey() {
    return this.field + (this.stat === "full_fraction" ? ":fraction" : "");
  }
  scaleState() {
    const key = this.scaleKey();
    if (!this.scaleByField.has(key))
      this.scaleByField.set(key, { mode: "full", range: null });
    return this.scaleByField.get(key);
  }
  syncScaleControls() {
    const state = this.scaleState();
    $("scaleTools").hidden = this.field === "occupancy";
    $("scale").value = state.mode;
    $("limits").hidden = state.mode !== "custom";
    $("scaleMax").setCustomValidity("");
    if (state.range) {
      $("scaleMin").value = state.range[0];
      $("scaleMax").value = state.range[1];
    }
  }
  range() {
    const { mode, range } = this.scaleState();
    if (mode === "custom" && range) return range;
    if (mode === "window" && this.extent) return this.extent;
    return [
      0,
      this.stat === "full_fraction"
        ? 1
        : (fixedMax[this.field] ?? this.extent?.[1] ?? 1),
    ];
  }
  recolor() {
    const field = this.field,
      [min, max] = this.range();
    const light = document.documentElement.dataset.theme === "light";
    const occupied = light ? [0, 108, 123] : [86, 210, 202];
    const held = light ? [119, 131, 151] : [109, 125, 148];
    for (const id of this.ids) {
      const t = this.tiles[this.tileOf[id]],
        k = (id - t.start) * 4;
      const rgb = !this.count[id]
        ? held
        : field === "occupancy"
          ? occupied
          : palette[
              max === min
                ? 128
                : Math.round(
                    255 * clamp((this.value[id] - min) / (max - min), 0, 1),
                  )
            ];
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
    const legend = $("legend");
    legend.replaceChildren();
    if (field === "occupancy")
      legend.append(el("i", "dot"), document.createTextNode("In window"));
    else if (this.scaleState().mode === "window" && !this.extent)
      legend.append("No active values");
    else if (max === min) {
      const swatch = el("i", "dot");
      swatch.style.background = "rgb(" + palette[128] + ")";
      legend.append(swatch, format(min) + (units[field] || ""));
    } else
      legend.append(
        document.createTextNode(format(min)),
        el("i", "ramp"),
        document.createTextNode(format(max) + (units[field] || "")),
      );
    if (this.showHeld)
      legend.append(el("i", "held"), document.createTextNode("Held"));
    this.paint();
  }
  paint() {
    const style = getComputedStyle(document.documentElement);
    const tileColor = style.getPropertyValue("--tile"),
      lineColor = style.getPropertyValue("--tile-line"),
      labelColor = style.getPropertyValue("--muted");
    this.canvases.forEach((c, g) => {
      if (!c.clientWidth) return;
      const { ctx, w, h } = fit(c);
      const { tiles, xmin, xmax, ymin, ymax } = this.layouts[g];
      const cam = this.cameras[g];
      const s =
        Math.min((w - 6) / (xmax - xmin), (h - 6) / (ymax - ymin)) * cam.zoom;
      const limitX = ((xmax - xmin) * s * (1 - 1 / cam.zoom)) / (2 * w);
      const limitY = ((ymax - ymin) * s * (1 - 1 / cam.zoom)) / (2 * h);
      cam.x = clamp(cam.x, -limitX, limitX);
      cam.y = clamp(cam.y, -limitY, limitY);
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      for (const t of tiles) {
        const x =
            cam.x * w +
            (w - (xmax - xmin) * s) / 2 +
            (t.x - t.pitch / 2 - xmin) * s,
          y =
            cam.y * h +
            (h - (ymax - ymin) * s) / 2 +
            (ymax - t.y - (t.height - 0.5) * t.pitch) * s;
        const tw = t.width * t.pitch * s,
          th = t.height * t.pitch * s;
        t.rect = { x, y, w: tw, h: th };
        ctx.fillStyle = tileColor;
        ctx.fillRect(x, y, tw, th);
        ctx.drawImage(t.raster, x, y, tw, th);
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 0.75;
        ctx.strokeRect(x, y, tw, th);
        if (tw > 22) {
          ctx.fillStyle = labelColor;
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
    const region = this.draftRegion || this.region;
    if (region?.boxes && !this.panes[region.iog].hidden) {
      const ctx = this.canvases[region.iog].getContext("2d");
      ctx.save();
      ctx.strokeStyle = style.getPropertyValue("--mint");
      ctx.lineWidth = 1.75;
      ctx.setLineDash([5, 3]);
      for (const [tile, x0, y0, x1, y1] of region.boxes) {
        const t = this.layouts[region.iog].tiles.find((t) => t.tile === tile);
        if (!t.rect) continue;
        const { x, y, w, h } = t.rect;
        ctx.strokeRect(
          x + (w * x0) / t.width,
          y + (h * y0) / t.height,
          (w * (x1 - x0)) / t.width,
          (h * (y1 - y0)) / t.height,
        );
      }
      ctx.restore();
    }
    this.readPixel();
  }
}
