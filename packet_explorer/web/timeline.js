import { fit, showTip } from "./detector.js";
const $ = (id) => document.getElementById(id);
const L = 96,
  R = 12;
export function duration(ticks) {
  const n = Math.abs(ticks),
    unit =
      n >= 1e7
        ? [1e7, "s"]
        : n >= 1e4
          ? [1e4, "ms"]
          : n >= 10
            ? [10, "µs"]
            : [1, "ticks"];
  return (
    (ticks / unit[0]).toLocaleString(undefined, { maximumFractionDigits: 3 }) +
    " " +
    unit[1]
  );
}
const short = (n) =>
  n >= 1e6
    ? (n / 1e6).toFixed(1) + "M"
    : n >= 1e3
      ? (n / 1e3).toFixed(1) + "k"
      : n.toFixed(0);
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const tint = (name) =>
  name === "SYNC 83"
    ? "#f3c077"
    : name.startsWith("SYNC")
      ? "#a69fe4"
      : name.includes("IOG 5")
        ? "#6ddbb9"
        : "#78aafb";

export class Timelines {
  constructor(state, seek, zoom, marker) {
    this.s = state;
    this.seek = seek;
    this.zoom = zoom;
    this.marker = marker;
    this.rate = $("rates");
    this.marks = $("markers");
    this.over = $("overview");
    this.rects = [];
    this.resize = new ResizeObserver(() => this.draw());
    for (const c of [this.rate, this.marks, this.over]) {
      this.resize.observe(c);
      c.addEventListener("pointerdown", (e) => {
        if (!this.s.view || e.button !== 0) return;
        this.drag = {
          c,
          id: e.pointerId,
          x: this.x(c, e),
          start: this.at(c, e),
          end: this.at(c, e),
        };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener("pointermove", (e) => {
        if (!this.s.view) return;
        if (this.drag && this.drag.c === c) {
          this.drag.end = this.at(c, e);
          this.draw();
          return;
        }
        const t = this.at(c, e),
          mark = this.pick(e);
        if (c === this.marks && mark) {
          showTip(
            e,
            mark.name +
              " · IOG " +
              mark.p[5] +
              "\nTick " +
              mark.p[2].toLocaleString() +
              " · " +
              mark.p[1] +
              " marker(s) in bin",
          );
        } else if (c === this.rate && this.detail) {
          const d = this.detail,
            i = clamp(
              Math.floor(
                ((t - d.edges[0]) / (d.edges.at(-1) - d.edges[0])) *
                  (d.edges.length - 1),
              ),
              0,
              d.edges.length - 2,
            );
          const n = d.counts.reduce((sum, a) => sum + a[i], 0);
          showTip(
            e,
            n.toLocaleString() +
              " packets / " +
              duration(d.edges[i + 1] - d.edges[i]) +
              "\n" +
              short((n * 1e7) / (d.edges[i + 1] - d.edges[i])) +
              " Hz" +
              (d.chips ? " · " + d.chips[i] + " active chips" : ""),
          );
        } else showTip(e, "Tick " + t.toLocaleString() + " · " + duration(t));
      });
      c.addEventListener("pointerup", (e) => {
        const a = this.drag;
        if (!a || a.c !== c) return;
        this.drag = null;
        showTip(e, "");
        const t = this.at(c, e);
        if (Math.abs(this.x(c, e) - a.x) > 4)
          this.zoom(Math.min(t, a.start), Math.max(t, a.start) + 1);
        else if (c === this.marks && this.pick(e)) {
          const m = this.pick(e);
          this.marker(m);
        } else this.seek(t);
        this.draw();
      });
      c.addEventListener("pointercancel", () => {
        this.drag = null;
        this.draw();
      });
      c.addEventListener("pointerleave", (e) => showTip(e, ""));
      c.addEventListener("dblclick", () => {
        if (this.s.view) this.zoom(0, this.s.view.length);
      });
    }
  }
  x(c, e) {
    return e.clientX - c.getBoundingClientRect().left;
  }
  axis(c) {
    const whole = c === this.over,
      s = this.s;
    return {
      lo: whole ? 0 : s.lo,
      hi: whole ? s.view.length : s.hi,
      left: whole ? 0 : L,
      right: c.clientWidth - (whole ? 0 : R),
    };
  }
  at(c, e) {
    const { lo, hi, left, right } = this.axis(c);
    return clamp(
      lo + Math.floor(((this.x(c, e) - left) / (right - left)) * (hi - lo)),
      lo,
      hi - 1,
    );
  }
  pick(e) {
    if (e.currentTarget !== this.marks) return null;
    const box = this.marks.getBoundingClientRect(),
      x = e.clientX - box.left,
      y = e.clientY - box.top;
    return this.rects
      .filter((r) => Math.abs(r.x - x) <= 6 && Math.abs(r.y - y) <= 8)
      .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
  }
  frame(c) {
    const { ctx, w, h } = fit(c),
      { lo, hi, left, right } = this.axis(c);
    const xpos = (t) => left + ((t - lo) / (hi - lo)) * (right - left);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "#101824";
    ctx.fillRect(left, 0, right - left, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, right - left, h);
    ctx.clip();
    for (const [a, b] of this.s.view.gaps) {
      if (a < hi && b > lo) {
        ctx.fillStyle = "#554634";
        ctx.fillRect(xpos(a), 0, Math.max(1, xpos(b) - xpos(a)), h);
      }
    }
    const files = new Map();
    for (const v of this.s.view.coverage) {
      files.set(v.file, Math.min(files.get(v.file) ?? Infinity, v.lo));
    }
    ctx.strokeStyle = "#536075";
    ctx.setLineDash([3, 4]);
    for (const a of files.values()) {
      if (a > lo && a < hi) {
        ctx.beginPath();
        ctx.moveTo(xpos(a), 0);
        ctx.lineTo(xpos(a), h);
        ctx.stroke();
      }
    }
    ctx.restore();
    return { ctx, w, h, left, right, xpos, lo, hi };
  }
  overlay(c, f) {
    const { ctx, h, left, right, xpos } = f,
      s = this.s;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, right - left, h);
    ctx.clip();
    const stay = (a, b, color) => {
      ctx.fillStyle = color;
      const x = xpos(a),
        x2 = xpos(b);
      if (x2 >= left && x <= right) ctx.fillRect(x, 0, Math.max(1, x2 - x), h);
    };
    if (c === this.over) {
      stay(s.lo, s.hi, "#70a9dc33");
      ctx.strokeStyle = "#82a2c3";
      ctx.strokeRect(xpos(s.lo), 1, xpos(s.hi) - xpos(s.lo), h - 2);
    }
    if (s.hold > s.width)
      stay(
        Math.max(0, s.t + 1 - s.hold),
        Math.max(0, s.t + 1 - s.width),
        "#9caac424",
      );
    stay(Math.max(0, s.t + 1 - s.width), s.t + 1, "#65dfbd33");
    const x = xpos(s.t);
    ctx.fillStyle = "#a5f4d9";
    ctx.fillRect(x, 0, 1.5, h);
    if (this.drag && this.drag.c === c)
      stay(
        Math.min(this.drag.start, this.drag.end),
        Math.max(this.drag.start, this.drag.end) + 1,
        "#81a8e95c",
      );
    ctx.restore();
  }
  draw() {
    if (!this.s.view) return;
    const data = this.detail,
      lanes = data ? Object.entries(data.lanes) : [];
    const markH = Math.max(45, lanes.length * 18 + 10);
    if (this.marks.style.height !== markH + "px")
      this.marks.style.height = markH + "px";
    const m = this.frame(this.marks);
    this.rects = [];
    if (!lanes.length) {
      m.ctx.fillStyle = "#a2b1c5";
      m.ctx.fillText("No markers in this interval", m.left + 6, 22);
    }
    lanes.forEach(([name, points], row) => {
      const y = 14 + 18 * row,
        ctx = m.ctx;
      ctx.fillStyle = "#b6c4d4";
      ctx.fillText(name, 12, y + 3);
      ctx.strokeStyle = "#243347";
      ctx.beginPath();
      ctx.moveTo(m.left, y);
      ctx.lineTo(m.right, y);
      ctx.stroke();
      ctx.fillStyle = tint(name);
      for (const p of points) {
        const x = m.xpos(p[2]);
        if (x < m.left || x > m.right) continue;
        ctx.fillRect(x - 1, y - 5, p[1] > 1 ? 3 : 2, 10);
        this.rects.push({ name, p, x, y });
      }
    });
    this.overlay(this.marks, m);
    this.chart(this.rate, data);
    this.chart(this.over, this.full);
  }
  chart(canvas, data) {
    const f = this.frame(canvas),
      { ctx, w, h, left, right, xpos, lo, hi } = f,
      mini = canvas === this.over;
    if (!data) {
      this.overlay(canvas, f);
      return;
    }
    const top = mini ? 2 : 10,
      bottom = mini ? h - 2 : h - 21;
    const rates = data.edges
      .slice(0, -1)
      .map(
        (t, i) =>
          (data.counts.reduce((n, a) => n + a[i], 0) * 1e7) /
          (data.edges[i + 1] - t),
      );
    const max = Math.max(1, ...rates);
    if (!mini) {
      for (const v of [0, 0.5, 1]) {
        const y = bottom - v * (bottom - top);
        ctx.fillStyle = "#96a7bd";
        ctx.fillText(short(v * max) + " Hz", 12, y + 3);
        ctx.strokeStyle = "#273547";
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, right - left, h);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(xpos(data.edges[0]), bottom);
    rates.forEach((v, i) => {
      const y = bottom - ((bottom - top) * v) / max;
      ctx.lineTo(xpos(data.edges[i]), y);
      ctx.lineTo(xpos(data.edges[i + 1]), y);
    });
    ctx.lineTo(xpos(data.edges.at(-1)), bottom);
    ctx.closePath();
    ctx.fillStyle = "#36598180";
    ctx.fill();
    ctx.strokeStyle = "#86b2f4";
    ctx.lineWidth = mini ? 1 : 1.25;
    ctx.stroke();
    if (data.chips && !mini) {
      const peak = Math.max(1, ...data.chips);
      ctx.beginPath();
      data.chips.forEach((v, i) => {
        const x = xpos((data.edges[i] + data.edges[i + 1]) / 2),
          y = bottom - (v / peak) * (bottom - top);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = "#edbd73";
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillStyle = "#efc786";
      ctx.fillText("chips/bin · max " + peak, right - 5, top + 6);
    }
    ctx.restore();
    if (!mini) {
      ctx.fillStyle = "#9aadc3";
      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        const x = left + frac * (right - left);
        ctx.textAlign = frac === 0 ? "left" : frac === 1 ? "right" : "center";
        const tick = lo + Math.round(frac * (hi - lo));
        ctx.fillText(
          hi - lo < 10000 ? tick.toLocaleString() + " t" : duration(tick),
          x,
          h - 4,
        );
      }
      ctx.textAlign = "left";
    }
    this.overlay(canvas, f);
  }
}
