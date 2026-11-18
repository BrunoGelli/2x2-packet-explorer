"""Read-only, loopback HTTP service for a single user's packet-file collection."""

import gzip
import json
import logging
import mimetypes
import secrets
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore, Lock
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from .geometry import Geometry
from .index import open_index
from .query import Session

WEB = Path(__file__).parent / "web"
FILE_TYPES = {".h5", ".hdf5"}
LOG = logging.getLogger(__name__)


class Workspace:
    def __init__(self, root, cache, initial=()):
        self.root, self.cache = Path(root).resolve(), Path(cache)
        self.initial = [str(Path(p).resolve().relative_to(self.root)) for p in initial]
        self.access_key = secrets.token_urlsafe(32)
        self.geometry = Geometry()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="indexer")
        self.lock = Lock()
        self.heavy = BoundedSemaphore(2)
        self.jobs = {}

    def resolve(self, path):
        target = (self.root / path).resolve()
        if not target.is_relative_to(self.root):
            raise ValueError("Path is outside the selected data directory.")
        return target

    def catalog(self, directory):
        target = self.resolve(directory)
        folders, files = [], []
        for item in sorted(target.iterdir(), key=lambda p: p.name.casefold()):
            if item.name.startswith(".") or not item.resolve().is_relative_to(
                self.root
            ):
                continue
            if item.is_dir():
                folders.append(
                    {"name": item.name, "path": str(item.relative_to(self.root))}
                )
            elif item.suffix.lower() in FILE_TYPES and item.is_file():
                files.append(
                    {
                        "name": item.name,
                        "path": str(item.relative_to(self.root)),
                        "bytes": item.stat().st_size,
                    }
                )
        return {
            "directory": str(target.relative_to(self.root)),
            "folders": folders,
            "files": files,
            "parent": str(target.parent.relative_to(self.root))
            if target != self.root
            else None,
        }

    def open(self, paths):
        if (
            not isinstance(paths, list)
            or not paths
            or not all(isinstance(p, str) for p in paths)
        ):
            raise ValueError("Select at least one packet file.")
        paths = tuple(dict.fromkeys(self.resolve(p) for p in paths))
        for p in paths:
            if not p.is_file() or p.suffix.lower() not in FILE_TYPES:
                raise ValueError(f"Expected an HDF5 packet file: {p.name}")
        stamps = tuple((p, p.stat().st_size, p.stat().st_mtime_ns) for p in paths)
        with self.lock:
            for key, job in self.jobs.items():
                if job["stamps"] == stamps and job["status"]["state"] != "error":
                    return key
            if len(self.jobs) >= 8:
                old = next(
                    (
                        k
                        for k, v in self.jobs.items()
                        if v["status"]["state"] in ("ready", "error")
                    ),
                    None,
                )
                if old is None:
                    raise ValueError("The reader is busy indexing previous selections.")
                del self.jobs[old]
            key = uuid4().hex
            job = self.jobs[key] = {"stamps": stamps, "status": {"state": "queued"}}
            self.worker.submit(self._load, job, paths)
        return key

    def _load(self, job, paths):
        def update(**status):
            with self.lock:
                job["status"] = status

        def update_progress(context, done, total):
            update(**context, done=done, total=total)

        try:
            files = []
            for i, p in enumerate(paths):
                context = {
                    "state": "indexing",
                    "file": p.name,
                    "number": i + 1,
                    "files": len(paths),
                }
                progress = partial(update_progress, context)
                progress(0, 0)
                files.append(open_index(p, self.cache, self.geometry, progress))
            session = Session(files, self.geometry)
            with self.lock:
                job.update(status={"state": "ready"}, session=session)
        except Exception as exc:
            LOG.exception("Opening packet selection")
            update(state="error", error=str(exc))

    def close(self):
        self.worker.shutdown(wait=True)


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, workspace, **kwargs):
        self.work = workspace
        super().__init__(*args, **kwargs)

    def send(self, body, mime="application/json", status=200):
        if mime == "application/json":
            body = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        compress = len(body) > 16000 and "gzip" in self.headers.get(
            "Accept-Encoding", ""
        )
        if compress:
            body = gzip.compress(body, compresslevel=1)
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if compress:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.handle_route(False)

    def do_POST(self):
        self.handle_route(True)

    def handle_route(self, post):
        try:
            if self.headers.get("Sec-Fetch-Site") == "cross-site" or urlsplit(
                "//" + self.headers.get("Host", "")
            ).hostname not in ("localhost", "127.0.0.1"):
                return self.send(
                    {"error": "Use the loopback address or a local SSH forward."},
                    status=403,
                )
            url = urlsplit(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            path = url.path.strip("/")
            if path.startswith("api/") and not secrets.compare_digest(
                self.headers.get("Authorization", "").encode(),
                ("Bearer " + self.work.access_key).encode(),
            ):
                return self.send(
                    {
                        "error": "Open the private link printed by packet-explorer in the server terminal."
                    },
                    status=403,
                )
            if post:
                if (
                    path != "api/open"
                    or self.headers.get_content_type() != "application/json"
                ):
                    return self.send(
                        {"error": "Expected a JSON selection."}, status=400
                    )
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 2_000_000:
                    raise ValueError("Invalid selection length.")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Invalid selection.")
                return self.send({"job": self.work.open(payload.get("files"))})
            if path == "api/bootstrap":
                return self.send(
                    {
                        "root": str(self.work.root),
                        "initial": self.work.initial,
                        "tiles": self.work.geometry.tiles,
                    }
                )
            if path == "api/catalog":
                return self.send(self.work.catalog(q.get("dir", ".")))
            if path.startswith("api/"):
                return self.query(path.removeprefix("api/"), q)
            name = path or "index.html"
            if name not in (
                "index.html",
                "app.js",
                "style.css",
                "detector.js",
                "timeline.js",
            ):
                return self.send({"error": "Unknown page."}, status=404)
            return self.send(
                (WEB / name).read_bytes(), mimetypes.guess_type(name)[0] or "text/plain"
            )
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, KeyError, OSError, IndexError) as exc:
            self.send({"error": str(exc)}, status=400)
        except Exception:
            LOG.exception("Packet Explorer request failed")
            self.send({"error": "Query failed. See the server log."}, status=500)

    def query(self, action, q):
        with self.work.lock:
            job = self.work.jobs.get(q.get("job"))
            status = job["status"] if job else None
            session = job.get("session") if job else None
        if status is None:
            return self.send(
                {"error": "Session expired. Reopen the files."}, status=404
            )
        if action == "status":
            return self.send(status)
        if session is None:
            raise ValueError("The selected files are still opening.")
        if action == "session":
            return self.send(session.info)

        def number(name, default, lo, hi):
            value = int(q.get(name, default))
            if not lo <= value <= hi:
                raise ValueError(f"{name} must be between {lo} and {hi}")
            return value

        if action == "rows":
            file = number("file", 0, 0, len(session.files) - 1)
            index = session.files[file]
            start = number("start", 0, 0, index.meta["rows"])
            limit = number("limit", 40, 1, 200)
            return self.send(
                {
                    "total": index.meta["rows"],
                    "rows": index.rows(
                        range(start, min(start + limit, index.meta["rows"]))
                    ),
                }
            )
        view = session.views[q.get("scope", "aligned")]
        if action == "view":
            return self.send(view.info())
        iog = number("iog", 0, 0, 8)
        if action == "next":
            tick = number("t", 0, -1, view.length)
            direction = number("direction", 1, -1, 1)
            return self.send({"tick": view.next_tick(tick, direction or 1, iog)})
        with self.work.heavy:
            if action == "map":
                play = number("t", 0, 0, view.length - 1)
                width = number("width", 1, 1, 2**53 - 1)
                hold = number("hold", 0, 0, 2**53 - 1)
                records = view.map(
                    play,
                    width,
                    hold,
                    q.get("field", "occupancy"),
                    q.get("stat", "last"),
                    iog,
                )
                return self.send(records.tobytes(), "application/octet-stream")
            lo = number("lo", 0, 0, view.length - 1)
            hi = number("hi", view.length, lo + 1, view.length)
            if action == "timeline":
                return self.send(
                    view.timeline(
                        lo, hi, number("bins", 600, 1, 2000), iog, q.get("chips") == "1"
                    )
                )
            if action == "packets":
                pixel = number("pixel", -1, -1, self.work.geometry.size - 1)
                return self.send(
                    view.packets(
                        lo,
                        hi,
                        None if pixel < 0 else pixel,
                        number("skip", 0, 0, 2**53 - 1),
                        number("limit", 40, 1, 200),
                        iog,
                    )
                )
        return self.send({"error": "Unknown query."}, status=404)

    def log_message(self, fmt, *args):
        LOG.debug(fmt, *args)


def make_server(workspace, port):
    return ThreadingHTTPServer(
        ("127.0.0.1", port), partial(Handler, workspace=workspace)
    )
