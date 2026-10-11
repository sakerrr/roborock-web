"""Cleaning history and room freshness.

Every finished run is kept as a coverage map: the 5 cm blocks the robot passed
over, and the ones it mopped. From those the app works out when each spot and
each room was last cleaned, and which rooms are due for a clean.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import statistics
import time
import zlib
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw

from maprender import SCALE, RenderedMap

_LOGGER = logging.getLogger(__name__)

SWATH = 6  # blocks (30 cm): what one pass of the robot covers
ROOM_DONE = 0.5  # a run that covered half a room's floor counts as cleaning the room
KEEP_DAYS = 120
DEFAULT_INTERVAL = 7  # days a room can go before it's due
INTERVALS = [1, 2, 3, 7, 14]  # what the app offers
RECENT_RUNS = 12  # how many runs the app lists

Line = list[tuple[float, float]]


@dataclass
class Grid:
    """1-bit coverage images on a map's block grid, anchored in robot coordinates."""

    x0: int  # robot block x of the first column
    ytop: int  # robot block y of the first row (rows go down, robot y goes up)
    w: int
    h: int
    clean: str  # packed 1-bit image
    mop: str | None = None


@dataclass
class Run:
    id: str
    begin: int  # unix time
    end: int
    duration: int | None = None  # seconds
    area: float | None = None  # m²
    complete: bool | None = None
    map_flag: int | None = None
    source: str = "live"  # live: seen finishing by this app; robot: from the robot's own list; demo
    mode: str | None = None  # cleaning mode (vacuum, vac_and_mop…), when known
    grid: Grid | None = None  # None when the path isn't known


def _pack(img: Image.Image) -> str:
    return base64.b64encode(zlib.compress(img.tobytes(), 9)).decode()


def _unpack(data: str, w: int, h: int) -> Image.Image:
    return Image.frombytes("1", (w, h), zlib.decompress(base64.b64decode(data)))


def grid_from_lines(clean: list[Line], mop: list[Line], x0: int, ytop: int, w: int, h: int) -> Grid | None:
    """Coverage from paths in grid blocks (x to the right, y down from the top-left)."""

    def draw(lines: list[Line]) -> Image.Image | None:
        img = Image.new("1", (w, h))
        pen = ImageDraw.Draw(img)
        drawn = False
        for line in lines:
            if len(line) > 1:
                pen.line(line, fill=255, width=SWATH, joint="curve")
                drawn = True
        return img if drawn else None

    c = draw(clean)
    if c is None:
        return None
    m = draw(mop)
    return Grid(x0, ytop, w, h, _pack(c), _pack(m) if m else None)


def grid_from_map(m: RenderedMap) -> Grid | None:
    """Where the robot went on the run a map shows (a map's path is its last run)."""

    def blocks(lines: list[list[list[float]]]) -> list[Line]:
        return [[(x / SCALE, y / SCALE) for x, y in line] for line in lines]

    return grid_from_lines(
        blocks(m.things.get("path") or []),
        blocks(m.things.get("mop_path") or []),
        m.left, m.top + m.img_height - 1, m.width // SCALE, m.height // SCALE,
    )


class History:
    """The runs and per-room settings of one robot, kept in a small JSON file."""

    def __init__(self, path: Path | None) -> None:
        self._path = path
        self.runs: list[Run] = []
        self.intervals: dict[str, int] = {}
        self.created = int(time.time())  # when this app started keeping track
        self.rev = 0
        if path and path.exists():
            try:
                raw = json.loads(path.read_text())
                self.created = int(raw.get("created") or self.created)
                self.intervals = {str(k): int(v) for k, v in (raw.get("intervals") or {}).items()}
                for r in raw.get("runs") or []:
                    grid = r.pop("grid", None)
                    self.runs.append(Run(**r, grid=Grid(**grid) if grid else None))
            except (OSError, ValueError, TypeError) as err:
                _LOGGER.warning("Ignoring unreadable cleaning history %s: %s", path, err)

    @property
    def since(self) -> int:
        """Since when there's coverage to go by: the app's start, or older runs with a map."""
        mapped = [r.begin for r in self.runs if r.grid]
        return min([self.created, *mapped])

    def has(self, run_id: str) -> bool:
        return any(r.id == run_id for r in self.runs)

    def add(self, run: Run) -> None:
        cutoff = time.time() - KEEP_DAYS * 86400
        runs = [r for r in self.runs if r.id != run.id and r.end >= cutoff]
        if run.end >= cutoff:
            runs.append(run)
        self.runs = sorted(runs, key=lambda r: r.begin)
        self._changed()

    def interval(self, flag: int | None, room: int) -> int:
        return self.intervals.get(f"{flag}:{room}", DEFAULT_INTERVAL)

    def set_interval(self, flag: int | None, room: int, days: int) -> None:
        if days not in INTERVALS:
            raise ValueError("Pick one of the offered intervals")
        self.intervals[f"{flag}:{room}"] = days
        self._changed()

    def _changed(self) -> None:
        self.rev += 1
        if not self._path:
            return
        data = {"created": self.created, "intervals": self.intervals, "runs": [asdict(r) for r in self.runs]}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, separators=(",", ":")))
        os.replace(tmp, self._path)


def estimate_model(history: History) -> dict[str, Any]:
    """How long cleaning takes in this home, learned from past runs:
    seconds = overhead (leaving and returning, washing the mop) + rate x m²."""

    def fit(runs: list[Run]) -> dict[str, float] | None:
        pts = [(r.area, r.duration) for r in runs if r.area and r.duration and r.area >= 3 and r.duration >= 60]
        if len(pts) < 2:
            return None
        areas = [a for a, _ in pts]
        if len(pts) >= 4 and max(areas) - min(areas) >= 5:
            mean_a = sum(areas) / len(pts)
            mean_d = sum(d for _, d in pts) / len(pts)
            rate = sum((a - mean_a) * (d - mean_d) for a, d in pts) / sum((a - mean_a) ** 2 for a in areas)
            overhead = mean_d - rate * mean_a
            if 15 <= rate <= 400 and 0 <= overhead <= 900:
                return {"rate": round(rate, 1), "overhead": round(overhead), "runs": len(pts)}
        # Few runs, or they don't line up: a typical overhead and the median pace.
        overhead = 120
        rate = statistics.median(max(15.0, (d - overhead) / a) for a, d in pts)
        return {"rate": round(rate, 1), "overhead": overhead, "runs": len(pts)}

    modes = {}
    for mode in sorted({r.mode for r in history.runs if r.mode}):
        if found := fit([r for r in history.runs if r.mode == mode]):
            modes[mode] = found
    return {"overall": fit(history.runs), "modes": modes}


def _place(img: Image.Image, g: Grid, x0: int, ytop: int, w: int, h: int) -> Image.Image:
    """A run's coverage on the current map's grid (the map can grow between runs)."""
    if (g.x0, g.ytop, g.w, g.h) == (x0, ytop, w, h):
        return img
    out = Image.new("1", (w, h))
    out.paste(img, (g.x0 - x0, ytop - g.ytop))
    return out


def _count(img: Image.Image) -> int:
    return img.histogram()[255]


def freshness(history: History, m: RenderedMap, flag: int | None, now: float | None = None) -> dict[str, Any]:
    """When each spot and each room of this map was last cleaned, and what's due."""
    now = time.time() if now is None else now
    mask = Image.open(io.BytesIO(m.mask_png)).convert("RGBA")
    w, h = mask.size
    x0, ytop = m.left, m.top + m.img_height - 1
    on_map = [r for r in history.runs if r.map_flag is None or flag is None or r.map_flag == flag]

    # The last time each block was cleaned and mopped, in minutes (0 = never),
    # painted oldest run first so newer runs win.
    clean_t = Image.new("I", (w, h), 0)
    mop_t = Image.new("I", (w, h), 0)
    laid: list[tuple[Run, Image.Image, Image.Image | None]] = []
    for r in on_map:
        g = r.grid
        if g is None:
            continue
        c = _place(_unpack(g.clean, g.w, g.h), g, x0, ytop, w, h)
        mp = _place(_unpack(g.mop, g.w, g.h), g, x0, ytop, w, h) if g.mop else None
        clean_t.paste(r.end // 60, None, c)
        if mp is not None:
            mop_t.paste(r.end // 60, None, mp)
        laid.append((r, c, mp))

    def days(t: Image.Image) -> Image.Image:
        # Whole days since; "never" comes out huge and clamps to 255.
        return t.point(lambda v: v * (-1 / 1440) + now / 86400).convert("L")

    clean_days = days(clean_t)
    age = Image.merge("RGBA", (clean_days, days(mop_t), Image.new("L", (w, h), 0), mask.getchannel("A")))

    red = mask.getchannel("R")
    since = history.since
    room_masks: dict[int, tuple[Image.Image, int]] = {}
    for rid in sorted(m.rooms):
        room = red.point(lambda v, rid=rid: 255 if v == rid else 0).convert("1", dither=Image.Dither.NONE)
        if total := _count(room):
            room_masks[rid] = (room, total)

    def share(rid: int, cover: Image.Image) -> float:
        room, total = room_masks[rid]
        return _count(ImageChops.logical_and(room, cover)) / total

    rooms = []
    for rid in room_masks:
        last_clean = next((r.end for r, c, _ in reversed(laid) if share(rid, c) >= ROOM_DONE), None)
        last_mop = next((r.end for r, _, mp in reversed(laid) if mp is not None and share(rid, mp) >= ROOM_DONE), None)
        interval = history.interval(flag, rid)
        recent = clean_days.point(lambda d, k=interval: 255 if d <= k else 0).convert("1", dither=Image.Dither.NONE)
        due_from = last_clean if last_clean is not None else since
        rooms.append({
            "id": rid,
            "last_cleaned": last_clean,
            "last_mopped": last_mop,
            "interval": interval,
            "fresh": round(share(rid, recent), 3),  # share of the floor cleaned within the interval
            "overdue": now - due_from > interval * 86400,
        })

    covers = {r.id: (c, mp) for r, c, mp in laid}
    runs = []
    for r in reversed(on_map[-RECENT_RUNS:]):
        c, mp = covers.get(r.id, (None, None))
        runs.append({
            "begin": r.begin, "end": r.end, "duration": r.duration, "area": r.area, "complete": r.complete,
            "source": r.source, "mapped": c is not None, "mopped": mp is not None,
            "rooms": [rid for rid in room_masks if c is not None and share(rid, c) >= ROOM_DONE],
        })

    buf = io.BytesIO()
    age.save(buf, format="PNG", optimize=True)
    return {
        "available": True,
        "map": m.version,  # the map this was worked out for
        "since": since,
        "tracked": len(laid),  # runs with a known path on this map
        "age": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
        "rooms": rooms,
        "runs": runs,
        "intervals": INTERVALS,
    }
