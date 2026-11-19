"""Per-physical-pixel pedestal statistics from independent, closed packet files."""

import hashlib
import json
import os
import tempfile
from pathlib import Path

import h5py
import numpy as np

from .index import CHUNK_ROWS, packet_dataset, signature

CORRECTED = "adc_corrected"
TRIGGERS = {"all": None, "periodic": 3, "normal": 0, "external": 1, "cross": 2}


def file_moments(path, cache, geometry, trigger, progress):
    # Integer sufficient statistics let us pool files without rounding or
    # weighting a sparsely sampled file the same as a densely sampled one.
    sig = signature(path)
    key = hashlib.sha256(json.dumps([1, sig, trigger]).encode()).hexdigest()
    cache = Path(cache) / "pedestals"
    target = cache / (key + ".npy")
    if target.exists():
        return np.load(target, allow_pickle=False)
    moments = np.zeros((3, geometry.size), dtype=np.int64)
    with h5py.File(path, "r") as f:
        ds = packet_dataset(f)
        for start in range(0, len(ds), CHUNK_ROWS):
            data = ds[start : start + CHUNK_ROWS]
            keep = (data["packet_type"] == 0) & (data["valid_parity"] != 0)
            if "fifo_diagnostics_enabled" in data.dtype.names:
                keep &= data["fifo_diagnostics_enabled"] == 0
            if TRIGGERS[trigger] is not None:
                keep &= data["trigger_type"] == TRIGGERS[trigger]
            rows = data[keep]
            for iog in np.unique(rows["io_group"]):
                if not 1 <= iog <= 8:
                    continue
                group = rows[rows["io_group"] == iog]
                pixels = geometry.lookup(iog, group)
                valid = pixels >= 0
                ids, adc = pixels[valid], group["dataword"][valid].astype(np.int64)
                np.add.at(moments[0], ids, 1)
                np.add.at(moments[1], ids, adc)
                np.add.at(moments[2], ids, adc * adc)
            progress(min(start + CHUNK_ROWS, len(ds)), len(ds))
    if signature(path) != sig:
        raise ValueError(
            "The pedestal input changed during calibration. Select a closed file."
        )
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as temp:
        pending = Path(temp) / target.name
        np.save(pending, moments, allow_pickle=False)
        os.replace(pending, target)
    return moments


class Calibration:
    def __init__(self, moments, paths, trigger, geometry):
        self.count, sums, squares = moments
        present = self.count > 0
        self.mean = np.full(geometry.size, np.nan)
        self.mean[present] = sums[present] / self.count[present]
        self.rms = np.full(geometry.size, np.nan)
        self.rms[present] = np.sqrt(
            np.maximum(
                0, squares[present] / self.count[present] - self.mean[present] ** 2
            )
        )
        self.info = {
            "files": [str(p) for p in paths],
            "trigger": trigger,
            "samples": int(self.count.sum()),
            "pixels": int(present.sum()),
            "total_pixels": geometry.size,
        }
        if not self.info["samples"]:
            raise ValueError(
                "No mapped pedestal samples passed the selected trigger and packet cuts."
            )

    def annotate(self, rows, geometry):
        for row in rows:
            if (
                row["packet_type"] != 0
                or not row["valid_parity"]
                or row.get("fifo_diagnostics_enabled", 0)
            ):
                continue
            iog, io = row["io_group"], row["io_channel"]
            chip, chan = row["chip_id"], row["channel_id"]
            if not (
                1 <= iog <= 8 and 1 <= io <= 32 and 0 <= chip < 256 and 0 <= chan < 64
            ):
                continue
            pixel = geometry.lut[iog, (io - 1) // 4 + 1, chip, chan]
            if pixel >= 0:
                row["pedestal_samples"] = int(self.count[pixel])
                if self.count[pixel]:
                    row["pedestal_mean"] = float(self.mean[pixel])
                    row["pedestal_rms"] = float(self.rms[pixel])
                    row[CORRECTED] = row["dataword"] - row["pedestal_mean"]
