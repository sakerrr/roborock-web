"""Render raw Roborock map bytes into a light, pastel PNG plus a room hit-mask.

The stock renderer in python-roborock uses the dark "Roborock blue" palette.
We parse the same bytes with our own palette so the map fits an airy UI, and
render a second, tiny image (one pixel per 5 cm block) that the browser uses
for hit-testing, selection highlights, the floor plan and the 3D view:

    red    room id (1-31), 0 when the pixel isn't part of a room
    green  what a non-room pixel is: 1 wall, 2 furniture/obstacle, 3 open floor
    blue   1 where the robot detected carpet
    alpha  0 outside the mapped area
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

# Lively earth tones for rooms (neighbouring room ids get clearly different
# hues); walls a warm charcoal, open floor and furniture warm neutrals.
ROOM_PALETTE: list[tuple[int, int, int]] = [
    (214, 132, 96),  # terracotta
    (139, 178, 125),  # sage
    (222, 176, 84),  # ochre
    (104, 158, 154),  # muted teal
    (205, 128, 122),  # clay
    (168, 172, 96),  # olive
    (229, 196, 140),  # sand
    (150, 112, 132),  # heather
    (194, 108, 78),  # rust
    (176, 150, 124),  # taupe
]

BASE_COLORS: dict[SupportedColor, tuple[int, ...]] = {
    SupportedColor.MAP_OUTSIDE: CLEAR,
    SupportedColor.MAP_INSIDE: (236, 230, 220, 255),
    SupportedColor.SCAN: (236, 230, 220, 255),
    SupportedColor.NEW_DISCOVERED_AREA: (236, 230, 220, 255),
    SupportedColor.MAP_WALL: (92, 86, 80, 255),
    SupportedColor.MAP_WALL_V2: (92, 86, 80, 255),
    SupportedColor.GREY_WALL: (196, 184, 168, 255),
    SupportedColor.UNKNOWN: (214, 206, 194, 255),
    SupportedColor.PATH: (255, 255, 255, 235),
    SupportedColor.NO_GO_ZONES: (239, 68, 68, 40),
    SupportedColor.NO_GO_ZONES_OUTLINE: (239, 68, 68, 190),
    SupportedColor.NO_MOPPING_ZONES: (139, 92, 246, 36),
    SupportedColor.NO_MOPPING_ZONES_OUTLINE: (139, 92, 246, 170),
    SupportedColor.VIRTUAL_WALLS: (239, 68, 68, 220),
}

# The image is just the floor plan. The path, walls, zones and obstacles go to the
# browser as data, so every view can draw them and you can switch them off.
BASE_DRAWABLES: list[Drawable] = []


class _NoCarpetParser(RoborockMapDataParser):
    """Skips the carpet checkerboard (it breaks room masks and looks busy), and reuses the
    image while only the robot and its path change: drawing it is a slow per-pixel loop."""

    image_key = ""
    _image: tuple[str, Any] | None = None

    def _parse_image(self, *, carpet_map, **kwargs):  # type: ignore[override]
        removed = kwargs.get("removed_map")
        key = hashlib.sha1(kwargs["header"] + kwargs["data"] + repr(sorted(removed) if removed else None).encode()).hexdigest()[:12]
        if self._image is None or self._image[0] != key:
            # Nothing draws on the result afterwards (no drawables, no rotation), so it can be shared.
            self._image = (key, super()._parse_image(carpet_map=None, **kwargs))
        self.image_key = key
        return self._image[1]


def _base_parser() -> RoborockMapDataParser:
    rooms = {str(i): (*ROOM_PALETTE[i % len(ROOM_PALETTE)], 255) for i in range(1, 33)}
    palette = ColorsPalette(dict(BASE_COLORS), rooms)
    sizes = Sizes({k: v * SCALE for k, v in Sizes.SIZES.items() if k != Size.MOP_PATH_WIDTH})
    return _NoCarpetParser(palette, sizes, list(BASE_DRAWABLES), ImageConfig(scale=SCALE), [])


def _mask_parser() -> RoborockMapDataParser:
    colors: dict[SupportedColor, tuple[int, ...]] = {c: CLEAR for c in SupportedColor}
    colors.update({
        SupportedColor.MAP_WALL: (0, 1, 0, 255),
        SupportedColor.MAP_WALL_V2: (0, 1, 0, 255),
        SupportedColor.GREY_WALL: (0, 2, 0, 255),
        SupportedColor.MAP_INSIDE: (0, 3, 0, 255),
        SupportedColor.SCAN: (0, 3, 0, 255),
        SupportedColor.UNKNOWN: (0, 3, 0, 255),
    })
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
    rooms: dict[int, dict[str, float]]  # room id -> label point (base px), area (m²), size (m)
    robot: dict[str, float] | None
    charger: dict[str, float] | None
    robot_room: int | None = None
    restrictions: list[dict[str, Any]] = field(default_factory=list)
    no_carpet_zones: int = 0
    things: dict[str, Any] = field(default_factory=dict)  # path, obstacles, zones…, in base px
    image_version: str = ""  # changes only when the images (floor, rooms, carpets) do
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

    def as_payload(self, names: dict[int, str], original_names: dict[int, str] | None = None, images: bool = True) -> dict[str, Any]:
        """The map for the browser. Without images when it already has this image_version."""
        originals = names if original_names is None else original_names

        def room(rid: int, p: dict[str, float]) -> dict[str, Any]:
            original = originals.get(rid) or f"Room {rid}"
            name = names.get(rid) or original
            return {"id": rid, "name": name, "original": original, "nickname": name != original, **p}

        return {
            "version": self.payload_version(names),
            "width": self.width,
            "height": self.height,
            "scale": SCALE,
            "image": self.image_version,
            **({
                "base": "data:image/png;base64," + base64.b64encode(self.base_png).decode(),
                "mask": "data:image/png;base64," + base64.b64encode(self.mask_png).decode(),
            } if images else {}),
            "rooms": [room(rid, p) for rid, p in sorted(self.rooms.items())],
            "robot": self.robot,
            "charger": self.charger,
            "robot_room": self.robot_room,
            "restrictions": self.restrictions,
            "no_carpet_zones": self.no_carpet_zones,
            **self.things,
            # base px <-> device mm: x_mm = (px / scale + left) * 50, y_mm = (top + height - 1 - py / scale) * 50
            "frame": {"top": self.top, "left": self.left, "height": self.img_height, "scale": SCALE, "mm": MM_PER_PIXEL},
        }


class MapRenderer:
    def __init__(self) -> None:
        self._base = _base_parser()
        self._mask = _mask_parser()
        self._images: tuple[str, tuple[bytes, bytes, dict[int, dict[str, float]]]] | None = None

    def render(self, raw: bytes) -> RenderedMap | None:
        base = self._base.parse(raw)
        if base.image is None or base.image.is_empty:
            return None
        dims = base.image.dimensions
        base_img: Image.Image = base.image.data

        # While it cleans, the map changes every few seconds but the floor and rooms rarely
        # do: keep the room mask, the PNGs and room info until the image or the carpets change.
        carpets = hashlib.sha1(repr(sorted(base.carpet_map or ())).encode()).hexdigest()[:6]
        image_version = f"{self._base.image_key}{carpets}"
        if self._images is None or self._images[0] != image_version:
            mask = self._mask.parse(raw)
            mask_img: Image.Image = mask.image.data.copy() if mask.image is not None else Image.new("RGBA", (1, 1))
            _stamp_carpets(mask_img, mask.carpet_map)
            self._images = (image_version, (_png(base_img), _png(mask_img), _room_info(mask_img)))
        base_png, mask_png, rooms = self._images[1]

        return RenderedMap(
            version=hashlib.sha1(raw).hexdigest()[:12],
            image_version=image_version,
            width=base_img.width,
            height=base_img.height,
            base_png=base_png,
            mask_png=mask_png,
            rooms=rooms,
            robot=_point(base, base.vacuum_position, with_angle=True),
            charger=_point(base, base.charger),
            robot_room=base.vacuum_room,
            restrictions=_restrictions(base),
            no_carpet_zones=len(base.no_carpet_areas or []),
            things=_things(base),
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


def _stamp_carpets(mask: Image.Image, carpet: set[int] | None) -> None:
    """Mark carpet pixels in the mask's blue channel (indices count rows from the bottom)."""
    if not carpet:
        return
    px = mask.load()
    w, h = mask.size
    for idx in carpet:
        x, y = idx % w, h - 1 - idx // w
        if 0 <= y < h:
            r, g, _b, a = px[x, y]
            if a:
                px[x, y] = (r, g, 1, a)


# What the parser calls an obstacle -> (icon kind, label).
OBSTACLE_KINDS = {
    "cable": ("cable", "Cable"),
    "extension cord": ("cable", "Extension cord"),
    "pet waste": ("pet_waste", "Pet waste"),
    "poop": ("pet_waste", "Pet waste"),
    "shoes": ("shoes", "Shoes"),
    "clothes": ("clothes", "Clothes"),
    "fabric/paper balls": ("clothes", "Fabric or paper"),
    "pet": ("pet", "Pet"),
    "pedestal": ("furniture", "Pedestal"),
    "weighting scale": ("furniture", "Scale"),
    "dustpan": ("furniture", "Dustpan"),
    "furniture with a crossbar": ("furniture", "Furniture"),
}


def _things(map_data: MapData) -> dict[str, Any]:
    """Everything worth drawing on top of the floor, in base-image pixels."""
    assert map_data.image is not None
    dims = map_data.image.dimensions

    def px(p: Point) -> list[float]:
        q = p.to_img(dims)
        return [round(q.x, 1), round(q.y, 1)]

    def segments(path: Any) -> list[list[list[float]]]:
        # Drop points closer than ~2 cm to the last one kept; paths can have thousands.
        out = []
        for seg in getattr(path, "path", None) or []:
            kept: list[list[float]] = []
            for p in seg:
                q = px(p)
                if not kept or abs(q[0] - kept[-1][0]) + abs(q[1] - kept[-1][1]) >= 1.5:
                    kept.append(q)
            if len(kept) > 1:
                out.append(kept)
        return out

    obstacles = []
    seen: set[tuple[int, int]] = set()
    for o in [*(map_data.obstacles or []), *(map_data.obstacles_with_photo or [])]:
        q = px(o)
        key = (round(q[0]), round(q[1]))
        if key in seen:
            continue
        seen.add(key)
        kind, label = OBSTACLE_KINDS.get(o.details.description or "", ("obstacle", "Obstacle"))
        obstacles.append({"x": q[0], "y": q[1], "kind": kind, "label": label, "photo": bool(o.details.photo_name)})

    def area(a: Any) -> list[list[float]]:
        return [px(Point(x, y)) for x, y in zip(a.as_list()[::2], a.as_list()[1::2])]

    return {
        "path": segments(map_data.path),
        "mop_path": segments(map_data.mop_path),
        "obstacles": obstacles,
        "no_carpet": [area(a) for a in map_data.no_carpet_areas or []],
        "zones": [[*px(Point(z.x0, z.y0)), *px(Point(z.x1, z.y1))] for z in map_data.zones or []],
        "goto": px(map_data.goto) if map_data.goto else None,
        "goto_path": segments(map_data.predicted_path),
    }


def _room_info(mask: Image.Image) -> dict[int, dict[str, float]]:
    """Label point, floor area and bounding size for each room.

    The label goes on the room pixel nearest the room's centroid, so it always
    lands inside the room even for L-shaped ones.
    """
    w, _h = mask.size
    block_m = MM_PER_PIXEL / 1000
    pixels: dict[int, list[tuple[int, int]]] = {}
    # getdata() is deprecated in newer Pillow in favour of get_flattened_data().
    data = mask.get_flattened_data() if hasattr(mask, "get_flattened_data") else mask.getdata()
    for idx, (r, _g, _b, a) in enumerate(data):
        if a and r:
            pixels.setdefault(r, []).append((idx % w, idx // w))
    info: dict[int, dict[str, float]] = {}
    for rid, pts in pixels.items():
        if len(pts) < 20:  # specks, not rooms
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        cx, cy = sum(xs) / len(pts), sum(ys) / len(pts)
        bx, by = min(pts, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)
        info[rid] = {
            "x": (bx + 0.5) * SCALE,
            "y": (by + 0.5) * SCALE,
            "area": round(len(pts) * block_m * block_m, 1),
            "w": round((max(xs) - min(xs) + 1) * block_m, 1),
            "h": round((max(ys) - min(ys) + 1) * block_m, 1),
        }
    return info
