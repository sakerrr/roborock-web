"""Small local web app for controlling a Roborock vacuum.

    python server.py            # real robot (sign in from the browser)
    python server.py --demo     # simulated Qrevo S, no account needed
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from roborock.exceptions import RoborockException

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
BUNDLE = STATIC / "dist" / "main.js"  # built from web/*.ts by `npm run build`


def code_fingerprint() -> str:
    """Hash of the app's Python files, to notice updates made after the server started."""
    h = hashlib.sha1()
    for f in sorted(ROOT.glob("*.py")):
        h.update(f.read_bytes())
    return h.hexdigest()


def ui_outdated() -> bool:
    """True when the TypeScript sources changed after the last build."""
    if not BUNDLE.exists():
        return True
    newest = max((f.stat().st_mtime for f in (ROOT / "web").rglob("*.ts")), default=0.0)
    return newest > BUNDLE.stat().st_mtime


def create_app(demo: bool) -> FastAPI:
    started_with = code_fingerprint()
    if demo:
        from demo import DemoService

        service: Any = DemoService()
    else:
        from robot import RoborockService

        service = RoborockService(ROOT / "data")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await service.start()
        yield
        await service.stop()

    app = FastAPI(title="Roborock", lifespan=lifespan, docs_url=None, redoc_url=None)
    # Mostly for opening it from another device: the script and map data shrink to about a third.
    app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=5)

    @app.middleware("http")
    async def revalidate_static(request: Request, call_next):
        # Always re-check UI files so a normal reload picks up changes.
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(RoborockException)
    async def roborock_error(_req: Request, exc: RoborockException):
        return JSONResponse({"detail": str(exc) or type(exc).__name__}, status_code=502)

    @app.exception_handler(ValueError)
    async def value_error(_req: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    async def ctrl(duid: str):
        try:
            return await service.controller(duid)
        except KeyError:
            raise HTTPException(404, "Robot not found") from None

    @app.get("/api/auth")
    async def auth():
        # The UI files are always served fresh, but Python changes need a restart
        # and TypeScript changes need a rebuild (start.command does both).
        outdated = code_fingerprint() != started_with or ui_outdated()
        return {**service.auth_state(), "restart_needed": outdated}

    @app.post("/api/auth/code")
    async def request_code(email: str = Body(..., embed=True), send: bool = Body(True, embed=True)):
        await service.request_code(email, send)
        return service.auth_state()

    @app.post("/api/auth/login")
    async def login(code: str = Body(..., embed=True)):
        await service.login(code)
        return service.auth_state()

    @app.post("/api/reconnect")
    async def reconnect():
        await service.reconnect()
        return service.auth_state()

    @app.post("/api/auth/logout")
    async def logout():
        await service.logout()
        return service.auth_state()

    @app.get("/api/devices")
    async def devices():
        return await service.devices()

    @app.get("/api/devices/{duid}/status")
    async def status(duid: str):
        return await (await ctrl(duid)).status()

    @app.get("/api/devices/{duid}/map")
    async def map_(duid: str, since: str | None = None, img: str | None = None):
        return await (await ctrl(duid)).map(since, img)

    @app.get("/api/devices/{duid}/settings")
    async def settings(duid: str):
        return await (await ctrl(duid)).settings()

    @app.get("/api/devices/{duid}/estimates")
    async def estimates(duid: str):
        return await (await ctrl(duid)).estimates()

    @app.get("/api/devices/{duid}/freshness")
    async def freshness(duid: str):
        return await (await ctrl(duid)).freshness()

    @app.post("/api/devices/{duid}/action")
    async def action(duid: str, body: dict[str, Any] = Body(...)):
        name = body.pop("action", None)
        if not name:
            raise HTTPException(400, "Missing action")
        return await (await ctrl(duid)).action(name, body)

    @app.get("/")
    async def index():
        if not BUNDLE.exists():
            return HTMLResponse(
                "<p style='font:16px system-ui;margin:40px'>The interface isn't built yet. Start the app with "
                "<code>start.command</code>, or run <code>npm install</code> and <code>npm run build</code>.</p>",
                status_code=503,
            )
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--demo", action="store_true", help="run with a simulated robot")
    parser.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to open it from your phone on the LAN")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser on start")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    url = f"http://localhost:{args.port}"
    print(f"\n  Roborock is running at {url}" + ("  (demo mode)" if args.demo else "") + "\n  Press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(1.2, webbrowser.open, [url]).start()
    uvicorn.run(create_app(args.demo), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
