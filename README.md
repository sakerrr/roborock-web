# Roborock web

A calm, local web app for controlling a Roborock vacuum (built for the **Qrevo S**; it should also work with other V1-protocol models such as the S7/S8/Q-series). It's designed for desktop and works on a phone too.

- **Live map** with room names, the robot and the dock. It updates every few seconds while the robot cleans.
- **Click rooms** to clean just those, **drag a zone**, or **click a spot** to send the robot there. You can choose 1–3 passes.
- **Move and zoom** the map like Google Maps: two-finger swipe, pinch, drag.
- **Three views**: the colour map, a **3D view** you can turn around, and a **floor plan** with room sizes.
- **What the robot saw**: carpets, obstacles it spotted (cables, shoes, pet mess…), where it mopped, and its route, on every view.
- **Edit the map**: invisible walls, no-go and no-mop zones, and merging, splitting or renaming rooms.
- **Start / pause / resume / stop / dock / locate**.
- **Cleaning mode**: Vacuum, Vac & Mop, Mop, Custom or SmartPlan. You can also set suction, water flow and mop route.
- **Dock**: empty the bin, wash the mop, dry the mop, and see tank and dust bag warnings.
- **Settings**: volume, do not disturb, child lock, status light, carpet boost, auto-empty mode, mop wash mode, smart mop washing, auto drying.
- **Maintenance** (brush, filter and sensor life, with reset), **routines**, **cleaning history**, and device info.

It talks to the robot through [python-roborock](https://github.com/python-roborock/python-roborock), the same library Home Assistant uses. It goes over your local network when it can and through the Roborock cloud otherwise.

## Start

macOS: double-click **`start.command`**. Or, from a terminal:

```bash
./start.command            # your robot
./start.command --demo     # a simulated Qrevo S, no account needed
```

The first run sets up a Python environment (Python 3.11+ or [uv](https://docs.astral.sh/uv/)) and builds the interface (Node.js 18+). After that, the app opens at http://localhost:8765.

Sign in with the email you use in the **Roborock app**. You'll get a one-time code by email, just like the app sends. Mi Home / Xiaomi Home accounts are not supported.

### Options

| flag | |
|---|---|
| `--demo` | Simulated robot and apartment, so you can try everything safely |
| `--port 8765` | Change the port |
| `--host 0.0.0.0` | Open it from other devices on your Wi‑Fi (see the note below) |
| `--no-browser` | Don't open a browser window on start |
| `--debug` | Verbose logs |

## Moving around the map

| | Trackpad | Mouse | Touch screen |
|---|---|---|---|
| Move | Two-finger swipe, or click and drag | Drag | One finger, once zoomed in |
| Zoom | Pinch | Scroll wheel | Pinch |

Zoom always heads toward your cursor or fingers, and a quick drag glides a little when you let go. The buttons in the corner zoom, **center on the robot** (or press **R**) and **fit the whole map** (or press **0**). The arrow keys and **+ / −** work too.

While you're drawing a cleaning zone or editing walls, dragging draws instead of moving the map. A two-finger swipe still moves it, or hold **Space** and drag.

## Map views

Switch views with **2D / 3D / Plan / Freshness** above the map. The app remembers your choice.

- **2D**: the colour map, with the robot's path.
- **3D**: your home with raised walls and furniture, the robot and dock as little models, and invisible walls and zones as tinted glass. **Drag to turn** it, swipe with two fingers to move, pinch to zoom, and click rooms to pick them. Zones, go-to and editing switch back to 2D. The 3D library ([three.js](https://threejs.org), MIT) is bundled into a separate file that only loads the first time you open 3D.
- **Plan**: an architect-style drawing with walls, carpets and a 1 m grid. Each room shows its floor area, and the footer adds up the area of the whole home or of the rooms you picked.
- **Freshness**: the floor coloured by how long ago each spot was cleaned. See below.

### What's on the map

Every view shows what the robot reports with its map. Use the **Layers** button (above the zoom buttons) to switch things on or off:

- **Cleaning path**: where it drove, with the stretches it mopped tinted blue.
- **Carpets**: hatched on the flat maps, slightly raised rugs in 3D.
- **Obstacles it spotted**: cables, shoes, clothes, pet waste, pets and more. Hover for what it was; if the robot took a photo, it's in the Roborock app.
- **Walls & zones**: invisible walls, no-go, no-mop and no-carpet zones.

While it cleans a zone, the zone is outlined. When you send it to a spot, its target and planned route show up too.

## Room freshness

The phone app tells you what the robot is doing now. Freshness tells you what it's been doing: when each room, and each spot, was last cleaned.

- **The map** goes from pale (cleaned in the last day) to dark (over two weeks ago). Spots it never reached, in rooms it does clean, are darkest. That's usually under the bed, the sofa or a desk, or something left on the floor. Hover anywhere for the exact age, and when it was last mopped.
- **The panel** next to the map lists every room with when it was cleaned and mopped. Set how often each room should be cleaned (every day to every two weeks). Rooms past that are marked **Due**, and **Clean due rooms** sends the robot to just those, with your current cleaning mode. Click a room to pick it for a clean.
- **Recent runs** lists the last runs with their rooms, time, area and whether it mopped.

The app records each run the robot finishes **while the app is running**, with its path. It also fills in older runs from the robot's own list of recent cleans. Those don't come with a path, so they're listed but don't colour the map. A run counts as cleaning a room once it covered half of its floor. History stays on your computer in `data/history-<robot>.json` and keeps the last 120 days.

## Editing the map

Click **Edit map** above the map. The robot needs to be docked or paused.

**Walls & zones**: pick a tool on the left and drag on the map:

- **Invisible wall**: a line the robot won't cross
- **No-go zone**: an area the robot stays out of
- **No-mop zone**: an area it vacuums but won't mop

Click a wall or zone to move it, drag its dots to resize it, or delete it (trash button or **Delete** key). **Undo** with ⌘Z. Nothing reaches the robot until you click **Save to robot**. The robot replaces all its walls and zones in one go, so the app always sends the full set. It can store 68 corner points in total (a wall uses 2, a zone 4).

**Rooms**:

- **Merge** two neighbouring rooms into one.
- **Split** a room by drawing a line across it, wall to wall.
- **Rename** a room. This only changes the name in this app (saved in `data/room_names.json`). There's no documented way to rename rooms in Roborock's cloud, so the Roborock app keeps its own names. Rename there to change a name everywhere.

Merging and splitting change the map on your robot, and the app asks before doing either. You can undo one by doing the opposite (split what you merged, merge what you split).

If a map has no-carpet zones made in the Roborock app, the editor warns you: the app can't send those back, so saving walls and zones here may remove them.

## Privacy and security

- Your Roborock session token is stored in `data/session.json` (readable only by you). **Sign out** in Settings, or delete the `data/` folder, to remove it.
- Cleaning history (for Freshness) is kept in `data/history-<robot>.json`. It never leaves your computer.
- The last map is kept in `data/map-<robot>.json`, so the app can show it straight away after a restart (and while the robot is offline).
- The app only talks to Roborock's servers and to your robot.
- By default it only listens on `localhost`. With `--host 0.0.0.0`, **anyone on your network can control the robot**. There's no password, so only do this on a network you trust.

## Good to know

- The map comes from the robot. If it says "No map yet", let it finish one full clean first.
- If the robot has several saved floors, a map picker appears next to the map tools.
- Room names come from your Roborock account. Rename rooms in the official app.
- Settings your model doesn't support are simply hidden. If the robot can't be reached, Settings says so, and its settings come back by themselves once it's online.
- Roborock limits sign-in codes (a few per minute, about 10 an hour). If it stops sending them, the app keeps the code box open, so a code you already got by email still works (or use **Already have a code?**). Otherwise wait about an hour.
- If the robot or Roborock isn't responding, use **Reconnect**. It retries with your saved sign-in. Signing out means you'll need a new code to get back in.

## Development

The backend is Python (FastAPI + python-roborock). The interface is TypeScript in `web/`, which esbuild bundles into `static/dist/`.

```bash
npm install
npm run dev        # rebuild on every change, then just reload the page
npm run typecheck  # strict type check
npm run build      # one-off build (start.command does this for you)
```

Python changes need a server restart. If the app notices code changed since it started, or the interface wasn't rebuilt, it shows a "restart to finish updating" banner.

## Files

| | |
|---|---|
| `server.py` | Web server and API |
| `robot.py` | Login session and robot control (python-roborock) |
| `maprender.py` | Turns the robot's raw map into a soft PNG, a room mask, and walls/zones for the editor |
| `history.py` | Cleaning history: each run's coverage, and room freshness worked out from it |
| `demo.py` | The simulated robot behind `--demo` |
| `web/` | The interface in TypeScript: `main.ts` (start-up), `panels.ts` (sidebar), `session.ts` (sign-in, polling), `settings.ts`, `freshness.ts`, `map/` (map, pan & zoom, editor, views, fit), `map3d.ts` (3D) |
| `static/` | `index.html`, `styles.css`, and the built bundle in `dist/` |
