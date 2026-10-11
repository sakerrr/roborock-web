"""A simulated Qrevo S for trying the UI without a robot (`--demo`).

The map is built as a genuine Roborock map binary and goes through the same
renderer as the real thing, so what you see here is what you get.
"""

from __future__ import annotations

import asyncio
import math
import struct
import time
from collections import deque
from typing import Any

from maprender import MapRenderer, RenderedMap
from robot import RoomNames, build_restriction_payload

W, H = 170, 124  # map size in 50mm blocks
TOP, LEFT = 450, 440
WALL, INSIDE = 0x01, 0xFF

ROOMS: dict[int, tuple[str, tuple[int, int, int, int]]] = {
    16: ("Living room", (4, 4, 92, 70)),
    17: ("Kitchen", (92, 4, 166, 50)),
    20: ("Hallway", (92, 50, 128, 120)),
    18: ("Bedroom", (4, 70, 64, 120)),
    19: ("Bathroom", (64, 70, 92, 120)),
    21: ("Office", (128, 50, 166, 120)),
}
# Door gaps (x0, y0, x1, y1) and which rooms they connect, with a pass-through point.
DOORS: list[tuple[tuple[int, int, int, int], int, int, tuple[float, float]]] = [
    ((91, 20, 93, 34), 16, 17, (91.5, 27)),
    ((91, 55, 93, 67), 16, 20, (91.5, 61)),
    ((40, 69, 55, 71), 16, 18, (47.5, 69.5)),
    ((91, 90, 93, 102), 19, 20, (91.5, 96)),
    ((127, 80, 129, 94), 20, 21, (127.5, 87)),
    ((98, 49, 124, 51), 17, 20, (111, 49.5)),
]
CHARGER = (30.0, 5.0)
DOCKED_POS = (30.0, 9.0)
SPEED = 26.0  # blocks per second, sped up for the demo

FAN = [("quiet", 101), ("balanced", 102), ("turbo", 103), ("max", 104), ("max_plus", 108), ("off", 105),
       ("smart_mode", 110), ("custom", 106)]
WATER = [("off", 200), ("low", 201), ("medium", 202), ("high", 203), ("smart_mode", 209), ("custom", 204)]
MOP = [("standard", 300), ("deep", 301), ("deep_plus", 303), ("fast", 304), ("smart_mode", 306), ("custom", 302)]
PRESETS = {
    "vacuum": (102, 200, 300),
    "vac_and_mop": (102, 202, 300),
    "mop": (105, 202, 300),
    "custom": (106, 204, 302),
    "smart_mode": (110, 209, 306),
}


def _grid() -> bytearray:
    room_at = [[0] * W for _ in range(H)]
    for rid, (_, (x0, y0, x1, y1)) in ROOMS.items():
        for y in range(y0, y1):
            for x in range(x0, x1):
                room_at[y][x] = rid
    px = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            rid = room_at[y][x]
            if not rid:
                continue
            edge = any(
                not (0 <= nx < W and 0 <= ny < H) or room_at[ny][nx] != rid
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
            )
            # Interior walls: only draw on one side so they stay 1 block thick.
            outer = any(
                not (0 <= nx < W and 0 <= ny < H) or room_at[ny][nx] == 0
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
            )
            inner = (x + 1 < W and room_at[y][x + 1] not in (0, rid)) or (
                y + 1 < H and room_at[y + 1][x] not in (0, rid)
            )
            px[y * W + x] = WALL if edge and (outer or inner) else (rid << 3) | 7
    for (x0, y0, x1, y1), *_ in DOORS:
        for y in range(y0, y1):
            for x in range(x0, x1):
                if room_at[y][x] and not _on_outer(room_at, x, y):
                    px[y * W + x] = (room_at[y][x] << 3) | 7
    # A sofa and a kitchen island, as the robot would see them.
    for (x0, y0, x1, y1) in ((20, 46, 58, 54), (118, 22, 146, 30)):
        for y in range(y0, y1):
            for x in range(x0, x1):
                if x in (x0, x1 - 1) or y in (y0, y1 - 1):
                    px[y * W + x] = 0x08
    return px


def _on_outer(room_at, x, y) -> bool:
    return any(
        not (0 <= nx < W and 0 <= ny < H) or room_at[ny][nx] == 0
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
    )


GRID = _grid()


def _mm(p: tuple[float, float]) -> tuple[int, int]:
    return int((LEFT + p[0]) * 50), int((TOP + p[1]) * 50)


def _block(btype: int, header_extra: bytes, data: bytes) -> bytes:
    return struct.pack("<HHI", btype, 8 + len(header_extra), len(data)) + header_extra + data


def _rect_mm(x0: float, y0: float, x1: float, y1: float) -> tuple[int, ...]:
    """Zone corners in the order the app uses: top-left, top-right, bottom-right, bottom-left."""
    return (*_mm((x0, y1)), *_mm((x1, y1)), *_mm((x1, y0)), *_mm((x0, y0)))


def build_map(
    robot: tuple[float, float],
    angle: float,
    path: list[tuple[float, float]],
    seq: int,
    grid: bytes = bytes(GRID),
    walls: list[tuple[int, ...]] = (),  # type: ignore[assignment]
    no_go: list[tuple[int, ...]] = (),  # type: ignore[assignment]
    no_mop: list[tuple[int, ...]] = (),  # type: ignore[assignment]
) -> bytes:
    blocks = [
        _block(1, b"", struct.pack("<ii", *_mm(CHARGER))),
        _block(2, struct.pack("<iiii", TOP, LEFT, H, W), bytes(grid)),
    ]
    for btype, items, fmt in ((10, walls, "<4H"), (9, no_go, "<8H"), (12, no_mop, "<8H")):
        if items:
            blocks.append(_block(btype, struct.pack("<H", len(items)), b"".join(struct.pack(fmt, *i) for i in items)))
    if len(path) > 1:
        pts = b"".join(struct.pack("<hh", *_mm(p)) for p in path)
        blocks.append(_block(3, struct.pack("<III", len(path), 2, int(angle)), pts))
    blocks.append(_block(8, b"", struct.pack("<iii", *_mm(robot), int(angle))))
    body = b"".join(blocks)
    header = b"rr" + struct.pack("<HIHHII", 20, 20 + len(body), 1, 0, 0, seq)
    return header + body


def _room_of(p: tuple[float, float]) -> int | None:
    for rid, (_, (x0, y0, x1, y1)) in ROOMS.items():
        if x0 <= p[0] < x1 and y0 <= p[1] < y1:
            return rid
    return None


def _route(a: tuple[float, float], b: tuple[float, float]) -> list[tuple[float, float]]:
    """Walk through door points from a's room to b's room."""
    ra, rb = _room_of(a), _room_of(b)
    if ra is None or rb is None or ra == rb:
        return [b]
    prev: dict[int, tuple[int, tuple[float, float]] | None] = {ra: None}
    q = deque([ra])
    while q:
        r = q.popleft()
        for _, r1, r2, pt in DOORS:
            for x, y in ((r1, r2), (r2, r1)):
                if x == r and y not in prev:
                    prev[y] = (r, pt)
                    q.append(y)
    pts: list[tuple[float, float]] = [b]
    r = rb
    while prev.get(r):
        r, pt = prev[r]  # type: ignore[misc]
        pts.append(pt)
    return list(reversed(pts))


def _serpentine(rect: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    x0, y0, x1, y1 = rect
    pts: list[tuple[float, float]] = []
    y, flip = y0 + 3, False
    while y <= y1 - 3:
        row = [(x0 + 3, y), (x1 - 3, y)]
        pts.extend(reversed(row) if flip else row)
        y += 4
        flip = not flip
    return pts


class DemoController:
    def __init__(self) -> None:
        self.duid = "demo-qrevo-s"
        self._renderer = MapRenderer()
        self._map: RenderedMap | None = None
        self._map_key: tuple | None = None
        self.state = "charging"
        self.battery = 100
        self.in_cleaning = "complete"
        self.fan, self.water, self.mop = PRESETS["vac_and_mop"]
        self.pos = DOCKED_POS
        self.angle = 90.0
        self.path: list[tuple[float, float]] = []
        self._route: list[tuple[float, float]] = []
        self._route_kind = ""
        self._last_tick = time.monotonic()
        self._busy_until = 0.0
        self.clean_time = 0.0
        self.clean_area = 0.0
        self.settings_state: dict[str, Any] = {
            "volume": 60,
            "dnd": {"enabled": True, "start": "22:00", "end": "08:00"},
            "child_lock": False,
            "led": True,
            "flow_led": None,
            "carpet_boost": True,
            "dust_mode": {"value": "balanced", "options": ["smart", "light", "balanced", "max"]},
            "wash_mode": {"value": "balanced", "options": ["light", "balanced", "deep", "smart"]},
            "smart_wash": {"enabled": True},
            "mop_dryer": {"enabled": True, "dry_time": 10800},
        }
        # Editable map state (the real robot keeps this on its side).
        self.grid = bytearray(GRID)
        self.names = {rid: name for rid, (name, _) in ROOMS.items()}
        self.nicknames = RoomNames(None)
        self.walls: list[tuple[int, ...]] = [(*_mm((92, 88)), *_mm((92, 104)))]  # bathroom door
        self.no_go: list[tuple[int, ...]] = [_rect_mm(150, 6, 162, 15)]  # pet bowls
        self.no_mop: list[tuple[int, ...]] = [_rect_mm(14, 84, 44, 106)]  # bedroom rug
        self._edit_rev = 0
        self.consumables = {
            "main_brush_work_time": 412000, "side_brush_work_time": 655000, "filter_work_time": 210000,
            "sensor_dirty_time": 99000, "strainer_work_times": 40, "cleaning_brush_work_times": 120,
            "dust_collection_work_times": 61,
        }

    # ---------- simulation ----------

    def _tick(self) -> None:
        now = time.monotonic()
        dt, self._last_tick = now - self._last_tick, now
        if self._busy_until and now >= self._busy_until:
            self._busy_until = 0.0
            self.state = "charging"
        if self.state in ("charging", "charging_complete"):
            self.battery = min(100, self.battery + dt * 0.5)
            self.state = "charging_complete" if self.battery >= 100 else "charging"
            return
        if not self._route or self.state in ("paused", "idle", "error"):
            return
        step = SPEED * dt
        moved = 0.0
        while step > 0 and self._route:
            tx, ty = self._route[0]
            dx, dy = tx - self.pos[0], ty - self.pos[1]
            dist = math.hypot(dx, dy)
            if dist > 0.01:
                self.angle = math.degrees(math.atan2(dy, dx))
            if dist <= step:
                self.pos = (tx, ty)
                self._route.pop(0)
                step -= dist
                moved += dist
            else:
                self.pos = (self.pos[0] + dx / dist * step, self.pos[1] + dy / dist * step)
                moved += step
                step = 0
            self.path.append(self.pos)
        if self.state not in ("returning_home",):
            self.clean_time += dt * 6  # sped up like the motion
            self.clean_area += moved * 0.05 * 0.2
            self.battery = max(5, self.battery - dt * 0.12)
        if not self._route:
            self._arrived()

    def _arrived(self) -> None:
        if self._route_kind == "dock":
            self.pos, self.angle = DOCKED_POS, 90.0
            self.state = "charging"
            self.in_cleaning = "complete"
        elif self._route_kind == "goto":
            self.state = "idle"
        else:
            self._go_dock()

    def _start(self, targets: list[tuple[float, float, float, float]], state: str, job: str) -> None:
        route: list[tuple[float, float]] = []
        cur = self.pos
        for rect in targets:
            snake = _serpentine(rect)
            if not snake:
                continue
            route += _route(cur, snake[0]) + snake
            cur = snake[-1]
        self._route, self._route_kind = route, "clean"
        self.path = [self.pos]
        self.state, self.in_cleaning = state, job
        self.clean_time = self.clean_area = 0.0

    def _go_dock(self) -> None:
        self._route = _route(self.pos, DOCKED_POS) + [DOCKED_POS]
        self._route_kind = "dock"
        self.state = "returning_home"

    def _rendered(self) -> RenderedMap:
        key = (round(self.pos[0], 1), round(self.pos[1], 1), len(self.path), self._edit_rev)
        if self._map is None or key != self._map_key:
            path = self.path[:: max(1, len(self.path) // 1500)] + ([self.pos] if self.path else [])
            raw = build_map(self.pos, self.angle, path, len(self.path), self.grid, self.walls, self.no_go, self.no_mop)
            self._map = self._renderer.render(raw)
            self._map_key = key
        assert self._map is not None
        return self._map

    # ---------- map editing ----------

    def _require_editable(self) -> None:
        if self.state not in ("charging", "charging_complete", "idle", "paused"):
            raise ValueError("Pause or dock the robot before editing the map")

    def _room_pixels(self, rid: int) -> list[int]:
        return [i for i, v in enumerate(self.grid) if v & 7 == 7 and v >> 3 == rid]

    def _room_rect(self, rid: int) -> tuple[float, float, float, float]:
        px = self._room_pixels(rid)
        if not px:
            raise ValueError(f"Room {rid} isn't on the map")
        xs, ys = [i % W for i in px], [i // W for i in px]
        return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)

    def _merge(self, a: int, b: int) -> None:
        if a == b:
            raise ValueError("Pick two different rooms")
        pa, pb = set(self._room_pixels(a)), self._room_pixels(b)
        if not pa or not pb:
            raise ValueError("Room not found")
        # Rooms are separated by walls one block thick, so look two blocks out.
        steps = (1, -1, W, -W, 2, -2, 2 * W, -2 * W)
        if not any(i + d in pa for i in pb for d in steps):
            raise ValueError("Those rooms aren't next to each other")
        for i in pb:
            self.grid[i] = (a << 3) | 7
        self.names.pop(b, None)

    def _split(self, room: int, line: list[float]) -> None:
        ax, ay, bx, by = line
        ax, bx = ax / 50 - LEFT, bx / 50 - LEFT
        ay, by = ay / 50 - TOP, by / 50 - TOP
        px = self._room_pixels(room)
        if not px:
            raise ValueError("Room not found")
        used = {v >> 3 for v in self.grid if v & 7 == 7}
        new = next((n for n in range(16, 32) if n not in used), None)
        if new is None:
            raise ValueError("No room numbers left on this map")
        side = [i for i in px if (bx - ax) * (i // W - ay) - (by - ay) * (i % W - ax) > 0]
        if len(side) < 40 or len(px) - len(side) < 40:
            raise ValueError("Draw the line all the way across the room")
        for i in side:
            self.grid[i] = (new << 3) | 7

    # ---------- API (mirrors DeviceController) ----------

    async def status(self, force: bool = False) -> dict[str, Any]:
        self._tick()
        st = self.state
        phase = {
            "charging": "docked", "charging_complete": "docked", "paused": "paused", "idle": "idle",
            "returning_home": "returning", "emptying_the_bin": "dock", "washing_the_mop": "dock",
            "error": "error",
        }.get(st, "cleaning")
        if self.fan == 110 or self.water == 209 or self.mop == 306:
            mode = "smart_mode"
        elif self.fan == 106 or self.water == 204 or self.mop == 302:
            mode = "custom"
        elif self.water == 200:
            mode = "vacuum"
        elif self.fan == 105:
            mode = "mop"
        else:
            mode = "vac_and_mop"
        return {
            "duid": self.duid, "name": "Qrevo S (demo)", "model": "roborock.vacuum.a104", "product": "Qrevo S",
            "connected": True, "local": True, "state": st, "phase": phase,
            "job": self.in_cleaning != "complete", "job_type": self.in_cleaning,
            "battery": round(self.battery), "clean_time": int(self.clean_time),
            "clean_area": round(self.clean_area, 1), "clean_percent": None,
            "error": None, "dock_error": None, "map_flag": 0,
            "mode": {
                "cleaning": mode, "cleaning_options": list(PRESETS),
                "fan": self.fan, "fan_options": [{"code": c, "name": n} for n, c in FAN],
                "water": self.water, "water_options": [{"code": c, "name": n} for n, c in WATER],
                "mop": self.mop, "mop_options": [{"code": c, "name": n} for n, c in MOP],
            },
            "dock": {
                "type": "qrevo_s_dock", "can_empty": True, "can_wash": True, "can_dry": True,
                "drying": False, "clean_water": "okay", "dirty_water": "okay", "dust_bag": "okay",
            },
        }

    async def map(self, since: str | None = None) -> dict[str, Any]:
        self._tick()
        m = self._rendered()
        names = {**self.names, **self.nicknames.get(self.duid)}
        version = m.payload_version(names)
        if since and since == version:
            return {"available": True, "version": version, "unchanged": True}
        payload = m.as_payload(names, self.names)
        payload.update(available=True, maps=[{"flag": 0, "name": "Home"}], current_map=0)
        return payload

    async def settings(self) -> dict[str, Any]:
        await asyncio.sleep(0.25)
        limits = {
            "main_brush_work_time": ("Main brush", 1080000, "s"), "side_brush_work_time": ("Side brush", 720000, "s"),
            "filter_work_time": ("Filter", 540000, "s"), "sensor_dirty_time": ("Sensors", 108000, "s"),
            "strainer_work_times": ("Dock strainer", 150, "uses"),
            "cleaning_brush_work_times": ("Dock brush", 300, "uses"),
            "dust_collection_work_times": ("Dust bag", 90, "uses"),
        }
        cons = []
        for key, used in self.consumables.items():
            name, limit, unit = limits[key]
            left = max(0, limit - used)
            cons.append({"key": key, "name": name, "unit": unit, "used": used, "limit": limit, "left": left,
                         "percent": round(100 * left / limit)})
        return {
            **self.settings_state,
            "consumables": cons,
            "summary": {
                "total_time": 412 * 3600, "total_area": 3184.5, "count": 157, "dust_collections": 61,
                "last": {"begin": int(time.time()) - 86400, "end": int(time.time()) - 86400 + 2900,
                         "duration": 2900, "area": 61.2, "complete": True},
            },
            "routines": [{"id": 1, "name": "After dinner"}, {"id": 2, "name": "Kitchen quick mop"}],
            "network": {"ip": "192.168.1.42", "ssid": "Home", "rssi": -52},
            "device": {"duid": self.duid, "name": "Qrevo S (demo)", "model": "roborock.vacuum.a104",
                       "product": "Qrevo S", "firmware": "02.18.52", "serial": "DEMO0000000000", "local": True},
        }

    async def action(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
        self._tick()
        s = self.settings_state
        match name:
            case "start" | "resume":
                if self.state == "paused" and self._route:
                    self.state = "cleaning" if self.in_cleaning != "segment_clean_not_complete" else "segment_cleaning"
                else:
                    self._start([r for _, r in ROOMS.values()], "cleaning", "global_clean_not_complete")
            case "pause":
                if self.state not in ("charging", "charging_complete"):
                    self.state = "paused"
            case "stop":
                self._route, self.state, self.in_cleaning = [], "idle", "complete"
            case "dock":
                self._go_dock()
            case "clean_rooms":
                ids = [int(r) for r in params.get("rooms", [])]
                if not ids:
                    raise ValueError("Pick at least one room")
                self._start([self._room_rect(i) for i in ids], "segment_cleaning", "segment_clean_not_complete")
            case "clean_zone":
                x0, y0, x1, y1 = (float(v) / 4 for v in params["rect"])
                # base px -> blocks (image rows are flipped)
                rect = (min(x0, x1), H - 1 - max(y0, y1), max(x0, x1), H - 1 - min(y0, y1))
                self._start([rect], "zoned_cleaning", "zone_clean_not_complete")
            case "goto":
                target = (float(params["x"]) / 4, H - 1 - float(params["y"]) / 4)
                self._route, self._route_kind = _route(self.pos, target) + [target], "goto"
                self.path = [self.pos]
                self.state = "going_to_target"
            case "set_cleaning_mode":
                self.fan, self.water, self.mop = PRESETS[params["mode"]]
            case "set_fan":
                self.fan = int(params["code"])
            case "set_water":
                self.water = int(params["code"])
            case "set_mop":
                self.mop = int(params["code"])
            case "empty_bin":
                self.state, self._busy_until = "emptying_the_bin", time.monotonic() + 6
            case "wash_mop":
                self.state, self._busy_until = "washing_the_mop", time.monotonic() + 8
            case "set_volume":
                s["volume"] = int(params["value"])
            case "set_dnd":
                s["dnd"] = {"enabled": bool(params.get("enabled")), "start": params.get("start", "22:00"),
                            "end": params.get("end", "08:00")}
            case "set_child_lock" | "set_led" | "set_carpet_boost":
                s[name.removeprefix("set_")] = bool(params["on"])
            case "set_mop_dryer":
                s["mop_dryer"]["enabled"] = bool(params["on"])
            case "set_dust_mode":
                s["dust_mode"]["value"] = params["value"]
            case "set_wash_mode":
                s["wash_mode"]["value"] = params["value"]
            case "set_smart_wash":
                s["smart_wash"]["enabled"] = bool(params["enabled"])
            case "save_restrictions":
                self._require_editable()
                payload = build_restriction_payload(params.get("items", []))
                self.walls = [tuple(p[1:]) for p in payload if p[0] == 1]
                self.no_go = [tuple(p[1:]) for p in payload if p[0] == 0]
                self.no_mop = [tuple(p[1:]) for p in payload if p[0] == 2]
                self._edit_rev += 1
            case "merge_rooms":
                self._require_editable()
                a, b = (int(r) for r in params["rooms"])
                self._merge(a, b)
                self._edit_rev += 1
            case "split_room":
                self._require_editable()
                self._split(int(params["room"]), [float(v) for v in params["line"]])
                self._edit_rev += 1
            case "rename_room":
                name = " ".join(str(params.get("name", "")).split())[:30]
                self.nicknames.set(self.duid, int(params["room"]), name or None)
            case "reset_consumable":
                self.consumables[params["key"]] = 0
            case "locate" | "test_volume" | "run_routine" | "resolve_error" | "dry_start" | "dry_stop" | "spot" \
                    | "stop_wash" | "select_map":
                pass
            case _:
                raise ValueError(f"Unknown action: {name}")
        return await self.status(force=True)


class DemoService:
    demo = True

    def __init__(self) -> None:
        self._ctrl = DemoController()

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    def auth_state(self) -> dict[str, Any]:
        return {"demo": True, "logged_in": True, "email": "demo@example.com", "code_sent": False,
                "connecting": False, "error": None}

    async def request_code(self, email: str) -> None:
        pass

    async def login(self, code: str) -> None:
        pass

    async def logout(self) -> None:
        pass

    async def devices(self) -> list[dict[str, Any]]:
        return [{"duid": self._ctrl.duid, "name": "Qrevo S (demo)", "model": "roborock.vacuum.a104",
                 "supported": True, "connected": True}]

    async def controller(self, duid: str) -> DemoController:
        if duid != self._ctrl.duid:
            raise KeyError(duid)
        return self._ctrl
