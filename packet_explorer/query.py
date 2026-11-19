"""Windowed queries on sorted detector ticks. Absolute ticks never cross the JSON boundary."""

import heapq
import math
from dataclasses import dataclass
from itertools import islice

import numpy as np

from .calibration import CORRECTED
from .index import PERIOD

FIELD_LEVELS = {
    "adc": 256,
    "local_fifo": 4,
    "shared_fifo": 4,
    "trigger_type": 4,
    "first_packet": 2,
    "downstream_marker": 2,
}
AXIS_LEVELS = {**FIELD_LEVELS, "channel_id": 64, "chip_id": 256}
STATS = {"mean", "median", "min", "max", "last", "full_fraction"}
MAP_RECORD = np.dtype([("pixel", "<u4"), ("count", "<f8"), ("value", "<f8")])


def field_values(records, field):
    if field == "trigger_type":
        return records["flags"] & 3
    if field in ("first_packet", "downstream_marker"):
        return (records["flags"] >> (2 if field == "first_packet" else 3)) & 1
    return records[field]


def packet_axis(key, max_count, settings=None):
    discrete = key != CORRECTED
    if key == "channel_count":
        lo, hi = 1, max_count
    elif key == CORRECTED:
        lo, hi = -255, 255
    else:
        lo, hi = 0, AXIS_LEVELS[key] - 1
    settings = {} if settings is None else settings
    if not isinstance(settings, dict) or settings.keys() - {"min", "max", "width"}:
        raise ValueError("Invalid histogram bin settings.")
    if ("min" in settings) != ("max" in settings):
        raise ValueError("Set both axis limits.")
    lo, hi = settings.get("min", lo), settings.get("max", hi)
    if not all(
        type(v) in (int, float)
        and abs(v) <= 2**53 - 1
        and math.isfinite(v)
        and (not discrete or int(v) == v)
        for v in [lo, hi, *settings.values()]
    ):
        raise ValueError(
            "Use finite limits and positive bin widths. Code axes require integers."
        )
    if hi < lo or (hi == lo and not discrete):
        raise ValueError(
            "The axis maximum must exceed the minimum for a continuous field."
        )
    span = hi - lo + int(discrete)
    default = max(1, math.ceil(span / (64 if key == "channel_count" else 1024)))
    width = settings.get("width", default)
    if width <= 0 or width < span / 1024:
        raise ValueError("Use a positive bin width with at most 1024 bins per axis.")
    return {
        "min": lo,
        "max": hi,
        "width": width,
        "size": math.ceil(span / width),
        "discrete": discrete,
    }


def bin_indices(values, axis):
    # Check limits before casting. The last continuous bin includes its upper edge.
    valid = (values >= axis["min"]) & (values <= axis["max"])
    indices = np.zeros(len(values), dtype=np.int64)
    indices[valid] = np.minimum(
        axis["size"] - 1,
        np.floor((values[valid].astype(float) - axis["min"]) / axis["width"]),
    )
    return indices, valid


@dataclass
class Run:
    file: int
    iog: int
    shift: int
    lo: int
    hi: int  # exclusive
    data: np.ndarray

    def cut(self, lo, hi):
        bounds = self.data["tick"].searchsorted([lo - self.shift, hi - self.shift])
        return self.data[bounds[0] : bounds[1]]


class View:
    def __init__(self, files, geometry, use):
        self.geometry, self.files = geometry, files
        self.runs = {"hits": [], "marks": []}
        self.coverage = []
        spans = []
        for file in sorted({f for f, _ in use}):
            index = files[file]
            for name in self.runs:
                for iog, start, size, lo, last in index.meta[name]:
                    offset = use.get((file, iog))
                    if offset is not None:
                        spans.append((file, iog, name, start, size, lo, last, offset))
        if not spans:
            raise ValueError("No indexed hits or markers in this clock view.")
        self.origin = min(lo + offset for _, _, _, _, _, lo, _, offset in spans)
        self.length = (
            max(last + offset for _, _, _, _, _, _, last, offset in spans)
            - self.origin
            + 1
        )
        if self.length > 2**53 - 1:
            raise ValueError(
                "Selection spans more detector ticks than the browser can address exactly."
            )
        coverage = {}
        for file, iog, name, start, size, lo, last, offset in spans:
            shift = offset - self.origin
            run = Run(
                file,
                iog,
                shift,
                lo + shift,
                last + shift + 1,
                files[file].records[name][start : start + size],
            )
            self.runs[name].append(run)
            key = (file, iog)
            left, right = coverage.get(key, (run.lo, run.hi))
            coverage[key] = min(left, run.lo), max(right, run.hi)
        self.coverage = [
            {"file": f, "iog": g, "lo": lo, "hi": hi}
            for (f, g), (lo, hi) in sorted(coverage.items())
        ]

    def info(self):
        intervals = sorted((r["lo"], r["hi"]) for r in self.coverage)
        gaps, end = [], 0
        for lo, hi in intervals:
            if lo > end:
                gaps.append([end, lo])
            end = max(end, hi)
        overlaps = set()
        # Ordinary adjacent files have no overlap. Only compare intervals that
        # are still open on this IOG, even when selecting hundreds of files.
        for iog in range(1, 9):
            spans = sorted(
                (c["lo"], c["hi"], c["file"]) for c in self.coverage if c["iog"] == iog
            )
            open_files = []
            for lo, hi, file in spans:
                open_files = [(end, f) for end, f in open_files if end > lo]
                overlaps.update(tuple(sorted((f, file))) for _, f in open_files)
                open_files.append((hi, file))
        return {
            "length": self.length,
            "origin": str(self.origin),
            "coverage": self.coverage,
            "gaps": gaps,
            "overlaps": sorted(overlaps),
        }

    def slices(self, name, lo, hi, iog=0):
        for run in self.runs[name]:
            if (not iog or iog == run.iog) and lo < run.hi and hi > run.lo:
                rows = run.cut(lo, hi)
                if len(rows):
                    yield run, rows

    def next_tick(self, tick, direction, iog=0):
        best = None
        for run in self.runs["hits"]:
            if iog and run.iog != iog:
                continue
            if direction > 0 and run.hi <= tick + 1 or direction < 0 and run.lo >= tick:
                continue
            ticks = run.data["tick"]
            if direction > 0:
                ix = ticks.searchsorted(tick - run.shift, side="right")
                if ix < len(ticks):
                    candidate = int(ticks[ix]) + run.shift
                    best = candidate if best is None else min(best, candidate)
            else:
                ix = ticks.searchsorted(tick - run.shift) - 1
                if ix >= 0:
                    candidate = int(ticks[ix]) + run.shift
                    best = candidate if best is None else max(best, candidate)
        return best

    def timeline(self, lo, hi, bins, iog=0, chips=False):
        bins = min(bins, hi - lo)
        edges = np.array(
            [lo + i * (hi - lo) // bins for i in range(bins + 1)], dtype=np.int64
        )
        counts = np.zeros((8, bins), dtype=np.int64)
        distinct = np.zeros((bins, 8 * 8 * 256), dtype=bool) if chips else None
        for run, data in self.slices("hits", lo, hi, iog):
            idx = data["tick"].searchsorted(edges - run.shift)
            counts[run.iog - 1] += np.diff(idx)
            if chips:
                slots = (
                    np.searchsorted(edges, data["tick"] + run.shift, side="right") - 1
                )
                distinct[slots, self.geometry.chips[data["pixel"]]] = True
        lanes = {}
        for run, marks in self.slices("marks", lo, hi, iog):
            for m in marks:
                kind, subtype = int(m["kind"]), int(m["subtype"])
                key = f"T{subtype} · IOG {run.iog}" if kind == 7 else f"SYNC {subtype}"
                tick = int(m["tick"]) + run.shift
                bucket = int(edges.searchsorted(tick, side="right") - 1)
                lane = lanes.setdefault(key, {})
                ref = [tick, run.file, int(m["row"]), run.iog]
                if bucket not in lane:
                    lane[bucket] = [0, ref]
                entry = lane[bucket]
                entry[0] += 1
                entry[1] = min(entry[1], ref)
        return {
            "edges": edges.tolist(),
            "counts": counts.tolist(),
            "chips": distinct.sum(axis=1).tolist() if chips else None,
            "lanes": {
                name: [[b, n, *ref] for b, (n, ref) in sorted(values.items())]
                for name, values in sorted(lanes.items())
            },
        }

    def histogram(
        self,
        lo,
        hi,
        field,
        iog=0,
        boxes=None,
        x=None,
        y=None,
        calibration=None,
        settings=None,
    ):
        """One count per mapped charge packet. Pixel boxes use tile raster coordinates."""
        if field not in FIELD_LEVELS.keys() | {CORRECTED}:
            raise ValueError("Unknown packet histogram field.")
        if CORRECTED in (field, x, y) and calibration is None:
            raise ValueError("Select pedestal files to use ADC − pedestal.")
        settings = {} if settings is None else settings
        if not isinstance(settings, dict) or settings.keys() - {"x", "y"}:
            raise ValueError("Invalid 2D histogram settings.")
        mask = None
        if boxes is not None:
            tiles = {t["tile"]: t for t in self.geometry.tiles if t["iog"] == iog}
            if not isinstance(boxes, list) or not 1 <= len(boxes) <= len(tiles):
                raise ValueError("Select a region on one anode.")
            mask = np.zeros(self.geometry.size, dtype=bool)
            for box in boxes:
                if (
                    not isinstance(box, list)
                    or len(box) != 5
                    or any(type(n) is not int for n in box)
                ):
                    raise ValueError("Invalid histogram region.")
                tile, x0, y0, x1, y1 = box
                t = tiles.get(tile)
                if not t or not (
                    0 <= x0 < x1 <= t["width"] and 0 <= y0 < y1 <= t["height"]
                ):
                    raise ValueError("Histogram region exceeds its tile.")
                start, w, h = t["start"], t["width"], t["height"]
                mask[start : start + w * h].reshape(h, w)[y0:y1, x0:x1] = True
        pair = x is not None or y is not None
        max_count = 1
        occupancy = None
        if pair:
            valid = AXIS_LEVELS.keys() | {"channel_count", CORRECTED}
            if x not in valid or y not in valid:
                raise ValueError("Select two valid packet histogram axes.")
            if "channel_count" in (x, y):
                # Counts belong to physical pixels across all included files and runs.
                occupancy = np.zeros(self.geometry.size, dtype=np.int64)
                for _, data in self.slices("hits", lo, hi, iog):
                    np.add.at(occupancy, data["pixel"], 1)
                selected = occupancy if mask is None else occupancy[mask]
                max_count = max(1, int(selected.max(initial=0)))
            axes = [
                packet_axis(key, max_count, settings.get(dim))
                for dim, key in zip(("x", "y"), (x, y))
            ]
            nx = axes[0]["size"]
            cells = np.zeros(nx * axes[1]["size"], dtype=np.int64)

        one = packet_axis(field, 1)
        counts = np.zeros(one["size"], dtype=np.int64)
        missing = joint_missing = outside = 0
        corrected_sum = 0.0
        for _, data in self.slices("hits", lo, hi, iog):
            if mask is not None:
                data = data[mask[data["pixel"]]]
            pixels = data["pixel"]
            columns = {}
            for key in {field, x, y} - {None}:
                if key == CORRECTED:
                    columns[key] = data["adc"] - calibration.mean[pixels]
                elif key == "channel_count":
                    columns[key] = occupancy[pixels]
                elif key == "channel_id":
                    columns[key] = self.geometry.channels[pixels]
                elif key == "chip_id":
                    columns[key] = self.geometry.chips[pixels] % 256
                else:
                    columns[key] = field_values(data, key)
            values = columns[field]
            if field == CORRECTED:
                bins, valid = bin_indices(values, one)
                counts += np.bincount(bins[valid], minlength=len(counts))
                corrected_sum += values[valid].sum()
                missing += int((~valid).sum())
            else:
                counts += np.bincount(values, minlength=len(counts))
            if pair:
                bx, ok_x = bin_indices(columns[x], axes[0])
                by, ok_y = bin_indices(columns[y], axes[1])
                ok = ok_x & ok_y
                uncalibrated = (
                    int(np.isnan(columns[CORRECTED]).sum())
                    if CORRECTED in (x, y)
                    else 0
                )
                joint_missing += uncalibrated
                outside += len(data) - int(ok.sum()) - uncalibrated
                np.add.at(cells, by[ok] * nx + bx[ok], 1)
        result = {"counts": counts.tolist(), "axis": one, "missing": missing}
        if field == CORRECTED:
            total = int(counts.sum())
            result["mean"] = float(corrected_sum / total) if total else None
        if pair:
            occupied = np.flatnonzero(cells)
            result["joint"] = {
                "x": axes[0],
                "y": axes[1],
                "bins": occupied.tolist(),
                "missing": joint_missing,
                "outside": outside,
                "counts": cells[occupied].tolist(),
            }
        return result

    def map(self, play, width, hold, field, stat, iog=0, calibration=None):
        corrected = field == CORRECTED
        if corrected:
            if calibration is None:
                raise ValueError("Select pedestal files to use ADC − pedestal.")
            # A channel's constant pedestal commutes with every ADC statistic.
            field = "adc"
        if (
            field
            not in {"occupancy", "count", "rate", "first_hit"} | FIELD_LEVELS.keys()
            or stat not in STATS
        ):
            raise ValueError("Unknown map field or statistic.")
        if stat == "full_fraction" and field not in ("local_fifo", "shared_fifo"):
            raise ValueError("Fraction full applies to FIFO status fields.")
        end = play + 1
        lo = max(0, end - width)
        slices = list(self.slices("hits", lo, end, iog))
        n = self.geometry.size
        count = np.zeros(n, dtype=np.int64)
        values = np.zeros(n, dtype=np.float64)
        is_field = field in FIELD_LEVELS
        if field == "first_hit" or is_field and stat == "min":
            values.fill(np.inf)
        last_tick = (
            np.full(n, -1, dtype=np.int64) if is_field and stat == "last" else None
        )
        for run, data in slices:
            pixels = data["pixel"]
            np.add.at(count, pixels, 1)
            if field == "first_hit":
                np.minimum.at(values, pixels, data["tick"] + run.shift - lo)
                continue
            if not is_field or stat == "median":
                continue
            v = field_values(data, field)
            if stat in ("mean", "full_fraction"):
                np.add.at(values, pixels, v if stat == "mean" else v == 3)
            elif stat == "max":
                np.maximum.at(values, pixels, v)
            elif stat == "min":
                np.minimum.at(values, pixels, v)
            elif stat == "last":
                # Take the final row for each pixel in this sorted run. Ties across
                # runs use input file order and then original file row order.
                pix, reverse_index = np.unique(pixels[::-1], return_index=True)
                ix = len(pixels) - 1 - reverse_index
                times = data["tick"][ix] + run.shift
                keep = times >= last_tick[pix]
                last_tick[pix[keep]], values[pix[keep]] = times[keep], v[ix[keep]]
        active = count > 0
        if field == "occupancy":
            values[active] = 1
        elif field == "count":
            values[active] = count[active]
        elif field == "rate":
            values[active] = count[active] * (PERIOD / (end - lo))
        elif is_field and stat in ("mean", "full_fraction"):
            values[active] /= count[active]
        elif is_field and stat == "median":
            self._median(slices, field, count, values)
        if corrected:
            values[active] -= calibration.mean[active]
        visible = active.copy()
        if hold > width:
            for _, data in self.slices("hits", max(0, end - hold), lo, iog):
                visible[data["pixel"]] = True
        ids = np.flatnonzero(visible)
        result = np.empty(len(ids), MAP_RECORD)
        result["pixel"], result["count"] = ids, count[ids]
        result["value"] = np.where(active[ids], values[ids], 0)
        return result

    def _median(self, slices, field, count, values):
        levels = FIELD_LEVELS[field]
        for iog in sorted({r.iog for r, _ in slices}):
            series = [d for r, d in slices if r.iog == iog]
            if sum(map(len, series)) < 300_000:
                pixels = np.concatenate([d["pixel"] for d in series])
                vals = np.concatenate([field_values(d, field) for d in series])
                order = np.lexsort((vals, pixels))
                ids, starts, sizes = np.unique(
                    pixels[order], return_index=True, return_counts=True
                )
                a, b = starts + (sizes - 1) // 2, starts + sizes // 2
                values[ids] = (vals[order[a]].astype(float) + vals[order[b]]) / 2
            else:
                # Bounded by one anode × the field alphabet, even for a long selection.
                tiles = [t for t in self.geometry.tiles if t["iog"] == iog]
                base = tiles[0]["start"]
                size = sum(t["width"] * t["height"] for t in tiles)
                hist = np.zeros((size, levels), dtype=np.uint64)
                for d in series:
                    np.add.at(hist, (d["pixel"] - base, field_values(d, field)), 1)
                total = count[base : base + size]
                low, high = (total - 1) // 2, total // 2
                cum = np.zeros(size, dtype=np.int64)
                for val in range(levels):
                    nxt = cum + hist[:, val].astype(np.int64)
                    values[base : base + size] += (val / 2) * (
                        (cum <= low) & (low < nxt)
                    )
                    values[base : base + size] += (val / 2) * (
                        (cum <= high) & (high < nxt)
                    )
                    cum = nxt

    def packets(self, lo, hi, pixel, skip, limit, iog=0):
        def refs(run, data):
            for r in data:
                yield int(r["tick"]) + run.shift, run.file, int(r["row"])

        streams, total = [], 0
        for run, data in self.slices("hits", lo, hi, iog):
            if pixel is not None:
                data = data[data["pixel"] == pixel]
            total += len(data)
            if len(data):
                streams.append(refs(run, data))
        page = list(islice(heapq.merge(*streams), skip, skip + limit))
        by_file = {}
        for tick, file, row in page:
            by_file.setdefault(file, []).append(row)
        raw = {
            (file, r["row"]): r
            for file, ids in by_file.items()
            for r in self.files[file].rows(ids)
        }
        return {
            "total": total,
            "rows": [dict(file=f, tick=t, **raw[f, r]) for t, f, r in page],
        }


class ClockViews(dict):
    def __init__(self, files, geometry):
        super().__init__()
        self.files, self.geometry = files, geometry
        self.local = {}

    def __missing__(self, key):
        if key not in self.local:
            raise KeyError("Unknown clock view.")
        view = View(self.files, self.geometry, {self.local[key]: 0})
        return self.setdefault(key, view)


class Session:
    def __init__(self, files, geometry):
        self.files = files
        self.views = ClockViews(files, geometry)
        offsets = {}
        self.scopes = []
        for i, f in enumerate(files):
            active = {b[0] for name in ("hits", "marks") for b in f.meta[name]}
            for g in sorted(active):
                epoch = f.meta["clocks"][str(g)]["epoch"]
                if epoch is not None:
                    offsets[i, g] = epoch * PERIOD
                key = f"{i}-{g}"
                self.views.local[key] = (i, g)
                self.scopes.append(
                    {"key": key, "name": f"Local · {f.path.name} · IOG {g}"}
                )
        if offsets:
            self.views["aligned"] = View(files, geometry, offsets)
            self.scopes.insert(0, {"key": "aligned", "name": "PPS-aligned detector"})
        self.info = {
            "scopes": self.scopes,
            "files": [
                {
                    "name": f.path.name,
                    "path": str(f.path),
                    "rows": f.meta["rows"],
                    "types": f.meta["types"],
                    "clocks": f.meta["clocks"],
                    "config": f.meta["config"],
                }
                for f in files
            ],
        }
