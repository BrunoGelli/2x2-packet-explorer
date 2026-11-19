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
      : n > 0 && n < 1
        ? n.toLocaleString(undefined, { maximumSignificantDigits: 3 })
        : n.toFixed(0);
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
function rateAxis(rates, logarithmic) {
  if (!logarithmic) {
    const max = Math.max(1, ...rates);
    return { ticks: [0, max / 2, max], fraction: (hz) => hz / max };
  }
  const positive = rates.filter((hz) => hz > 0);
  if (!positive.length) return { ticks: [], fraction: () => 0 };
  const upper = Math.ceil(Math.log10(Math.max(...positive)));
  const lower = Math.min(
    upper - 1,
    Math.floor(Math.log10(Math.min(...positive))),
  );
  const decades = upper - lower;
  const intervals = Math.min(4, decades);
  const ticks = Array.from(
    { length: intervals + 1 },
    (_, i) => 10 ** (lower + Math.round((i * decades) / intervals)),
  );
  return { ticks, fraction: (hz) => (Math.log10(hz) - lower) / decades };
}
const tint = (name, colors) =>
  name === "SYNC 83"
    ? colors.amber
    : name.startsWith("SYNC")
      ? colors.violet
      : name.includes("IOG 5")
        ? colors.mint
        : colors.blue;

export class Timelines {
  constructor(state, seek, zoom, marker) {
    this.s = state;
    this.seek = seek;
    this.zoom = zoom;
    this.marker = marker;
    this.rate = $("rates");
    this.marks = $("markers");
    this.over = $("overview");
    this.scale = $("rateScale");
    this.scale.addEventListener("change", () => this.draw());
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
    ctx.fillStyle = this.colors.inside;
    ctx.fillRect(left, 0, right - left, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, right - left, h);
    ctx.clip();
    for (const [a, b] of this.s.view.gaps) {
      if (a < hi && b > lo) {
        ctx.fillStyle = this.colors.gap;
        ctx.fillRect(xpos(a), 0, Math.max(1, xpos(b) - xpos(a)), h);
      }
    }
    const files = new Map();
    for (const v of this.s.view.coverage) {
      files.set(v.file, Math.min(files.get(v.file) ?? Infinity, v.lo));
    }
    ctx.strokeStyle = this.colors.lineStrong;
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
      ctx.strokeStyle = this.colors.blue;
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
    ctx.fillStyle = this.colors.mint;
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
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue("--" + name).trim();
    this.colors = {
      inside: color("inside"),
      gap: color("gap"),
      lineStrong: color("line-strong"),
      blue: color("blue"),
      mint: color("mint"),
      muted: color("muted"),
      line: color("line"),
      rateFill: color("rate-fill"),
      amber: color("amber"),
      violet: color("violet"),
    };
    const data = this.detail,
      lanes = data ? Object.entries(data.lanes) : [];
    const markH = Math.max(45, lanes.length * 18 + 10);
    if (this.marks.style.height !== markH + "px")
      this.marks.style.height = markH + "px";
    const m = this.frame(this.marks);
    this.rects = [];
    if (!lanes.length) {
      m.ctx.fillStyle = this.colors.muted;
      m.ctx.fillText("No markers in this interval", m.left + 6, 22);
    }
    lanes.forEach(([name, points], row) => {
      const y = 14 + 18 * row,
        ctx = m.ctx;
      ctx.fillStyle = this.colors.muted;
      ctx.fillText(name, 12, y + 3);
      ctx.strokeStyle = this.colors.line;
      ctx.beginPath();
      ctx.moveTo(m.left, y);
      ctx.lineTo(m.right, y);
      ctx.stroke();
      ctx.fillStyle = tint(name, this.colors);
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
    const logarithmic = this.scale.value === "log";
    const axis = rateAxis(rates, logarithmic);
    const ypos = (hz) => bottom - axis.fraction(hz) * (bottom - top);
    if (!mini) {
      if (!axis.ticks.length) {
        ctx.fillStyle = this.colors.muted;
        ctx.fillText("No packets in this interval", left + 6, top + 12);
      }
      for (const hz of axis.ticks) {
        const y = ypos(hz);
        ctx.fillStyle = this.colors.muted;
        ctx.fillText(short(hz) + " Hz", 12, y + 3);
        ctx.strokeStyle = this.colors.line;
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
    // Each uninterrupted sequence of positive bins forms its own filled
    // step on a log axis. Empty intervals have no logarithmic ordinate.
    rates.forEach((hz, i) => {
      if (logarithmic && hz === 0) return;
      const x1 = xpos(data.edges[i]),
        x2 = xpos(data.edges[i + 1]);
      const y = ypos(hz);
      if (i === 0 || (logarithmic && rates[i - 1] === 0))
        ctx.moveTo(x1, bottom);
      ctx.lineTo(x1, y);
      ctx.lineTo(x2, y);
      if (i === rates.length - 1 || (logarithmic && rates[i + 1] === 0)) {
        ctx.lineTo(x2, bottom);
        ctx.closePath();
      }
    });
    ctx.fillStyle = this.colors.rateFill;
    ctx.fill();
    ctx.strokeStyle = this.colors.blue;
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
      ctx.strokeStyle = this.colors.amber;
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillStyle = this.colors.amber;
      ctx.fillText(
        (logarithmic ? "chips/bin (linear)" : "chips/bin") + " · max " + peak,
        right - 5,
        top + 6,
      );
    }
    ctx.restore();
    if (!mini) {
      ctx.fillStyle = this.colors.muted;
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
