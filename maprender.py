"""Render raw Roborock map bytes into a light, pastel PNG plus a room hit-mask.

The stock renderer in python-roborock uses the dark "Roborock blue" palette.
We parse the same bytes with our own palette so the map fits an airy UI, and
render a second, tiny image where every room pixel encodes its room id in the
red channel. The browser uses that mask to hit-test taps and to draw
selection highlights without any geometry guesswork.
"""

from __future__ import annotations

import base64
import hashlib
import io
from dataclasses import dataclass, field
from typing import Any

from PIL import Image
from vacuum_map_parser_base.config.color import ColorsPalette, SupportedColor
from vacuum_map_parser_base.config.drawable import Drawable
from vacuum_map_parser_base.config.image_config import ImageConfig
from vacuum_map_parser_base.config.size import Size, Sizes
from vacuum_map_parser_base.map_data import MapData, Point
from vacuum_map_parser_roborock.map_data_parser import RoborockMapDataParser

SCALE = 4
MM_PER_PIXEL = 50  # Roborock map pixels are 50mm
CLEAR = (0, 0, 0, 0)

# Soft pastel rooms; walls a quiet slate.
ROOM_PALETTE: list[tuple[int, int, int]] = [
    (203, 223, 247),
    (209, 236, 221),
    (250, 225, 204),
    (229, 219, 248),
    (248, 214, 222),
    (208, 236, 240),
    (245, 236, 200),
    (220, 228, 240),
    (235, 222, 210),
    (214, 232, 205),
]

BASE_COLORS: dict[SupportedColor, tuple[int, ...]] = {
    SupportedColor.MAP_OUTSIDE: CLEAR,
    SupportedColor.MAP_INSIDE: (232, 236, 242, 255),
    SupportedColor.SCAN: (232, 236, 242, 255),
    SupportedColor.NEW_DISCOVERED_AREA: (232, 236, 242, 255),
    SupportedColor.MAP_WALL: (112, 126, 148, 255),
    SupportedColor.MAP_WALL_V2: (112, 126, 148, 255),
    SupportedColor.GREY_WALL: (176, 186, 201, 255),
    SupportedColor.UNKNOWN: (210, 215, 222, 255),
    SupportedColor.PATH: (255, 255, 255, 235),
    SupportedColor.NO_GO_ZONES: (239, 68, 68, 40),
    SupportedColor.NO_GO_ZONES_OUTLINE: (239, 68, 68, 190),
    SupportedColor.NO_MOPPING_ZONES: (139, 92, 246, 36),
    SupportedColor.NO_MOPPING_ZONES_OUTLINE: (139, 92, 246, 170),
    SupportedColor.VIRTUAL_WALLS: (239, 68, 68, 220),
}

# Walls and zones are drawn by the browser so they can be edited.
BASE_DRAWABLES = [Drawable.PATH]


class _NoCarpetParser(RoborockMapDataParser):
    """Skip the carpet checkerboard: it breaks room masks and looks busy."""

    def _parse_image(self, *, carpet_map, **kwargs):  # type: ignore[override]
        return super()._parse_image(carpet_map=None, **kwargs)


def _base_parser() -> RoborockMapDataParser:
    rooms = {str(i): (*ROOM_PALETTE[i % len(ROOM_PALETTE)], 255) for i in range(1, 33)}
    palette = ColorsPalette(dict(BASE_COLORS), rooms)
    sizes = Sizes({k: v * SCALE for k, v in Sizes.SIZES.items() if k != Size.MOP_PATH_WIDTH})
    return _NoCarpetParser(palette, sizes, list(BASE_DRAWABLES), ImageConfig(scale=SCALE), [])


def _mask_parser() -> RoborockMapDataParser:
    colors = {c: CLEAR for c in SupportedColor}
    palette = ColorsPalette(colors, {})
    # Room numbers are 5 bits (1..31); encode each id in the red channel.
    for i in range(0, 32):
        palette.cached_room_colors[i] = (i, 0, 0, 255)
        palette.cached_room_colors[str(i)] = (i, 0, 0, 255)
    return _NoCarpetParser(palette, Sizes({}), [], ImageConfig(scale=1), [])


@dataclass
class RenderedMap:
    version: str
    width: int
    height: int
    base_png: bytes
    mask_png: bytes
    rooms: dict[int, dict[str, float]]  # room id -> label point (base px)
    robot: dict[str, float] | None
    charger: dict[str, float] | None
    robot_room: int | None = None
    restrictions: list[dict[str, Any]] = field(default_factory=list)
    no_carpet_zones: int = 0
    # Values needed to turn base-image pixels back into device millimetres.
    top: int = 0
    left: int = 0
    img_height: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    def px_to_mm(self, x: float, y: float) -> tuple[int, int]:
        mx = (x / SCALE + self.left) * MM_PER_PIXEL
        my = (self.top + self.img_height - 1 - y / SCALE) * MM_PER_PIXEL
        return int(round(mx)), int(round(my))

    def payload_version(self, names: dict[int, str]) -> str:
        """Changes when the map or any room name changes (names can change on their own)."""
        tag = hashlib.sha1(repr(sorted(names.items())).encode()).hexdigest()[:6]
        return f"{self.version}-{tag}"

    def as_payload(self, names: dict[int, str], original_names: dict[int, str] | None = None) -> dict[str, Any]:
        originals = names if original_names is None else original_names

        def room(rid: int, p: dict[str, float]) -> dict[str, Any]:
            original = originals.get(rid) or f"Room {rid}"
            name = names.get(rid) or original
            return {"id": rid, "name": name, "original": original, "nickname": name != original, "x": p["x"], "y": p["y"]}

        return {
            "version": self.payload_version(names),
            "width": self.width,
            "height": self.height,
            "scale": SCALE,
            "base": "data:image/png;base64," + base64.b64encode(self.base_png).decode(),
            "mask": "data:image/png;base64," + base64.b64encode(self.mask_png).decode(),
            "rooms": [room(rid, p) for rid, p in sorted(self.rooms.items())],
            "robot": self.robot,
            "charger": self.charger,
            "robot_room": self.robot_room,
            "restrictions": self.restrictions,
            "no_carpet_zones": self.no_carpet_zones,
            # base px <-> device mm: x_mm = (px / scale + left) * 50, y_mm = (top + height - 1 - py / scale) * 50
            "frame": {"top": self.top, "left": self.left, "height": self.img_height, "scale": SCALE, "mm": MM_PER_PIXEL},
        }


class MapRenderer:
    def __init__(self) -> None:
        self._base = _base_parser()
        self._mask = _mask_parser()

    def render(self, raw: bytes) -> RenderedMap | None:
        base = self._base.parse(raw)
        if base.image is None or base.image.is_empty:
            return None
        mask = self._mask.parse(raw)
        dims = base.image.dimensions

        base_img: Image.Image = base.image.data
        mask_img: Image.Image = mask.image.data if mask.image is not None else Image.new("RGBA", (1, 1))

        return RenderedMap(
            version=hashlib.sha1(raw).hexdigest()[:12],
            width=base_img.width,
            height=base_img.height,
            base_png=_png(base_img),
            mask_png=_png(mask_img),
            rooms=_room_labels(mask_img),
            robot=_point(base, base.vacuum_position, with_angle=True),
            charger=_point(base, base.charger),
            robot_room=base.vacuum_room,
            restrictions=_restrictions(base),
            no_carpet_zones=len(base.no_carpet_areas or []),
            top=dims.top,
            left=dims.left,
            img_height=dims.height,
        )


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _point(map_data: MapData, p: Point | None, with_angle: bool = False) -> dict[str, float] | None:
    if p is None or map_data.image is None:
        return None
    ip = p.to_img(map_data.image.dimensions)
    out = {"x": round(ip.x, 1), "y": round(ip.y, 1)}
    if with_angle:
        out["a"] = p.a or 0
    return out


def _restrictions(map_data: MapData) -> list[dict[str, Any]]:
    """Invisible walls and no-go / no-mop zones, in device millimetres.

    These are exactly what the robot reported, so items the user didn't touch go
    back unchanged when edits are saved. The browser converts them with `frame`.
    """
    out: list[dict[str, Any]] = []
    for i, w in enumerate(map_data.walls or []):
        out.append({"id": f"wall-{i}", "type": "wall", "mm": [int(v) for v in (w.x0, w.y0, w.x1, w.y1)]})
    for kind, areas in (("no_go", map_data.no_go_areas), ("no_mop", map_data.no_mopping_areas)):
        for i, a in enumerate(areas or []):
            out.append({"id": f"{kind}-{i}", "type": kind, "mm": [int(v) for v in a.as_list()]})
    return out


def _room_labels(mask: Image.Image) -> dict[int, dict[str, float]]:
    """Pick a label point inside each room: the room pixel nearest its centroid."""
    w, h = mask.size
    data = mask.getdata()
    sums: dict[int, list[float]] = {}
    pixels: dict[int, list[tuple[int, int]]] = {}
    for idx, (r, _g, _b, a) in enumerate(data):
        if a == 0 or r == 0:
            continue
        x, y = idx % w, idx // w
        s = sums.setdefault(r, [0.0, 0.0, 0.0])
        s[0] += x
        s[1] += y
        s[2] += 1
        pixels.setdefault(r, []).append((x, y))
    labels: dict[int, dict[str, float]] = {}
    for rid, (sx, sy, n) in sums.items():
        if n < 20:  # specks, not rooms
            continue
        cx, cy = sx / n, sy / n
        bx, by = min(pixels[rid], key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)
        labels[rid] = {"x": (bx + 0.5) * SCALE, "y": (by + 0.5) * SCALE}
    return labels
