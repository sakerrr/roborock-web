"""Roborock account + device logic on top of python-roborock.

`RoborockService` owns the login session and the DeviceManager.
`DeviceController` wraps one V1 vacuum (Qrevo S, S8, Q7…) and turns the
library's traits into plain JSON for the web UI.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import pickle
import time
from pathlib import Path
from typing import Any

from roborock.const import (
    CLEANING_BRUSH_REPLACE_TIME,
    DUST_COLLECTION_REPLACE_TIME,
    FILTER_REPLACE_TIME,
    MAIN_BRUSH_REPLACE_TIME,
    MOP_ROLLER_REPLACE_TIME,
    SENSOR_DIRTY_REPLACE_TIME,
    SIDE_BRUSH_REPLACE_TIME,
    STRAINER_REPLACE_TIME,
)
from roborock.data import UserData
from roborock.data.v1.v1_containers import CleanRecord, DnDTimer
from roborock.data.v1.v1_clean_modes import WashTowelModes
from roborock.data.v1.v1_code_mappings import RoborockDockDustCollectionModeCode, RoborockStateCode
from roborock.devices.device import RoborockDevice
from roborock.devices.device_manager import DeviceManager, UserParams, create_device_manager
from roborock.devices.file_cache import FileCache
from roborock.devices.traits.v1.consumeable import ConsumableAttribute
from roborock.exceptions import RoborockException, RoborockRateLimit, RoborockTooFrequentCodeRequests
from roborock.roborock_typing import RoborockCommand
from roborock.web_api import RoborockApiClient

from history import Grid, History, Run, estimate_model, freshness, grid_from_map
from maprender import MapRenderer, RenderedMap

_LOGGER = logging.getLogger(__name__)

STATUS_TTL = 2.0
MAP_TTL_ACTIVE = 3.0
MAP_TTL_IDLE = 20.0
MAP_RETRY = 30.0  # after a failed map fetch, serve the last map this long before asking again
TOO_MANY_CODES = (
    "Roborock isn't sending new codes to this account right now, because too many were asked for. "
    "It often clears within an hour, but after many tries in one day it can take until the next day, "
    "and each new try can extend it. If a code arrived by email in the last few minutes, enter it below."
)
CODES_THROTTLED = (
    "To keep Roborock from blocking your account, this app asks for only a few codes a minute and an hour. "
    "Wait a minute and try again. If a code arrived by email in the last few minutes, enter it below."
)
SETTING_TIMEOUT = 8.0

S = RoborockStateCode
CLEANING_STATES = {
    S.starting, S.cleaning, S.spot_cleaning, S.zoned_cleaning, S.segment_cleaning, S.mapping,
    S.going_to_target, S.patrol, S.remote_control_active, S.manual_mode, S.robot_status_mopping,
    S.clean_mop_cleaning, S.clean_mop_mopping, S.segment_mopping, S.segment_clean_mop_cleaning,
    S.segment_clean_mop_mopping, S.zoned_mopping, S.zoned_clean_mop_cleaning, S.zoned_clean_mop_mopping,
}
RETURNING_STATES = {S.returning_home, S.docking, S.going_to_wash_the_mop, S.back_to_dock_washing_duster}
DOCK_BUSY_STATES = {
    S.emptying_the_bin, S.washing_the_mop, S.washing_the_mop_2, S.attaching_the_mop,
    S.detaching_the_mop, S.air_drying_stopping,
}
DOCKED_STATES = {S.charging, S.charging_complete}
ERROR_STATES = {S.error, S.charging_problem, S.locked}

# (field on Consumable, label, limit, unit, reset key)
CONSUMABLES = [
    ("main_brush_work_time", "Main brush", MAIN_BRUSH_REPLACE_TIME, "s", ConsumableAttribute.MAIN_BRUSH_WORK_TIME.value),
    ("side_brush_work_time", "Side brush", SIDE_BRUSH_REPLACE_TIME, "s", ConsumableAttribute.SIDE_BRUSH_WORK_TIME.value),
    ("filter_work_time", "Filter", FILTER_REPLACE_TIME, "s", ConsumableAttribute.FILTER_WORK_TIME.value),
    ("sensor_dirty_time", "Sensors", SENSOR_DIRTY_REPLACE_TIME, "s", ConsumableAttribute.SENSOR_DIRTY_TIME.value),
    ("moproller_work_time", "Mop", MOP_ROLLER_REPLACE_TIME, "s", "moproller_work_time"),
    ("strainer_work_times", "Dock strainer", STRAINER_REPLACE_TIME, "uses", ConsumableAttribute.STRAINER_WORK_TIME.value),
    ("cleaning_brush_work_times", "Dock brush", CLEANING_BRUSH_REPLACE_TIME, "uses", ConsumableAttribute.CLEANING_BRUSH_WORK_TIME.value),
    ("dust_collection_work_times", "Dust bag", DUST_COLLECTION_REPLACE_TIME, "uses", "dust_collection_work_times"),
]


# save_map payload types (same codes the Roborock app and Valetudo use).
RESTRICTION_TYPES = {"no_go": 0, "wall": 1, "no_mop": 2}
MAX_RESTRICTION_POINTS = 68  # the robot stores at most 68 corner points in total


def build_restriction_payload(items: list[dict[str, Any]]) -> list[list[int]]:
    """Turn [{type, mm}] into the save_map payload.

    save_map replaces every wall and zone on the current map, so `items` must be
    the complete list, not just what changed.
    """
    payload: list[list[int]] = []
    points = 0
    for item in items:
        kind = RESTRICTION_TYPES.get(item.get("type"))
        if kind is None:
            raise ValueError(f"Unknown wall or zone type: {item.get('type')!r}")
        coords = [int(round(float(v))) for v in item.get("mm") or []]
        size = 2 if kind == RESTRICTION_TYPES["wall"] else 4
        if len(coords) != size * 2:
            raise ValueError("A wall or zone has the wrong number of points")
        points += size
        payload.append([kind, *coords])
    if points > MAX_RESTRICTION_POINTS:
        raise ValueError("Too many walls and zones: the robot can store 17 zones or 34 walls in total")
    return payload


class RoomNames:
    """Room nicknames that only exist in this app (data/room_names.json).

    Real room names live in the Roborock cloud and there's no documented way to
    change them, so renaming here never touches the robot or the Roborock app.
    """

    def __init__(self, path: Path | None) -> None:
        self._path = path
        self._data: dict[str, dict[str, str]] = {}
        if path is not None and path.exists():
            try:
                self._data = json.loads(path.read_text())
            except (OSError, ValueError) as err:
                _LOGGER.warning("Ignoring unreadable %s: %s", path, err)

    def get(self, duid: str) -> dict[int, str]:
        return {int(k): v for k, v in self._data.get(duid, {}).items()}

    def set(self, duid: str, room: int, name: str | None) -> None:
        names = self._data.setdefault(duid, {})
        if name:
            names[str(room)] = name
        else:
            names.pop(str(room), None)
        if self._path is not None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, indent=2, ensure_ascii=False))
            tmp.replace(self._path)


def _name(enum_value: Any) -> str | None:
    if enum_value is None:
        return None
    return getattr(enum_value, "name", str(enum_value))


def _nonzero_name(enum_value: Any) -> str | None:
    if enum_value is None or getattr(enum_value, "value", 0) in (0, None):
        return None
    return _name(enum_value)


def _flag(obj: Any, attr: str) -> bool:
    value = getattr(obj, attr, False)
    if callable(value):
        value = value()
    return bool(value)


def _hhmm(h: int | None, m: int | None) -> str | None:
    if h is None or m is None:
        return None
    return f"{h:02d}:{m:02d}"


class DeviceController:
    """Everything the UI can do with one V1 vacuum."""

    def __init__(
        self, device: RoborockDevice, nicknames: RoomNames | None = None, history: History | None = None,
        data_dir: Path | None = None,
    ) -> None:
        self.device = device
        # The last map is kept on disk so a restart shows it straight away.
        self._map_file = data_dir / f"map-{device.duid}.json" if data_dir else None
        self._map_saved_at = 0.0
        self._map_saved_image = ""
        self._map_from_disk = False
        self._map_failed_at = 0.0
        self._map_task: asyncio.Task | None = None
        self._nicknames = nicknames or RoomNames(None)
        self.history = history or History(None)
        self._fresh: tuple[tuple, dict[str, Any]] | None = None
        self._run_seen = False  # a run was going on at the last history check
        self._history_at = 0.0
        self._to_backfill: list[int] = []  # older runs from the robot's list, still to fetch
        self._record_maps: bool | None = None  # whether the robot hands out maps of past runs
        self._p = device.v1_properties
        self._renderer = MapRenderer()
        self._status_at = 0.0
        self._status_lock = asyncio.Lock()
        self._map: RenderedMap | None = None
        self._map_at = 0.0
        self._map_lock = asyncio.Lock()
        self._room_names: dict[int, str] = {}
        self._room_names_flag: int | None = -1
        self._maps: list[dict[str, Any]] | None = None
        self._unsupported: dict[str, float] = {}  # setting -> when to ask the robot again
        self._status_error: str | None = None

    # ---------- status ----------

    async def status(self, force: bool = False) -> dict[str, Any]:
        p = self._p
        if force or time.monotonic() - self._status_at > STATUS_TTL:
            async with self._status_lock:
                if force or time.monotonic() - self._status_at > STATUS_TTL:
                    try:
                        await p.status.refresh()
                        self._status_at = time.monotonic()
                        self._status_error = None
                    except Exception as err:  # noqa: BLE001 - any failure here means "can't reach it right now"
                        if repr(err) != self._status_error:  # once, not on every poll
                            self._status_error = repr(err)
                            unexpected = not isinstance(err, (RoborockException, TimeoutError))
                            _LOGGER.warning("Can't get the robot's status: %s", err or type(err).__name__, exc_info=unexpected)
                        if p.status.state is None:
                            return {"connected": False, "message": str(err) or "The robot didn't answer.", **self._identity()}
                        _LOGGER.debug("Status refresh failed, serving last known: %s", err)
        return self._status_payload()

    def _identity(self) -> dict[str, Any]:
        d = self.device
        return {
            "duid": d.duid,
            "name": d.name,
            "model": d.product.model,
            "product": getattr(d.product, "name", None),
        }

    def _status_payload(self) -> dict[str, Any]:
        s = self._p.status
        state = s.state
        if state in ERROR_STATES or _nonzero_name(s.error_code):
            phase = "error"
        elif state in CLEANING_STATES:
            phase = "cleaning"
        elif state == S.paused:
            phase = "paused"
        elif state in RETURNING_STATES:
            phase = "returning"
        elif state in DOCK_BUSY_STATES:
            phase = "dock"
        elif state in DOCKED_STATES:
            phase = "docked"
        else:
            phase = "idle"

        features = self._p.device_features
        dock = features.dock_features
        try:
            cleaning_options = [m.value for m in s.cleaning_mode_options]
            cleaning_mode = s.current_cleaning_mode_name
        except RoborockException:
            cleaning_options, cleaning_mode = [], None

        return {
            **self._identity(),
            "connected": self.device.is_connected,
            "local": self.device.is_local_connected,
            "state": _name(state),
            "phase": phase,
            "job": _name(s.in_cleaning) not in (None, "complete"),
            "job_type": _name(s.in_cleaning),
            "battery": s.battery,
            "clean_time": s.clean_time,
            "clean_area": s.square_meter_clean_area,
            "clean_percent": s.clean_percent,
            "error": _nonzero_name(s.error_code),
            "dock_error": _nonzero_name(s.dock_error_status),
            "map_flag": s.current_map,
            "mode": {
                "cleaning": cleaning_mode,
                "cleaning_options": cleaning_options,
                "fan": s.fan_power,
                "fan_options": [{"code": c, "name": n} for c, n in s.fan_speed_mapping.items()],
                "water": s.water_box_mode,
                "water_options": [{"code": c, "name": n} for c, n in s.water_mode_mapping.items()],
                "mop": s.mop_mode,
                "mop_options": [{"code": c, "name": n} for c, n in s.mop_route_mapping.items()],
            },
            "dock": {
                "type": _name(s.dock_type),
                "can_empty": _flag(dock, "is_collectable"),
                "can_wash": _flag(dock, "is_washable"),
                "can_dry": _flag(dock, "is_dryable"),
                "drying": bool(s.dry_status),
                "clean_water": _name(s.clear_water_box_status),
                "dirty_water": _name(s.dirty_water_box_status),
                "dust_bag": _name(s.dust_bag_status),
            },
        }

    # ---------- map ----------

    async def map(self, since: str | None = None, img: str | None = None) -> dict[str, Any]:
        """The map. `img` is the image version the browser has; the images are left out if it matches."""
        active = self._p.status.state in CLEANING_STATES | RETURNING_STATES
        ttl = MAP_TTL_ACTIVE if active else MAP_TTL_IDLE
        now = time.monotonic()
        if self._map is not None and self._map_from_disk:
            self._refresh_soon()  # just started: show the saved map while a fresh one comes in
        elif self._map is None or (now - self._map_at > ttl and now - self._map_failed_at > MAP_RETRY):
            try:
                async with self._map_lock:
                    if self._map is None or time.monotonic() - self._map_at > ttl:
                        await self._refresh_map()
            except Exception as err:  # noqa: BLE001 - offline or slow: show the last map there is
                self._map_failed_at = time.monotonic()
                if self._map is None:
                    raise RoborockException(f"Couldn't get the map: {err or type(err).__name__}") from err
                _LOGGER.info("Map refresh failed, showing the last one: %s", err or type(err).__name__)
        if self._map is None:
            return {"available": False}
        names = {**self._room_names, **self._nicknames.get(self.device.duid)}
        version = self._map.payload_version(names)
        if since and since == version:
            return {"available": True, "version": version, "unchanged": True}
        payload = self._map.as_payload(names, self._room_names, images=img != self._map.image_version)
        payload["available"] = True
        payload["maps"] = self._maps or []
        payload["current_map"] = self._p.status.current_map
        payload["stale"] = self._map_from_disk  # the browser asks again soon for the fresh one
        return payload

    def _refresh_soon(self) -> None:
        """Fetch a fresh map in the background; the caller serves the one it has."""
        if self._map_task is None or self._map_task.done():
            self._map_task = asyncio.create_task(self._refresh_quietly())

    async def _refresh_quietly(self) -> None:
        try:
            async with self._map_lock:
                await self._refresh_map()
        except Exception as err:  # noqa: BLE001
            self._map_failed_at = time.monotonic()
            self._map_from_disk = False  # stop retrying on every request; the normal pace takes over
            _LOGGER.info("Couldn't refresh the map: %s", err or type(err).__name__)

    async def _load_saved_map(self) -> None:
        if self._map is not None or not self._map_file or not self._map_file.exists():
            return
        try:
            saved = json.loads(self._map_file.read_text())
            rendered = await asyncio.to_thread(self._renderer.render, base64.b64decode(saved["raw"]))
        except Exception as err:  # noqa: BLE001 - it's only a head start
            _LOGGER.info("Ignoring the saved map: %s", err)
            return
        if rendered is not None and self._map is None:
            self._map, self._map_from_disk = rendered, True
            self._room_names = {int(k): v for k, v in (saved.get("names") or {}).items()}
            self._maps = saved.get("maps")

    def _save_map(self, raw: bytes) -> None:
        # Often enough to be useful after a restart, not on every move while it cleans.
        assert self._map is not None
        if not self._map_file or (
            self._map.image_version == self._map_saved_image and time.monotonic() - self._map_saved_at < 300
        ):
            return
        self._map_saved_at = time.monotonic()
        self._map_saved_image = self._map.image_version
        try:
            data = {"raw": base64.b64encode(raw).decode(), "names": self._room_names, "maps": self._maps}
            tmp = self._map_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data))
            os.replace(tmp, self._map_file)
        except OSError as err:
            _LOGGER.info("Couldn't save the map: %s", err)

    # ---------- history & freshness ----------

    async def watch(self) -> None:
        """Keep the cleaning history up to date for as long as the app runs."""
        # Get a head start for the first page load: the saved map now, a fresh one soon.
        await self._load_saved_map()
        self._refresh_soon()
        while True:
            delay = 300.0
            try:
                delay = await self._history_tick()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - try again later
                _LOGGER.info("Couldn't update the cleaning history: %s", err)
            await asyncio.sleep(delay)

    async def _history_tick(self) -> float:
        """One look at the robot. Returns how long to wait before the next."""
        st = await self.status()
        if st.get("state") is None:
            return 120  # can't reach it
        if st.get("job") or st.get("phase") in ("cleaning", "returning", "paused"):
            self._run_seen = True
            return 30
        if self._run_seen or time.monotonic() - self._history_at >= 900:
            self._run_seen = False
            self._history_at = time.monotonic()
            summary = self._p.clean_summary
            await summary.refresh()
            ids = sorted({int(i) for i in summary.records or []}, reverse=True)
            if ids and not self.history.has(str(ids[0])) and summary.last_clean_record:
                # The map keeps showing the last run's path until the next one starts.
                async with self._map_lock:
                    await self._refresh_map()
                grid = grid_from_map(self._map) if self._map else None
                self.history.add(_run(ids[0], summary.last_clean_record, grid, "live", self._p.status.current_map, self._mode()))
            self._to_backfill = [rid for rid in ids[1:] if not self.history.has(str(rid))]
        # Fill in older runs from the robot's own list, one per look.
        if self._to_backfill:
            await self._backfill(self._to_backfill.pop(0))
            return 15
        return 120

    async def _backfill(self, rid: int) -> None:
        record = await self._p.clean_summary.get_clean_record(rid)
        grid = None
        if self._record_maps is not False:
            # Not every robot hands out maps of past runs; ask once and remember.
            try:
                raw = await asyncio.wait_for(
                    self._p.map_content.rpc_channel.send_command(RoborockCommand.GET_CLEAN_RECORD_MAP, params=[rid]), 20
                )
                rendered = await asyncio.to_thread(self._renderer.render, raw) if isinstance(raw, bytes) else None
                grid = grid_from_map(rendered) if rendered else None
            except Exception as err:  # noqa: BLE001
                _LOGGER.info("No map for past runs from this robot: %s", err or type(err).__name__)
            self._record_maps = grid is not None
        self.history.add(_run(rid, record, grid, "robot", None))

    def _mode(self) -> str | None:
        try:
            return self._p.status.current_cleaning_mode_name
        except Exception:  # noqa: BLE001 - not every model reports one
            return None

    async def estimates(self) -> dict[str, Any]:
        return estimate_model(self.history)

    async def freshness(self) -> dict[str, Any]:
        if self._map is None:
            async with self._map_lock:
                if self._map is None:
                    await self._refresh_map()
        if self._map is None:
            return {"available": False}
        flag = self._p.status.current_map
        key = (self.history.rev, self._map.version, flag, int(time.time() // 60))
        if self._fresh is None or self._fresh[0] != key:
            self._fresh = (key, await asyncio.to_thread(freshness, self.history, self._map, flag))
        return self._fresh[1]

    async def _refresh_map(self) -> None:
        p = self._p
        raw = await p.map_content.rpc_channel.send_command(RoborockCommand.GET_MAP_V1)
        self._map_at = time.monotonic()
        if not isinstance(raw, bytes):
            raise RoborockException("Robot returned no map data")
        if self._map is None or self._map_from_disk or self._map.version != _version(raw):
            rendered = await asyncio.to_thread(self._renderer.render, raw)
            if rendered is not None:
                self._map = rendered
        self._map_from_disk = False
        flag = p.status.current_map
        if flag != self._room_names_flag or not self._room_names:
            try:
                await p.rooms.refresh()
                self._room_names = {r.segment_id: r.name for r in p.rooms.rooms or []}
                self._room_names_flag = flag
            except RoborockException as err:
                _LOGGER.info("Could not load room names: %s", err)
        if self._maps is None:
            try:
                await p.maps.refresh()
                self._maps = [
                    {"flag": m.map_flag, "name": m.name or f"Map {i + 1}"} for i, m in enumerate(p.maps.map_info or [])
                ]
            except RoborockException as err:
                _LOGGER.info("Could not load map list: %s", err)
        if self._map is not None:
            self._save_map(raw)

    # ---------- settings ----------

    async def _try(self, key: str, fn) -> Any:
        if time.monotonic() < self._unsupported.get(key, 0):
            return None
        try:
            return await asyncio.wait_for(fn(), SETTING_TIMEOUT)
        except Exception as err:  # noqa: BLE001 - one setting failing shouldn't hide the others
            # Remember settings this robot doesn't have, so the page doesn't wait on them each
            # time. Only when it's online, though: offline, everything fails for a while.
            msg = str(err).lower()
            if self.device.is_connected:
                if any(s in msg for s in ("-10000", "unknown_method", "unknown method", "not support", "unsupported")):
                    self._unsupported[key] = float("inf")
                elif any(s in msg for s in ("unknown", "invalid")):
                    self._unsupported[key] = time.monotonic() + 600  # probably missing; check again later
            _LOGGER.info("Setting %s unavailable: %s", key, err)
            return None

    async def settings(self) -> dict[str, Any]:
        p = self._p

        async def volume():
            await p.sound_volume.refresh()
            return p.sound_volume.volume

        async def dnd():
            await p.dnd.refresh()
            return {
                "enabled": p.dnd.is_on,
                "start": _hhmm(p.dnd.start_hour, p.dnd.start_minute) or "22:00",
                "end": _hhmm(p.dnd.end_hour, p.dnd.end_minute) or "08:00",
            }

        def switch(trait):
            async def run():
                if trait is None:
                    return None
                await trait.refresh()
                return trait.is_on
            return run

        async def carpet_boost():
            res = await p.command.send(RoborockCommand.GET_CARPET_MODE)
            item = res[0] if isinstance(res, list) else res
            return bool(item["enable"])

        async def dust_mode():
            t = p.dust_collection_mode
            if t is None:
                return None
            await t.refresh()
            options = [m for m in RoborockDockDustCollectionModeCode if m.value >= 0]
            return {"value": _name(t.mode), "options": [m.name for m in options]}

        async def wash_mode():
            t = p.wash_towel_mode
            if t is None:
                return None
            await t.refresh()
            return {"value": t.wash_mode.value if t.wash_mode else None, "options": [m.value for m in t.wash_towel_mode_options]}

        async def smart_wash():
            t = p.smart_wash_params
            if t is None:
                return None
            await t.refresh()
            return {"enabled": bool(t.smart_wash)}

        async def mop_dryer():
            t = p.mop_dryer
            if t is None:
                return None
            await t.refresh()
            dry_time = t.on.dry_time if t.on else None
            return {"enabled": t.is_on, "dry_time": dry_time}

        async def consumables():
            await p.consumables.refresh()
            out = []
            c = p.consumables
            for attr, label, limit, unit, reset_key in CONSUMABLES:
                used = getattr(c, attr, None)
                if used is None:
                    continue
                left = max(0, limit - used)
                out.append({
                    "key": reset_key, "name": label, "unit": unit,
                    "used": used, "limit": limit, "left": left,
                    "percent": round(100 * left / limit) if limit else None,
                })
            return out

        async def summary():
            await p.clean_summary.refresh()
            cs = p.clean_summary
            last = cs.last_clean_record
            return {
                "total_time": cs.clean_time,
                "total_area": cs.square_meter_clean_area,
                "count": cs.clean_count,
                "dust_collections": cs.dust_collection_count,
                "last": last and {
                    "begin": last.begin, "end": last.end, "duration": last.duration,
                    "area": last.square_meter_area, "complete": bool(last.complete),
                },
            }

        async def routines():
            items = await p.routines.get_routines()
            return [{"id": r.id, "name": r.name} for r in items]

        async def network():
            await p.network_info.refresh()
            n = p.network_info
            return {"ip": n.ip or None, "ssid": n.ssid, "rssi": n.rssi}

        keys = {
            "volume": volume, "dnd": dnd,
            "child_lock": switch(p.child_lock), "led": switch(p.led_status),
            "flow_led": switch(p.flow_led_status), "carpet_boost": carpet_boost,
            "dust_mode": dust_mode, "wash_mode": wash_mode, "smart_wash": smart_wash,
            "mop_dryer": mop_dryer, "consumables": consumables, "summary": summary,
            "routines": routines, "network": network,
        }
        results = await asyncio.gather(*(self._try(k, fn) for k, fn in keys.items()))
        out = dict(zip(keys, results))
        info = self.device.device_info
        out["device"] = {
            **self._identity(),
            "firmware": getattr(info, "fv", None),
            "serial": getattr(info, "sn", None),
            "local": self.device.is_local_connected,
        }
        out["connected"] = self.device.is_connected
        return out

    # ---------- actions ----------

    async def action(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
        p = self._p
        send = p.command.send
        s = p.status

        match name:
            case "start":
                await send(RoborockCommand.APP_START)
            case "pause":
                await send(RoborockCommand.APP_PAUSE)
            case "resume":
                job = _name(s.in_cleaning)
                if job == "segment_clean_not_complete":
                    await send(RoborockCommand.RESUME_SEGMENT_CLEAN)
                elif job == "zone_clean_not_complete":
                    await send(RoborockCommand.RESUME_ZONED_CLEAN)
                else:
                    await send(RoborockCommand.APP_START)
            case "stop":
                await send(RoborockCommand.APP_STOP)
            case "dock":
                await send(RoborockCommand.APP_CHARGE)
            case "locate":
                await send(RoborockCommand.FIND_ME)
            case "spot":
                await send(RoborockCommand.APP_SPOT)
            case "empty_bin":
                await send(RoborockCommand.APP_START_COLLECT_DUST)
            case "wash_mop":
                await send(RoborockCommand.APP_START_WASH)
            case "stop_wash":
                await send(RoborockCommand.APP_STOP_WASH)
            case "dry_start":
                await send(RoborockCommand.APP_SET_DRYER_STATUS, {"status": 1})
            case "dry_stop":
                await send(RoborockCommand.APP_SET_DRYER_STATUS, {"status": 0})
            case "resolve_error":
                await s.resolve_error()
            case "clean_rooms":
                rooms = [int(r) for r in params.get("rooms", [])]
                if not rooms:
                    raise ValueError("Pick at least one room")
                repeat = int(params.get("repeat", 1))
                await send(RoborockCommand.APP_SEGMENT_CLEAN, [{"segments": rooms, "repeat": repeat}])
            case "clean_zone":
                m = self._require_map()
                x0, y0, x1, y1 = (float(v) for v in params["rect"])
                ax, ay = m.px_to_mm(x0, y0)
                bx, by = m.px_to_mm(x1, y1)
                repeat = int(params.get("repeat", 1))
                zone = [min(ax, bx), min(ay, by), max(ax, bx), max(ay, by), repeat]
                await send(RoborockCommand.APP_ZONED_CLEAN, [zone])
            case "goto":
                m = self._require_map()
                x, y = m.px_to_mm(float(params["x"]), float(params["y"]))
                await send(RoborockCommand.APP_GOTO_TARGET, [x, y])
            case "set_cleaning_mode":
                await s.set_cleaning_mode(params["mode"])
            case "set_fan":
                await send(RoborockCommand.SET_CUSTOM_MODE, [int(params["code"])])
            case "set_water":
                await send(RoborockCommand.SET_WATER_BOX_CUSTOM_MODE, [int(params["code"])])
            case "set_mop":
                await send(RoborockCommand.SET_MOP_MODE, [int(params["code"])])
            case "select_map":
                await p.maps.set_current_map(int(params["flag"]))
                self._map = None
                self._room_names_flag = -1
            case "set_volume":
                await p.sound_volume.set_volume(max(0, min(100, int(params["value"]))))
            case "test_volume":
                await send(RoborockCommand.TEST_SOUND_VOLUME)
            case "set_dnd":
                if params.get("enabled"):
                    sh, sm = (int(v) for v in params["start"].split(":"))
                    eh, em = (int(v) for v in params["end"].split(":"))
                    await p.dnd.set_dnd_timer(
                        DnDTimer(start_hour=sh, start_minute=sm, end_hour=eh, end_minute=em, enabled=1)
                    )
                else:
                    await p.dnd.disable()
            case "set_child_lock":
                await self._switch(p.child_lock, params["on"])
            case "set_led":
                await self._switch(p.led_status, params["on"])
            case "set_flow_led":
                await self._switch(p.flow_led_status, params["on"])
            case "set_mop_dryer":
                await self._switch(p.mop_dryer, params["on"])
            case "set_carpet_boost":
                res = await send(RoborockCommand.GET_CARPET_MODE)
                item = dict(res[0] if isinstance(res, list) else res)
                item["enable"] = 1 if params["on"] else 0
                await send(RoborockCommand.SET_CARPET_MODE, [item])
            case "set_dust_mode":
                mode = RoborockDockDustCollectionModeCode[params["value"]]
                await send(RoborockCommand.SET_DUST_COLLECTION_MODE, {"mode": mode.value})
            case "set_wash_mode":
                if p.wash_towel_mode is None:
                    raise ValueError("Mop washing is not supported by this dock")
                await p.wash_towel_mode.set_wash_towel_mode(WashTowelModes(params["value"]))
            case "set_smart_wash":
                t = p.smart_wash_params
                if t is None:
                    raise ValueError("Mop washing is not supported by this dock")
                smart = 1 if params["enabled"] else 0
                # Keep the robot's own interval; only flip the smart switch.
                await send(RoborockCommand.SET_SMART_WASH_PARAMS, {"smart_wash": smart, "wash_interval": t.wash_interval or 1200})
                t.smart_wash = smart
            case "reset_consumable":
                await send(RoborockCommand.RESET_CONSUMABLE, [params["key"]])
            case "save_restrictions":
                self._require_editable()
                await send(RoborockCommand.SAVE_MAP, build_restriction_payload(params.get("items", [])))
                self._map_at = 0.0
            case "merge_rooms":
                self._require_editable()
                a, b = (int(r) for r in params["rooms"])
                if a == b:
                    raise ValueError("Pick two different rooms")
                await send(RoborockCommand.MERGE_SEGMENT, [a, b])
                self._after_room_edit()
            case "split_room":
                self._require_editable()
                ax, ay, bx, by = (int(round(float(v))) for v in params["line"])
                await send(RoborockCommand.SPLIT_SEGMENT, [int(params["room"]), ax, ay, bx, by])
                self._after_room_edit()
            case "rename_room":
                name = " ".join(str(params.get("name", "")).split())[:30]
                self._nicknames.set(self.device.duid, int(params["room"]), name or None)
            case "run_routine":
                await p.routines.execute_routine(int(params["id"]))
            case "set_room_interval":
                self.history.set_interval(s.current_map, int(params["room"]), int(params["days"]))
            case _:
                raise ValueError(f"Unknown action: {name}")

        # Give the robot a moment so the returned status reflects the change.
        await asyncio.sleep(0.6)
        return await self.status(force=True)

    async def _switch(self, trait, on: bool) -> None:
        if trait is None:
            raise ValueError("Not supported by this robot")
        if on:
            await trait.enable()
        else:
            await trait.disable()

    def _require_editable(self) -> None:
        if self._p.status.state in CLEANING_STATES | RETURNING_STATES:
            raise ValueError("Pause or dock the robot before editing the map")

    def _after_room_edit(self) -> None:
        # The robot rebuilds its rooms; fetch the new map and room list next time.
        self._map_at = 0.0
        self._room_names_flag = -1

    def _require_map(self) -> RenderedMap:
        if self._map is None:
            raise ValueError("Map not loaded yet")
        return self._map


def _version(raw: bytes) -> str:
    return hashlib.sha1(raw).hexdigest()[:12]


def _run(rid: int, record: CleanRecord, grid: Grid | None, source: str, flag: int | None, mode: str | None = None) -> Run:
    """A history entry from one of the robot's clean records (their ids are start times)."""
    begin = int(record.begin or rid)
    return Run(
        id=str(rid),
        begin=begin,
        end=int(record.end or begin + (record.duration or 0)),
        duration=record.duration,
        area=record.square_meter_area,
        complete=None if record.complete is None else bool(record.complete),
        map_flag=record.map_flag if record.map_flag is not None else flag,
        source=source,
        mode=mode,
        grid=grid,
    )


def _unpickle(data: bytes) -> Any:
    try:
        return pickle.loads(data)
    except Exception:  # noqa: BLE001 - empty or damaged: start with a fresh cache
        _LOGGER.info("Ignoring a damaged device cache")
        return None


class SafeCache(FileCache):
    """python-roborock's device cache, but a damaged or half-written file can't stop the
    app from connecting: it's written to a temporary file first, and a bad one is ignored.
    (The library opens the file for writing before it serialises, so a failed save left it empty.)"""

    def __init__(self, path: Path) -> None:
        super().__init__(path, deserialize_fn=_unpickle)
        self._path = path

    async def flush(self) -> None:
        data = self._cache_data
        if data is None:
            return

        def write() -> None:
            blob = pickle.dumps(data)  # before touching the file
            tmp = self._path.with_suffix(".tmp")
            tmp.write_bytes(blob)
            os.replace(tmp, self._path)

        await asyncio.to_thread(write)


class RoborockService:
    """Login session + DeviceManager lifecycle."""

    demo = False

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir
        self._session_file = data_dir / "session.json"
        self._cache = SafeCache(data_dir / "cache.pkl")
        self._session: dict[str, Any] | None = None
        self._pending: tuple[str, RoborockApiClient] | None = None
        self._clients: dict[str, RoborockApiClient] = {}  # one per email: a code belongs to the client that asked for it
        self._code_note: str | None = None
        self._manager: DeviceManager | None = None
        self._controllers: dict[str, DeviceController] = {}
        self._watchers: list[asyncio.Task] = []
        self._connect_task: asyncio.Task | None = None
        self._connect_error: str | None = None
        self._nicknames = RoomNames(data_dir / "room_names.json")

    async def start(self) -> None:
        self._data_dir.mkdir(parents=True, exist_ok=True)
        if self._session_file.exists():
            try:
                self._session = json.loads(self._session_file.read_text())
            except (OSError, ValueError) as err:
                _LOGGER.warning("Ignoring unreadable session file: %s", err)
        if self._session:
            self._connect_task = asyncio.create_task(self._connect())

    async def stop(self) -> None:
        if self._connect_task:
            self._connect_task.cancel()
        await self._close_manager()

    def auth_state(self) -> dict[str, Any]:
        return {
            "demo": False,
            "logged_in": self._session is not None,
            "email": (self._session or {}).get("email") or (self._pending[0] if self._pending else None),
            "code_sent": self._pending is not None,
            "code_note": self._code_note,
            "connecting": bool(self._connect_task and not self._connect_task.done()),
            "error": self._connect_error,
        }

    async def request_code(self, email: str, send: bool = True) -> None:
        """Email a sign-in code (or, with send=False, get ready for one that already came)."""
        email = email.strip()
        if "@" not in email:
            raise ValueError("Enter the email you use in the Roborock app")
        client = self._client(email)
        self._code_note = None
        if send:
            # Either way a code sent earlier can still be good, so keep the code step open.
            try:
                await client.request_code_v4()
            except RoborockTooFrequentCodeRequests:  # Roborock refused
                self._code_note = TOO_MANY_CODES
            except RoborockRateLimit:  # python-roborock's own limit, to keep accounts from being blocked
                self._code_note = CODES_THROTTLED
        self._pending = (email, client)

    def _client(self, email: str) -> RoborockApiClient:
        client = self._clients.get(email.lower())
        if client is None:
            client = self._clients[email.lower()] = RoborockApiClient(username=email)
        return client

    async def login(self, code: str) -> None:
        if self._pending is None:
            raise ValueError("Request a code first")
        email, client = self._pending
        await self._signed_in(email, client, await client.code_login_v4(code.strip()))

    async def _signed_in(self, email: str, client: RoborockApiClient, user_data: UserData) -> None:
        self._session = {
            "email": email,
            "base_url": await client.base_url,
            "user_data": user_data.as_dict(),
        }
        self._pending = None
        self._code_note = None
        self._write_session()
        self._connect_task = asyncio.create_task(self._connect())
        await self._connect_task

    async def reconnect(self) -> None:
        """Connect again with the saved session. No new code needed."""
        if self._session is None:
            raise ValueError("Sign in first")
        if not (self._connect_task and not self._connect_task.done()):
            await self._close_manager()
            self._connect_task = asyncio.create_task(self._connect())
        await self._ready()

    async def logout(self) -> None:
        await self._close_manager()
        self._session = None
        self._pending = None
        self._code_note = None
        self._connect_error = None
        for f in (self._session_file, self._data_dir / "cache.pkl"):
            f.unlink(missing_ok=True)
        self._cache = SafeCache(self._data_dir / "cache.pkl")

    def _write_session(self) -> None:
        self._data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._session_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._session, default=vars, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(self._session_file)

    async def _connect(self) -> None:
        assert self._session is not None
        self._connect_error = None
        try:
            params = UserParams(
                username=self._session["email"],
                user_data=UserData.from_dict(self._session["user_data"]),
                base_url=self._session.get("base_url"),
            )
            self._manager = await create_device_manager(params, cache=self._cache)
            await self._flush_cache()
            for dev in await self._manager.get_devices():
                if dev.v1_properties is not None:
                    history = History(self._data_dir / f"history-{dev.duid}.json")
                    ctrl = DeviceController(dev, self._nicknames, history, self._data_dir)
                    self._controllers[dev.duid] = ctrl
                    self._watchers.append(asyncio.create_task(ctrl.watch()))
        except Exception as err:  # surfaced in the UI
            _LOGGER.exception("Failed to connect to Roborock cloud")
            self._connect_error = str(err) or type(err).__name__
            raise

    async def _flush_cache(self) -> None:
        # The cache only speeds up the next start; never let it break anything.
        try:
            await self._cache.flush()
        except Exception as err:  # noqa: BLE001
            _LOGGER.info("Could not persist device cache: %s", err)

    async def _close_manager(self) -> None:
        for task in self._watchers:
            task.cancel()
        self._watchers = []
        if self._manager:
            await self._flush_cache()
            try:
                await self._manager.close()
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Error closing manager", exc_info=True)
        self._manager = None
        self._controllers = {}

    async def _ready(self) -> None:
        if self._connect_task and not self._connect_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._connect_task), 30)
            except Exception:  # noqa: BLE001
                pass

    async def devices(self) -> list[dict[str, Any]]:
        await self._ready()
        if self._manager is None:
            return []
        out = []
        for dev in await self._manager.get_devices():
            out.append({
                "duid": dev.duid,
                "name": dev.name,
                "model": dev.product.model,
                "supported": dev.duid in self._controllers,
                "connected": dev.is_connected,
            })
        return out

    async def controller(self, duid: str) -> DeviceController:
        await self._ready()
        ctrl = self._controllers.get(duid)
        if ctrl is None:
            raise KeyError(duid)
        return ctrl
