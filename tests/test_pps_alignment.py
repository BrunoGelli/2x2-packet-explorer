import h5py
import numpy as np
import pytest
from conftest import DTYPE

from packet_explorer.index import PERIOD, open_index
from packet_explorer.query import Session


def recording(path, geom, *, free_running=False, fault=None):
    start = 1_795_332_960
    rows = []

    def add(kind, tick, receipt=0, subtype=0):
        row = np.zeros((), DTYPE)
        row["io_group"], row["io_channel"] = g, 1
        row["chip_id"], row["channel_id"] = chip, channel
        row["packet_type"], row["trigger_type"] = kind, subtype
        row["timestamp"], row["receipt_timestamp"] = tick, receipt
        row["valid_parity"] = 1
        rows.append(row)

    for g in (1, 5, 6):
        chip, channel = np.argwhere(geom.lut[g, 1] >= 0)[0]
        # IOG 6 first appears one physical PPS later than the other boards.
        for i in range(int(g == 6), 6):
            second = start + i
            biased = not free_running and (g == 1 or (g == 6 and i == 3))
            add(4, second - biased)
            add(6, PERIOD, subtype=83)
            add(4, second)
            for phase in (PERIOD // 4, 3 * PERIOD // 4):
                add(4, second)
                if phase > PERIOD // 2:
                    if free_running:
                        add(4, second + 1)
                    if fault == "one_band" and g == 5:
                        continue
                if fault == "discontinuity" and g == 5 and i >= 4:
                    add(4, second + 1)
                # Deliberately different ASIC and receipt phases.
                add(0, 1000, receipt=phase)
            if g == 5 and fault == "buffered" and i == 3:
                add(4, second + 1)
                add(0, 1100, receipt=PERIOD // 4)
                add(0, 1101, receipt=3 * PERIOD // 4)
            if g == 5 and fault == "bad_sync" and i == 3:
                add(6, 0, subtype=83)
            if g == 6:
                add(7, 900, subtype=2)

    with h5py.File(path, "w") as handle:
        handle.create_dataset("packets", data=np.asarray(rows))
    return path


@pytest.mark.parametrize("chunk", [1, 17, 1000])
def test_rollover_alignment_recovers_hits_and_light_triggers(tmp_path, geom, chunk):
    path = recording(tmp_path / "run.h5", geom)
    idx = open_index(path, tmp_path / "cache", geom, chunk=chunk)
    clocks = idx.meta["clocks"]
    assert all(clocks[str(g)]["method"] == "receipt" for g in (1, 5, 6))
    assert len(clocks["6"]["votes"]) == 2
    assert len(clocks["1"]["votes"]) == 1
    assert int(next(iter(clocks["1"]["votes"]))) + 1 == clocks["1"]["epoch"]
    assert clocks["6"]["epoch"] == clocks["1"]["epoch"] + 1
    view = Session([idx], geom).views["aligned"]
    lane = view.timeline(0, view.length, 80)["lanes"]["T2 · IOG 6"]
    assert sum(entry[1] for entry in lane) == 5
    for _, _, tick, *_ in lane:
        coincidences = view.packets(tick, tick + 101, None, 0, 10)["rows"]
        assert {r["io_group"] for r in coincidences} == {1, 5, 6}


@pytest.mark.parametrize("fault", ["one_band", "discontinuity", "bad_sync"])
def test_uncertain_target_remains_local(tmp_path, geom, fault):
    idx = open_index(recording(tmp_path / "run.h5", geom, fault=fault), tmp_path, geom)
    session = Session([idx], geom)
    assert idx.meta["clocks"]["5"]["epoch"] is None
    assert {r["iog"] for r in session.views["aligned"].coverage} == {1, 6}
    assert session.views["0-5"].runs["hits"]


@pytest.mark.parametrize("chunk", [1, 1000])
def test_buffered_envelope_cannot_vote_in_two_bands(tmp_path, geom, chunk):
    path = recording(tmp_path / "run.h5", geom, fault="buffered")
    idx = open_index(path, tmp_path, geom, chunk=chunk)
    assert idx.meta["clocks"]["5"]["method"] == "receipt"
    assert idx.meta["clocks"]["5"]["epoch"] == idx.meta["clocks"]["1"]["epoch"]


def test_free_running_headers_can_roll_over_between_receipt_bands(tmp_path, geom):
    path = recording(tmp_path / "run.h5", geom, free_running=True)
    idx = open_index(path, tmp_path, geom)
    clocks = idx.meta["clocks"]
    assert all(clocks[str(g)]["method"] == "reset" for g in (1, 5, 6))
    assert clocks["6"]["epoch"] == clocks["1"]["epoch"] + 1
