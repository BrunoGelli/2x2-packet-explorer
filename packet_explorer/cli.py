import argparse
import os
import webbrowser
from pathlib import Path
from threading import Timer

from .geometry import Geometry
from .index import open_index
from .server import Workspace, make_server


def main():
    parser = argparse.ArgumentParser(
        prog="packet-explorer", description="Inspect ND-LAr 2×2 packet HDF5 files."
    )
    sub = parser.add_subparsers(dest="action", required=True)
    serve = sub.add_parser("serve", help="Open the interactive browser viewer")
    serve.add_argument("files", nargs="*", type=Path)
    serve.add_argument(
        "--root", type=Path, help="Top directory available in the file selector"
    )
    serve.add_argument("--port", type=int, default=8766)
    serve.add_argument(
        "--open", action="store_true", help="Open the local browser automatically"
    )
    prepare = sub.add_parser("index", help="Prepare reusable indexes for closed files")
    prepare.add_argument("files", nargs="+", type=Path)
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    if os.environ.get("NERSC_HOST") and os.environ.get("SCRATCH"):
        cache_home = Path(os.environ["SCRATCH"])
    for p in (serve, prepare):
        p.add_argument(
            "--cache-dir", type=Path, default=cache_home / "2x2-packet-explorer"
        )
    args = parser.parse_args()
    files = [p.expanduser().resolve() for p in args.files]
    cache = args.cache_dir.expanduser()
    if args.action == "index":
        geom = Geometry()
        for path in files:
            f = open_index(path, cache, geom)
            print(
                f"{path.name}: {f.meta['rows']:,} rows; {len(f.records['hits']):,} mapped charge packets"
            )
        return
    root = (
        args.root.expanduser().resolve()
        if args.root
        else (
            Path(os.path.commonpath([p.parent for p in files])) if files else Path.cwd()
        )
    )
    if not root.is_dir() or any(
        not p.is_file() or not p.is_relative_to(root) for p in files
    ):
        parser.error("The data root must be a directory containing all selected files.")
    work = Workspace(root, cache, files)
    server = make_server(work, args.port)
    url = f"http://127.0.0.1:{server.server_port}/#key={work.access_key}"
    print(f"2×2 Packet Explorer   {url}\nData directory   {root}", flush=True)
    if args.open:
        Timer(0.2, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        work.close()
