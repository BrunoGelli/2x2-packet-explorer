import json
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import h5py
import numpy as np
import pytest
from conftest import sample

from packet_explorer.index import HIT, PERIOD, open_index
from packet_explorer.query import Run, Session, View
from packet_explorer.server import Workspace, make_server


def setup_view(tmp_path, geom, **kw):
    f = open_index(
        sample(tmp_path / "test.h5", geom, **kw), tmp_path / "cache", geom, chunk=4
    )
    return f, Session([f], geom).views["aligned"]


def test_hover_addresses_round_trip_on_all_anodes(geom):
    addresses = np.frombuffer(geom.addresses, dtype="<u2")
    for t in geom.tiles:
        size = t["width"] * t["height"]
        start = t["address_start"]
        addr = addresses[start : start + size]
        pixels = geom.lut[t["iog"], t["tile"], addr >> 6, addr & 63]
        np.testing.assert_array_equal(pixels, t["start"] + np.arange(size))


def test_timing_rate_rows_and_marker_placement(tmp_path, geom):
    f, v = setup_view(tmp_path, geom)
    assert v.origin == 1794029067 * PERIOD  # beyond JS's exact absolute integer range
    assert v.next_tick(-1, 1) == 2 and v.next_tick(2, 1) == 3
    assert v.next_tick(3, -1) == 2 and v.next_tick(3, 1) == PERIOD - 1
    assert v.next_tick(2, -1) is None
    rate = v.timeline(0, 8, 100, chips=True)
    assert np.sum(rate["counts"], axis=0).tolist() == [0, 0, 2, 4, 0, 0, 0, 0]
    assert rate["chips"] == [0, 0, 2, 2, 0, 0, 0, 0]
    assert rate["lanes"]["SYNC 83"][0][:3] == [0, 2, 0]
    assert rate["lanes"]["T2 · IOG 1"][0] == [5, 1, 5, 0, 6, 1]
    assert rate["lanes"]["SYNC 72"][0][2] == 6
    p = v.packets(0, 4, None, 1, 3)
    assert p["total"] == 6 and [x["tick"] for x in p["rows"]] == [2, 3, 3]
    for r in p["rows"]:
        assert f.rows([r["row"]])[0]["dataword"] == r["dataword"]
    assert f.meta["clocks"]["1"]["counts"]["before_sync"] == 1
    assert f.meta["clocks"]["1"]["counts"]["diagnostic"] == 1
    assert f.meta["clocks"]["1"]["counts"]["bad_parity"] == 1


@pytest.mark.parametrize(
    "field,stat,expected",
    [
        ("adc", "mean", 12.0),
        ("adc", "median", 12.0),
        ("adc", "last", 16.0),
        ("adc", "min", 8.0),
        ("adc", "max", 16.0),
        ("local_fifo", "full_fraction", 0.5),
        ("count", "last", 2.0),
        ("rate", "last", 2 * PERIOD),
        ("first_hit", "last", 0.0),
    ],
)
def test_single_tick_fields(tmp_path, geom, field, stat, expected):
    _, v = setup_view(tmp_path, geom)
    result = v.map(3, 1, 0, field, stat, 1)
    assert (
        len(result) == 1 and result["count"][0] == 2 and result["value"][0] == expected
    )


def test_persistence_and_half_open_windows(tmp_path, geom):
    _, v = setup_view(tmp_path, geom)
    assert len(v.map(4, 1, 0, "occupancy", "last", 1)) == 0
    trail = v.map(4, 1, 3, "occupancy", "last", 1)
    assert len(trail) == 1 and trail["count"][0] == 0
    assert len(v.map(6, 1, 3, "occupancy", "last", 1)) == 0
    tick3 = v.map(3, 1, 0, "adc", "median", 1).tobytes()
    v.map(PERIOD - 1, PERIOD, 0, "adc", "mean", 1)
    assert v.map(3, 1, 0, "adc", "median", 1).tobytes() == tick3
    assert v.map(3, 3, 0, "adc", "median", 1)["value"][0] == 16


def test_large_window_exact_median(geom):
    # Exercise the bounded histogram branch with both odd and even group sizes.
    v = object.__new__(View)
    v.geometry = geom
    v.files = []
    n = 330001
    data = np.zeros(n, HIT)
    data["adc"] = np.arange(n) % 256
    data["tick"] = np.arange(n)
    data["pixel"][::4] = 1
    v.runs = {"hits": [Run(0, 1, 0, 0, n, data)], "marks": []}
    result = v.map(n - 1, n, 0, "adc", "median")
    for r in result:
        actual = data["adc"][data["pixel"] == r["pixel"]]
        assert r["value"] == np.median(actual) and r["count"] == len(actual)


def test_unaligned_stream_and_multi_file_gaps(tmp_path, geom):
    cache = tmp_path / "cache"
    f = open_index(sample(tmp_path / "z.h5", geom, conflicting=True), cache, geom)
    b = open_index(sample(tmp_path / "a.h5", geom, second=1794029071), cache, geom)
    s = Session([b, f], geom)
    v = s.views["aligned"]
    assert f.meta["clocks"]["2"]["epoch"] is None
    assert {c["iog"] for c in v.coverage if c["file"] == 1} == {1}
    assert len(s.views["1-2"].runs["hits"])
    assert v.info()["gaps"] == [[PERIOD + 1, 4 * PERIOD]]
    assert not v.info()["overlaps"]
    assert v.next_tick(4 * PERIOD + 2, -1) == PERIOD - 1
    assert (
        v.packets(4 * PERIOD + 2, 4 * PERIOD + 3, None, 0, 10)["rows"][0]["file"] == 0
    )


def test_cache_concurrency_and_invalidation(tmp_path, geom):
    p = sample(tmp_path / "a.h5", geom)
    cache = tmp_path / "cache"
    with ThreadPoolExecutor(2) as pool:
        a, b = list(pool.map(lambda _: open_index(p, cache, geom), range(2)))
    assert a.directory == b.directory and len(list(cache.iterdir())) == 1
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    with pytest.raises(ValueError, match="changed"):
        a.rows([0])
    assert open_index(p, cache, geom).directory != a.directory


def test_source_only_and_unsupported_inputs(tmp_path, geom):
    empty = sample(tmp_path / "empty.h5", geom)
    with h5py.File(empty, "r+") as f:
        data = f["packets"][:1]
        del f["packets"]
        f["packets"] = data
    idx = open_index(empty, tmp_path / "cache", geom)
    assert Session([idx], geom).scopes == [] and idx.rows([0])[0]["packet_type"] == 4
    with h5py.File(tmp_path / "raw.h5", "w") as f:
        f.create_dataset("msgs", data=[1])
    with pytest.raises(ValueError, match="flat /packets"):
        open_index(tmp_path / "raw.h5", tmp_path / "cache", geom)


def test_http_root_selection_and_inspection(tmp_path, geom):
    p = sample(tmp_path / "test.h5", geom)
    work = Workspace(tmp_path, tmp_path / "cache", [p])
    srv = make_server(work, 0)
    thread = Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{srv.server_port}/"
    auth = {"Authorization": "Bearer " + work.access_key}

    def get(route):
        with urlopen(Request(base + route, headers=auth)) as resp:
            return json.load(resp)

    try:
        with pytest.raises(HTTPError) as denied:
            urlopen(base + "api/bootstrap")
        assert denied.value.code == 403
        assert get("api/bootstrap")["initial"] == [p.name]
        with pytest.raises(HTTPError):
            get("api/catalog?dir=..")
        with urlopen(
            Request(
                base + "api/open",
                data=json.dumps({"files": [p.name, p.name]}).encode(),
                headers={**auth, "Content-Type": "application/json"},
            )
        ) as resp:
            key = json.load(resp)["job"]
        work.worker.submit(lambda: None).result()
        assert get("api/status?job=" + key)["state"] == "ready"
        assert len(get("api/session?job=" + key)["files"]) == 1
        assert (
            get("api/rows?job=" + key + "&file=0&start=1&limit=1")["rows"][0]["row"]
            == 1
        )
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()
        work.close()
