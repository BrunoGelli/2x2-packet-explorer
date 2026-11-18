import { Histogram } from "./histogram.js";
import { Detector } from "./detector.js";
import { Timelines, duration } from "./timeline.js";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString();
const opt = (value, text) => new Option(text, value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const s = {
  job: null,
  session: null,
  scope: "aligned",
  view: null,
  lo: 0,
  hi: 1,
  t: 0,
  width: 10000,
  step: 10000,
  hold: 0,
  iog: 0,
  field: "occupancy",
  stat: "last",
  selection: new Set(),
  running: false,
  pixel: null,
  raw: false,
  offset: 0,
  rawFile: 0,
};
let detector,
  histogram,
  timelines,
  root,
  dir = ".",
  parent = null,
  listed = [],
  folders = [],
  pollId = 0,
  viewId = 0,
  insId = 0,
  chartId = 0,
  mapId = 0,
  playId = 0,
  catalogId = 0;
const activeRequests = new Map();
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("key")) {
  sessionStorage.setItem("packet-explorer-key", fragment.get("key"));
  history.replaceState(null, "", location.pathname + location.search);
}
const accessKey = sessionStorage.getItem("packet-explorer-key") || "";
function notice(msg = "", error = false) {
  $("notice").hidden = !msg;
  $("notice").textContent = msg;
  $("notice").classList.toggle("error", error);
}
async function request(name, params = {}, options = {}) {
  const url = new URL("api/" + name, document.baseURI);
  for (const [key, val] of Object.entries(params))
    if (val !== undefined) url.searchParams.set(key, val);
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, "X-Packet-Explorer-Key": accessKey },
    cache: "no-store",
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw Error(e.error || "HTTP " + res.status);
  }
  return res.headers.get("Content-Type") === "application/octet-stream"
    ? res.arrayBuffer()
    : res.json();
}
const query = (name, p = {}, opts = {}) =>
  request(name, { job: s.job, scope: s.scope, iog: s.iog, ...p }, opts);
function replaceRequest(key) {
  activeRequests.get(key)?.abort();
  const ctrl = new AbortController();
  activeRequests.set(key, ctrl);
  return ctrl.signal;
}
function report(e) {
  if (e.name !== "AbortError") notice(e.message || String(e), true);
}
function bound(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function pause() {
  s.running = false;
  playId++;
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play");
}
function drawTime() {
  if (!s.view) return;
  if (document.activeElement !== $("tick")) $("tick").value = String(s.t);
  const base = duration(s.t);
  if (s.scope === "aligned") {
    const ticks = BigInt(s.view.origin) + BigInt(s.t);
    const stamp = new Date(Number(ticks / 10000n)).toISOString();
    $("clock").textContent = stamp.slice(11, 23) + " UTC est. · +" + base;
    $("clock").title = stamp + " · PPS/header-labelled estimate";
  } else $("clock").textContent = "Local IOG time · +" + base;
  $("viewport").textContent =
    duration(s.hi - s.lo) +
    " visible · ticks " +
    fmt(s.lo) +
    " – " +
    fmt(s.hi - 1);
}
async function map() {
  if (!s.view) return;
  const version = ++mapId;
  const data = await query(
    "map",
    { t: s.t, width: s.width, hold: s.hold, field: s.field, stat: s.stat },
    { signal: replaceRequest("map") },
  );
  if (version !== mapId) return;
  detector.set(data, s.field, s.stat, s.hold, s.width);
  drawTime();
  timelines.draw();
  await histogram.setFrame({
    job: s.job,
    scope: s.scope,
    lo: Math.max(0, s.t + 1 - s.width),
    hi: s.t + 1,
  });
}
async function charts(resetFull = false) {
  if (!s.view) return;
  const version = ++chartId,
    signal = replaceRequest("chart"),
    len = s.view.length;
  const bins = bound(Math.floor(($("rates").clientWidth - 96) / 1.7), 80, 900),
    chips = $("chips").checked ? 1 : 0;
  const fullParams = { lo: 0, hi: len, bins, chips };
  const whole = s.lo === 0 && s.hi === len;
  const fullPromise =
    resetFull || !timelines.full
      ? query("timeline", fullParams, { signal })
      : Promise.resolve(timelines.full);
  const detailPromise = whole
    ? fullPromise
    : query("timeline", { lo: s.lo, hi: s.hi, bins, chips }, { signal });
  const [full, detail] = await Promise.all([fullPromise, detailPromise]);
  if (version !== chartId) return;
  timelines.detail = detail;
  timelines.full = full;
  timelines.draw();
  drawTime();
}
async function seek(t, follow = true) {
  if (!s.view || !Number.isSafeInteger(t)) return;
  s.t = bound(t, 0, s.view.length - 1);
  if (follow && (s.t < s.lo || s.t >= s.hi)) {
    const span = s.hi - s.lo;
    s.lo = bound(s.t - Math.floor(span / 2), 0, s.view.length - span);
    s.hi = s.lo + span;
    charts().catch(report);
  }
  drawTime();
  timelines.draw();
  if ($("inspect").open && !s.raw) {
    s.offset = 0;
    inspect().catch(report);
  }
  await map();
}
function userSeek(t) {
  pause();
  seek(t).catch(report);
}
function zoom(lo, hi) {
  if (!s.view) return;
  pause();
  s.lo = bound(Math.floor(lo), 0, s.view.length - 1);
  s.hi = bound(Math.ceil(hi), s.lo + 1, s.view.length);
  if (s.t < s.lo || s.t >= s.hi) seek(s.lo, false).catch(report);
  else {
    drawTime();
    timelines.draw();
  }
  charts().catch(report);
}
function changeZoom(factor) {
  if (!s.view) return;
  const n = bound(Math.round((s.hi - s.lo) * factor), 1, s.view.length),
    center = s.t >= s.lo && s.t < s.hi ? s.t : Math.floor((s.lo + s.hi) / 2);
  const a = bound(center - Math.floor(n / 2), 0, s.view.length - n);
  zoom(a, a + n);
}
async function nearest(direction, start = s.t) {
  if (!s.view) return;
  pause();
  const v = viewId,
    t = s.t;
  const { tick } = await query("next", { t: start, direction });
  if (v !== viewId || s.t !== t) return;
  if (tick !== null) await seek(tick);
  else notice("No further occupied ticks in this clock view.");
}
async function peak() {
  const d = timelines.detail;
  if (!d || !s.view) return;
  let best = -1,
    top = 0;
  for (let i = 0; i < d.edges.length - 1; i++) {
    const n =
      d.counts.reduce((a, v) => a + v[i], 0) / (d.edges[i + 1] - d.edges[i]);
    if (n > top) {
      best = i;
      top = n;
    }
  }
  if (best < 0) {
    notice("This interval has no mapped charge packets.");
    return;
  }
  await nearest(1, d.edges[best] - 1);
}
async function playback() {
  if (s.running) {
    pause();
    return;
  }
  if (!s.view) return;
  const id = ++playId;
  s.running = true;
  $("play").textContent = "Ⅱ";
  $("play").setAttribute("aria-label", "Pause");
  const [mode, f] = $("speed").value.split(":"),
    rate = Number(f),
    start = performance.now(),
    initial = s.t;
  try {
    while (id === playId && s.running) {
      const frame = performance.now();
      let t;
      if (mode === "step") t = s.t + s.step;
      else
        t =
          initial +
          Math.floor(((frame - start) * 10000 * rate) / s.step) * s.step;
      if (t !== s.t) await seek(Math.min(t, s.view.length - 1));
      if (id !== playId || s.t >= s.view.length - 1) break;
      await sleep(
        Math.max(
          0,
          (mode === "step" ? 1000 / rate : 40) - (performance.now() - frame),
        ),
      );
    }
  } finally {
    if (id === playId) pause();
  }
}
const fields = {
  occupancy: null,
  count: null,
  rate: null,
  first_hit: null,
  adc: 256,
  local_fifo: 4,
  shared_fifo: 4,
  trigger_type: 4,
  first_packet: 2,
  downstream_marker: 2,
};
function stats() {
  s.field = $("field").value;
  const select = $("stat"),
    old = select.value;
  const options =
    fields[s.field] === null
      ? [["last", "—"]]
      : [
          ["last", "Latest"],
          ["mean", "Mean"],
          ["median", "Median"],
          ["min", "Minimum"],
          ["max", "Maximum"],
        ];
  if (["local_fifo", "shared_fifo"].includes(s.field))
    options.push(["full_fraction", "Fraction full"]);
  select.replaceChildren(...options.map(([v, t]) => opt(v, t)));
  if (options.some(([v]) => v === old)) select.value = old;
  select.disabled = fields[s.field] === null;
  s.stat = select.value;
}
function readDuration(key) {
  const raw = Number($(key).value),
    n = Math.round(raw * Number($(key + "Unit").value));
  if (!Number.isSafeInteger(n) || n < (key === "hold" ? 0 : 1))
    throw Error("Enter a valid " + key + " in whole detector ticks.");
  s[key] = n;
}
function putDuration(key, n) {
  let unit = 1;
  for (const x of [1e7, 1e4, 10])
    if (n >= x && n % x === 0) {
      unit = x;
      break;
    }
  $(key + "Unit").value = String(unit);
  $(key).value = n / unit;
  s[key] = n;
}
function displayFiles() {
  const files = s.session.files,
    matches = files.map((f) => /^packet-(\d+)-/.exec(f.name)?.[1]);
  $("run").textContent =
    matches[0] && matches.every((m) => m === matches[0])
      ? "Run " + matches[0]
      : files.length === 1
        ? files[0].name
        : "Packet selection";
  $("fileSummary").textContent =
    files.length +
    " packet file" +
    (files.length === 1 ? "" : "s") +
    " · " +
    fmt(files.reduce((a, f) => a + f.rows, 0)) +
    " source rows" +
    (s.view ? " · " + duration(s.view.length) : "");
  $("source").replaceChildren(...files.map((f, i) => opt(i, f.name)));
  const panel = $("sources");
  panel.replaceChildren();
  for (const f of files) {
    panel.append(
      node("h3", f.name, "source-title"),
      node("p", f.path + (f.config ? " · " + f.config : ""), "source-note"),
    );
    const table = node("table", ""),
      head = node("tr", "");
    for (const t of [
      "IOG",
      "Clock",
      "SYNC 83",
      "Mapped",
      "Pre-SYNC",
      "Parity",
      "Diagnostic",
      "Unmapped",
      "Bad time",
      "Unplaced markers",
    ])
      head.append(node("th", t));
    table.append(head);
    for (const [g, clock] of Object.entries(f.clocks)) {
      const c = clock.counts;
      if (!c.charge && !c.resets && !c.unplaced_markers) continue;
      const tr = node("tr", "");
      for (const v of [
        g,
        clock.epoch === null ? "Local / unqualified" : "PPS-labelled",
        c.resets,
        c.mapped,
        c.before_sync,
        c.bad_parity,
        c.diagnostic,
        c.unmapped,
        c.invalid_time,
        c.unplaced_markers,
      ])
        tr.append(node("td", typeof v === "number" ? fmt(v) : (v ?? 0)));
      table.append(tr);
    }
    const wrap = node("div", "", "table-wrap");
    wrap.append(table);
    panel.append(wrap);
  }
  const problems = files.flatMap((f) =>
    Object.values(f.clocks).filter(
      (c) => c.epoch === null && (c.counts.charge || c.counts.resets),
    ),
  );
  $("quality").textContent = problems.length
    ? problems.length + " unaligned file/IOG stream(s)"
    : "PPS/header clock estimates";
}
function scopeFilter() {
  const local = s.scope === "aligned" ? null : Number(s.scope.split("-")[1]);
  const allowed = local
    ? [local]
    : [...new Set(s.view?.coverage.map((c) => c.iog) || [])].sort(
        (a, b) => a - b,
      );
  $("iog").replaceChildren(
    ...(local ? [] : [opt(0, "All IOGs")]),
    ...allowed.map((g) => opt(g, "IOG " + g)),
  );
  s.iog = local || 0;
  $("iog").value = String(s.iog);
  detector.filter(s.iog);
  histogram.reset(s.iog);
}
async function setView(scope) {
  pause();
  const version = ++viewId;
  s.scope = scope;
  s.view = null;
  histogram.reset(0);
  s.pixel = null;
  s.offset = 0;
  s.raw = false;
  for (const key of ["map", "chart", "inspect"])
    activeRequests.get(key)?.abort();
  mapId++;
  chartId++;
  insId++;
  timelines.full = timelines.detail = null;
  const v = await query("view");
  if (version !== viewId) return;
  s.view = v;
  s.lo = 0;
  s.hi = v.length;
  s.t = 0;
  scopeFilter();
  displayFiles();
  drawTime();
  const warnings = [];
  if (v.overlaps.length)
    warnings.push(
      "Selected files overlap on an IOG. Each source row is counted once per selected file.",
    );
  if (s.scope !== "aligned") warnings.push("Local clock for one file and IOG.");
  else if (
    s.session.files.some((f) =>
      Object.values(f.clocks).some((c) => c.epoch === null && c.counts.charge),
    )
  )
    warnings.push("Unqualified IOGs are available under Clock → Local.");
  notice(warnings.join(" "));
  await charts(true);
  if (version !== viewId) return;
  // Start at a recorded hit in the busiest overview bin so the map opens on activity.
  await peak();
  if (version === viewId && s.t === 0) await seek(0);
  if ($("inspect").open) await inspect();
}
async function openFiles(paths) {
  if (!paths.length) return;
  const id = ++pollId;
  ++viewId;
  pause();
  for (const ctrl of activeRequests.values()) ctrl.abort();
  ++mapId;
  ++chartId;
  ++insId;
  s.view = null;
  histogram.reset(0);
  s.session = null;
  s.raw = false;
  s.pixel = null;
  s.offset = 0;
  timelines.detail = timelines.full = null;
  timelines.rects = [];
  for (const c of [timelines.rate, timelines.marks, timelines.over])
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
  detector.set(new ArrayBuffer(0), "occupancy", "last", 0, 1);
  $("scope").disabled = true;
  $("fileSummary").textContent = "Opening selection…";
  $("run").textContent = "Packet files";
  $("clock").textContent = "—";
  $("tick").value = "0";
  $("viewport").textContent = "—";
  $("markerNote").textContent = "Click to seek · drag to zoom";
  $("quality").textContent = "";
  $("tbody").replaceChildren();
  $("sources").replaceChildren();
  $("rowDetail").hidden = true;
  $("pageInfo").textContent = "—";

  if ($("picker").open) $("picker").close();
  notice("Opening " + paths.length + " packet file(s)…");
  const res = await request(
    "open",
    {},
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: paths }),
    },
  );
  if (id !== pollId) return;
  s.job = res.job;
  while (id === pollId) {
    const st = await query("status");
    if (id !== pollId) return;
    if (st.state === "error") throw Error(st.error);
    if (st.state === "ready") break;
    if (st.state === "indexing")
      notice(
        "Indexing " +
          st.number +
          "/" +
          st.files +
          " · " +
          st.file +
          (st.total
            ? " · " + Math.floor((100 * st.done) / st.total) + "%"
            : ""),
      );
    await sleep(300);
  }
  if (id !== pollId) return;
  const session = await query("session");
  if (id !== pollId) return;
  s.session = session;
  $("scope").replaceChildren(...session.scopes.map((v) => opt(v.key, v.name)));
  $("scope").disabled = session.scopes.length === 0;
  if (!session.scopes.length) {
    displayFiles();
    detector.set(new ArrayBuffer(0), s.field, s.stat, 0, 1);
    notice(
      "These files have no time-qualified charge or markers. Source rows are available in the packet inspector.",
    );
    s.raw = true;
    s.rawFile = 0;
    s.offset = 0;
    $("inspect").open = true;
    await inspect();
    return;
  }
  s.rawFile = 0;
  await setView(session.scopes[0].key);
}

function listFiles() {
  const list = $("listing");
  list.replaceChildren();
  const filter = $("filter").value.toLowerCase();
  for (const f of folders.filter((v) =>
    v.name.toLowerCase().includes(filter),
  )) {
    const b = node("button", "▸  " + f.name, "folder");
    b.onclick = () => browse(f.path).catch(report);
    list.append(b);
  }
  for (const f of listed.filter((v) => v.name.toLowerCase().includes(filter))) {
    const label = node("label", "", "file-row"),
      check = document.createElement("input");
    check.type = "checkbox";
    check.checked = s.selection.has(f.path);
    check.onchange = () => {
      if (check.checked) s.selection.add(f.path);
      else s.selection.delete(f.path);
      selectionCount();
    };
    label.append(
      check,
      document.createTextNode(f.name),
      node("small", (f.bytes / 1e6).toFixed(0) + " MB"),
    );
    list.append(label);
  }
  if (!list.children.length)
    list.append(node("p", "No matching folders or HDF5 files.", "source-note"));
  selectionCount();
}
function selectionCount() {
  $("selectedCount").textContent = s.selection.size + " selected";
  $("openFiles").disabled = !s.selection.size;
}
async function browse(path) {
  const id = ++catalogId,
    r = await request("catalog", { dir: path });
  if (id !== catalogId) return;
  dir = r.directory;
  parent = r.parent;
  listed = r.files;
  folders = r.folders;
  $("up").disabled = parent === null;
  $("browsePath").textContent = root + (dir === "." ? "" : " / " + dir);
  $("filter").value = "";
  listFiles();
}
function pickMarker(m) {
  const [, n, t, f, row, iog] = m.p;
  userSeek(t);
  $("markerNote").textContent =
    m.name +
    " · IOG " +
    iog +
    " · tick " +
    fmt(t) +
    (n > 1 ? " · " + n + " markers in bin (first shown)" : "");
  s.raw = true;
  s.rawFile = f;
  s.offset = row;
  $("inspect").open = true;
  inspect().catch(report);
}
function filterIOG(g) {
  if (!s.view || !$("iog").querySelector('option[value="' + g + '"]')) return;
  pause();
  s.iog = g;
  s.pixel = null;
  s.offset = 0;
  $("iog").value = String(g);
  detector.filter(g);
  histogram.reset(g);
  map().catch(report);
  charts(true).catch(report);
  if ($("inspect").open) inspect().catch(report);
}
async function inspect() {
  if (!s.session || !$("inspect").open) return;
  const version = ++insId,
    signal = replaceRequest("inspect"),
    limit = 30;
  $("sourceLabel").hidden = $("rowLabel").hidden = !s.raw;
  $("clearPixel").hidden = s.raw || s.pixel === null;
  $("rowMode").setAttribute("aria-pressed", s.raw);
  $("windowMode").setAttribute("aria-pressed", !s.raw);
  $("source").value = s.rawFile;
  $("rawStart").value = s.offset;
  $("rowDetail").hidden = true;
  const lo = Math.max(0, s.t + 1 - s.width),
    hi = s.t + 1;
  $("inspectionLabel").textContent = s.raw
    ? "Original HDF5 order"
    : s.pixel === null
      ? "Current window"
      : "Pixel " + s.pixel;
  if (!s.raw && !s.view) return;
  const res = s.raw
    ? await query(
        "rows",
        { file: s.rawFile, start: s.offset, limit },
        { signal },
      )
    : await query(
        "packets",
        { lo, hi, pixel: s.pixel ?? -1, skip: s.offset, limit },
        { signal },
      );
  if (version !== insId) return;
  const fields = [
    ["row", "Row"],
    ["tick", "Detector tick"],
    ["packet_type", "Type"],
    ["io_group", "IOG"],
    ["io_channel", "IO chan"],
    ["chip_id", "Chip"],
    ["channel_id", "Chan"],
    ["timestamp", "Raw timestamp"],
    ["receipt_timestamp", "Receipt"],
    ["dataword", "Dataword"],
    ["local_fifo", "Local FIFO"],
    ["shared_fifo", "Shared FIFO"],
  ];
  const head = node("tr", "");
  fields.forEach(([, label]) => head.append(node("th", label)));
  $("thead").replaceChildren(head);
  $("tbody").replaceChildren();
  for (const r of res.rows) {
    const tr = node("tr", "");
    tr.tabIndex = 0;
    for (const [k] of fields) tr.append(node("td", r[k] ?? "—"));
    const detail = () => {
      $("rowDetail").hidden = false;
      $("rowDetail").textContent =
        s.session.files[r.file ?? s.rawFile].name +
        "\n" +
        Object.entries(r)
          .map(([k, v]) => k + " = " + v)
          .join("   ");
    };
    tr.onclick = detail;
    tr.onkeydown = (e) => {
      if (e.key === "Enter") detail();
    };
    $("tbody").append(tr);
  }
  $("pageInfo").textContent =
    (res.rows.length
      ? fmt(s.offset + 1) + "–" + fmt(s.offset + res.rows.length)
      : "0") +
    " of " +
    fmt(res.total);
  $("prevPage").disabled = s.offset === 0;
  $("nextPage").disabled = s.offset + res.rows.length >= res.total;
}
function bind(id, ev, fn) {
  $(id).addEventListener(ev, (e) => {
    try {
      Promise.resolve(fn(e)).catch(report);
    } catch (err) {
      report(err);
    }
  });
}
async function main() {
  const theme = $("theme");
  const preference = matchMedia("(prefers-color-scheme: dark)");
  try {
    theme.value = localStorage.getItem("packet-explorer-theme") || "system";
  } catch {}
  function applyTheme() {
    const dark =
      theme.value === "dark" || (theme.value !== "light" && preference.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    detector?.recolor();
    timelines?.draw();
    histogram?.draw();
  }
  applyTheme();
  preference.addEventListener("change", applyTheme);
  bind("theme", "change", () => {
    applyTheme();
    try {
      localStorage.setItem("packet-explorer-theme", theme.value);
    } catch {}
  });
  const [init, addresses] = await Promise.all([
    request("bootstrap"),
    request("addresses"),
  ]);
  root = init.root;
  detector = new Detector(init.tiles, new DataView(addresses), (id) => {
    pause();
    s.pixel = id;
    s.raw = false;
    s.offset = 0;
    $("inspect").open = true;
    inspect().catch(report);
  });
  histogram = new Histogram(
    detector,
    (params, signal) => request("histogram", params, { signal }),
    pause,
  );
  timelines = new Timelines(s, userSeek, zoom, pickMarker);
  for (const key of ["width", "step", "hold"]) {
    const u = $(key + "Unit");
    for (const [k, v] of [
      [1, "ticks"],
      [10, "µs"],
      [1e4, "ms"],
      [1e7, "s"],
    ])
      u.add(opt(k, v));
    putDuration(key, s[key]);
    for (const id of [key, key + "Unit"])
      bind(id, "change", () => {
        pause();
        readDuration(key);
        s.offset = 0;
        timelines.draw();
        if ($("inspect").open && !s.raw) inspect().catch(report);
        return map();
      });
  }
  stats();
  bind("single", "click", () => {
    pause();
    putDuration("width", 1);
    putDuration("step", 1);
    return seek(s.t);
  });
  bind("files", "click", async () => {
    pause();
    await browse(dir);
    $("picker").showModal();
  });
  bind("closePicker", "click", () => $("picker").close());
  bind("up", "click", () => browse(parent));
  bind("filter", "input", listFiles);
  bind("allVisible", "click", () => {
    const q = $("filter").value.toLowerCase();
    for (const f of listed)
      if (f.name.toLowerCase().includes(q)) s.selection.add(f.path);
    listFiles();
  });
  bind("clearFiles", "click", () => {
    s.selection.clear();
    listFiles();
  });
  bind("openFiles", "click", () => openFiles([...s.selection]));
  bind("scope", "change", () => setView($("scope").value));
  bind("iog", "change", () => filterIOG(Number($("iog").value)));
  bind("tick", "change", () => {
    const t = Number($("tick").value);
    if (!Number.isSafeInteger(t)) throw Error("Enter an integer tick.");
    $("tick").blur();
    userSeek(t);
  });
  bind("play", "click", playback);
  bind("speed", "change", pause);
  bind("back", "click", () => userSeek(s.t - s.step));
  bind("forward", "click", () => userSeek(s.t + s.step));
  bind("nextHit", "click", () => nearest(1));
  bind("prevHit", "click", () => nearest(-1));
  bind("field", "change", () => {
    stats();
    return map();
  });
  bind("stat", "change", () => {
    s.stat = $("stat").value;
    return map();
  });
  bind("chips", "change", () => charts(true));
  bind("peak", "click", peak);
  bind("zoomin", "click", () => changeZoom(0.25));
  bind("zoomout", "click", () => changeZoom(4));
  bind("resetZoom", "click", () => {
    if (s.view) zoom(0, s.view.length);
  });
  bind("useRange", "click", () => {
    if (s.view) {
      pause();
      putDuration("width", s.hi - s.lo);
      return seek(s.hi - 1);
    }
  });
  bind("inspect", "toggle", inspect);
  bind("windowMode", "click", () => {
    if (!s.view) return;
    s.raw = false;
    s.offset = 0;
    return inspect();
  });
  bind("rowMode", "click", () => {
    s.raw = true;
    s.offset = 0;
    return inspect();
  });
  bind("clearPixel", "click", () => {
    s.pixel = null;
    s.offset = 0;
    return inspect();
  });
  bind("source", "change", () => {
    s.rawFile = Number($("source").value);
    s.offset = 0;
    return inspect();
  });
  bind("rawStart", "change", () => {
    s.offset = bound(
      Math.floor(Number($("rawStart").value) || 0),
      0,
      Math.max(0, s.session.files[s.rawFile].rows - 1),
    );
    return inspect();
  });
  bind("prevPage", "click", () => {
    s.offset = Math.max(0, s.offset - 30);
    return inspect();
  });
  bind("nextPage", "click", () => {
    s.offset += 30;
    return inspect();
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.target.closest("input,select,textarea,dialog,button,summary") ||
      !s.view
    )
      return;
    if (e.code === "Space") {
      e.preventDefault();
      playback().catch(report);
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      if (e.shiftKey) nearest(d).catch(report);
      else userSeek(s.t + s.step * d);
    }
  });
  if (init.initial.length) {
    s.selection = new Set(init.initial);
    await openFiles(init.initial);
  } else {
    await browse(".");
    $("picker").showModal();
  }
}
main().catch(report);
