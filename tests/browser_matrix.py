#!/usr/bin/env python3
"""Release browser matrix for the standalone Portal Workshop.

The harness launches a clean Chromium + ANGLE SwiftShader process, injects the
single-file build through CDP (so it remains offline), exercises the live editor
adapter, resize and lifecycle paths, and compares exact RGBA pixels against the
versioned scene corpus.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from typing import Any

try:
    import websocket
except ImportError as exc:  # pragma: no cover - operator guidance
    raise SystemExit("browser_matrix.py requires websocket-client (pip install websocket-client)") from exc
try:
    from PIL import Image, ImageChops
except ImportError as exc:  # pragma: no cover - operator guidance
    raise SystemExit("browser_matrix.py requires Pillow (pip install Pillow)") from exc

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_HTML = ROOT / "dist" / "Portal Workshop.html"
CORPUS_PATH = ROOT / "fixtures" / "scenes-v1.json"
ORACLE_PATH = ROOT / "fixtures" / "oracles-v1.json"
GOLDEN_DIR = ROOT / "fixtures" / "oracles"
DEFAULT_RESULTS = ROOT / "test-results" / "browser-matrix.json"
HIDE_UI_JS = r'''(()=>{
  let style=document.getElementById('portal-oracle-style');
  if(!style){style=document.createElement('style');style.id='portal-oracle-style';style.textContent='.portal-panel,.portal-hud,.portal-workshop,.portal-workshop-crosshair,.portal-release-status,.portal-release-dialog{display:none!important}';document.head.append(style)}
  return true
})()'''


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def json_get(url: str, method: str = "GET") -> Any:
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


class CDP:
    def __init__(self, ws_url: str, origin: str):
        self.ws = websocket.create_connection(ws_url, timeout=60, origin=origin, max_size=32 * 1024 * 1024)
        self.next_id = 1
        self.events: list[dict[str, Any]] = []

    def command(self, method: str, params: dict[str, Any] | None = None, timeout: float = 60) -> dict[str, Any]:
        call_id = self.next_id
        self.next_id += 1
        self.ws.settimeout(timeout)
        self.ws.send(json.dumps({"id": call_id, "method": method, "params": params or {}}, separators=(",", ":")))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = json.loads(self.ws.recv())
            if message.get("id") == call_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            self.events.append(message)
        raise TimeoutError(method)

    def evaluate(self, expression: str, *, await_promise: bool = True, timeout: float = 60) -> Any:
        result = self.command(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(json.dumps(result["exceptionDetails"], indent=2))
        obj = result.get("result", {})
        return obj.get("value", obj.get("description"))

    def wait_for(self, expression: str, timeout: float = 30) -> Any:
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                last = self.evaluate(expression, timeout=10)
                if last:
                    return last
            except Exception:
                pass
            time.sleep(0.05)
        raise TimeoutError(f"wait_for {expression!r}; last={last!r}")

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.ws.close()


class CleanChromium:
    def __init__(self, chromium: str | None, keep: bool = False):
        self.chromium = chromium or shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
        if not self.chromium:
            raise RuntimeError("Chromium/Chrome executable not found")
        self.keep = keep
        self.port = free_port()
        self.display = None
        self.xvfb: subprocess.Popen[bytes] | None = None
        self.browser: subprocess.Popen[bytes] | None = None
        self.tempdir = Path(tempfile.mkdtemp(prefix="portal-workshop-browser-"))
        self.log = self.tempdir / "chromium.log"

    def __enter__(self) -> "CleanChromium":
        env = os.environ.copy()
        display_value = env.get("DISPLAY", "")
        display_number = display_value.split(":", 1)[1].split(".", 1)[0] if display_value.startswith(":") else ""
        display_usable = bool(display_number and Path(f"/tmp/.X11-unix/X{display_number}").exists())
        if not display_usable:
            xvfb_path = shutil.which("Xvfb")
            if not xvfb_path:
                raise RuntimeError("DISPLAY is unset and Xvfb is not installed")
            for number in range(110, 200):
                if not Path(f"/tmp/.X11-unix/X{number}").exists():
                    self.display = f":{number}"
                    break
            if not self.display:
                raise RuntimeError("could not allocate Xvfb display")
            self.xvfb = subprocess.Popen(
                [xvfb_path, self.display, "-screen", "0", "1600x1000x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            env["DISPLAY"] = self.display
            time.sleep(0.35)
        profile = self.tempdir / "profile"
        command = [
            self.chromium,
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu-sandbox",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-default-apps",
            "--disable-extensions",
            "--disable-pings",
            "--disable-sync",
            "--metrics-recording-only",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-allow-origins=*",
            f"--remote-debugging-port={self.port}",
            f"--user-data-dir={profile}",
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--enable-unsafe-swiftshader",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--window-size=1440,900",
            "about:blank",
        ]
        log_handle = open(self.log, "wb")
        self.browser = subprocess.Popen(command, env=env, stdout=log_handle, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{self.port}"
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.browser.poll() is not None:
                raise RuntimeError(f"Chromium exited early; log: {self.log.read_text(errors='replace')}")
            try:
                json_get(f"{base}/json/version")
                return self
            except Exception:
                time.sleep(0.1)
        raise TimeoutError(f"Chromium debug endpoint did not start; log: {self.log.read_text(errors='replace')}")

    def new_page(self) -> tuple[CDP, dict[str, Any]]:
        base = f"http://127.0.0.1:{self.port}"
        url = f"{base}/json/new?{urllib.parse.quote('about:blank', safe=':/')}"
        try:
            target = json_get(url, "PUT")
        except Exception:
            target = json_get(url)
        return CDP(target["webSocketDebuggerUrl"], base), target

    def version(self) -> dict[str, Any]:
        return json_get(f"http://127.0.0.1:{self.port}/json/version")

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.keep:
            print(f"Keeping Chromium on port {self.port}; profile {self.tempdir}", file=sys.stderr)
            return
        if self.browser:
            self.browser.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.browser.wait(timeout=5)
            if self.browser.poll() is None:
                self.browser.kill()
        if self.xvfb:
            self.xvfb.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.xvfb.wait(timeout=3)
        shutil.rmtree(self.tempdir, ignore_errors=True)


def event_errors(events: list[dict[str, Any]]) -> tuple[list[Any], list[Any]]:
    errors, console = [], []
    for event in events:
        method, params = event.get("method"), event.get("params", {})
        if method == "Runtime.exceptionThrown":
            errors.append(params.get("exceptionDetails", params))
        elif method == "Log.entryAdded":
            entry = params.get("entry", {})
            record = {"type": entry.get("level"), "text": entry.get("text"), "url": entry.get("url"), "line": entry.get("lineNumber")}
            console.append(record)
            if entry.get("level") == "error":
                errors.append(record)
        elif method == "Runtime.consoleAPICalled":
            values = [arg.get("value", arg.get("description")) for arg in params.get("args", [])]
            record = {"type": params.get("type"), "values": values}
            console.append(record)
            if params.get("type") in {"error", "assert"}:
                text = " ".join(str(value) for value in values)
                # Three reports the intentional test loss as a warning on some builds.
                if "Context Lost" not in text and "Context Restored" not in text:
                    errors.append(record)
    return errors, console


def screenshot_rgba(cdp: CDP) -> tuple[bytes, bytes, tuple[int, int]]:
    payload = cdp.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False}, timeout=120)
    png = base64.b64decode(payload["data"])
    with Image.open(io.BytesIO(png)) as image:
        rgba_image = image.convert("RGBA")
        return png, rgba_image.tobytes(), rgba_image.size


def compare_rgba(actual_png: bytes, golden_path: Path) -> dict[str, Any]:
    with Image.open(io.BytesIO(actual_png)) as actual, Image.open(golden_path) as golden:
        actual = actual.convert("RGBA")
        golden = golden.convert("RGBA")
        if actual.size != golden.size:
            return {"sizeMatch": False, "actualSize": list(actual.size), "goldenSize": list(golden.size), "differentPixels": actual.size[0] * actual.size[1], "maxChannelDelta": 255}
        diff = ImageChops.difference(actual, golden)
        extrema = diff.getextrema()
        max_delta = max(channel[1] for channel in extrema)
        different = 0
        if max_delta:
            alpha = diff.convert("RGBA")
            different = sum(1 for pixel in alpha.getdata() if pixel != (0, 0, 0, 0))
        return {"sizeMatch": True, "actualSize": list(actual.size), "goldenSize": list(golden.size), "differentPixels": different, "maxChannelDelta": max_delta}


def set_viewport(cdp: CDP, width: int, height: int) -> None:
    cdp.command("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False})
    cdp.evaluate("window.dispatchEvent(new Event('resize')); true")
    time.sleep(0.08)


def load_scene(cdp: CDP, scene: dict[str, Any]) -> dict[str, Any]:
    scene_json = json.dumps(scene, separators=(",", ":"), allow_nan=False)
    result = cdp.evaluate(f"(()=>{{const r=PortalWorkshopEngine.runtime();if(!r)throw new Error('runtime unavailable');r.loadScene({scene_json});return window.__portalDebug.forceRender()}})()", timeout=180)
    if not isinstance(result, dict):
        raise AssertionError(f"forceRender did not return state: {result!r}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--update-goldens", action="store_true")
    mode.add_argument("--verify-goldens", action="store_true")
    parser.add_argument("--html", type=Path, default=DEFAULT_HTML)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--chromium")
    parser.add_argument("--keep-browser", action="store_true")
    args = parser.parse_args()

    html_path = args.html.resolve()
    html = html_path.read_text(encoding="utf-8")
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    oracle = json.loads(ORACLE_PATH.read_text(encoding="utf-8"))
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    args.results.parent.mkdir(parents=True, exist_ok=True)

    report: dict[str, Any] = {
        "schema": "portal-workshop-browser-matrix/v1",
        "mode": "update" if args.update_goldens else "verify",
        "html": str(html_path.relative_to(ROOT)),
        "htmlSha256": sha256(html.encode()),
        "sceneCorpusVersion": corpus["version"],
        "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scenes": {},
        "resize": [],
        "editor": {},
        "lifecycle": {},
        "errors": [],
        "console": [],
    }
    failures: list[str] = []

    with CleanChromium(args.chromium, keep=args.keep_browser) as browser:
        report["browser"] = browser.version()
        cdp, target = browser.new_page()
        try:
            cdp.command("Page.enable")
            cdp.command("Runtime.enable")
            cdp.command("Log.enable")
            cdp.command("Page.setLifecycleEventsEnabled", {"enabled": True})
            set_viewport(cdp, 640, 360)
            frame_id = cdp.command("Page.getFrameTree")["frameTree"]["frame"]["id"]
            cdp.command("Page.setDocumentContent", {"frameId": frame_id, "html": html}, timeout=180)
            cdp.wait_for("!!window.__portalDebug?.__releaseAttached && !!window.PortalWorkshopEngine?.runtime()", timeout=60)
            cdp.evaluate(HIDE_UI_JS)
            report["webgl"] = cdp.evaluate("window.__portalDebug.webglInfo()")
            report["initial"] = cdp.evaluate("window.__portalDebug.forceRender()", timeout=180)

            for entry in corpus["scenes"]:
                scene_id, scene = entry["id"], entry["scene"]
                viewport = oracle["scenes"][scene_id]["pixel"]["viewport"]
                set_viewport(cdp, int(viewport[0]), int(viewport[1]))
                state = load_scene(cdp, scene)
                # A second synchronous render catches stale resize/cache paths.
                state = cdp.evaluate("window.__portalDebug.forceRender()", timeout=180)
                png, rgba, size = screenshot_rgba(cdp)
                golden = GOLDEN_DIR / f"{scene_id}.png"
                if args.update_goldens:
                    golden.write_bytes(png)
                    diff = {"sizeMatch": True, "actualSize": list(size), "goldenSize": list(size), "differentPixels": 0, "maxChannelDelta": 0}
                else:
                    if not golden.exists():
                        failures.append(f"{scene_id}: missing golden {golden}")
                        diff = {"sizeMatch": False, "differentPixels": width * height if (width := size[0]) and (height := size[1]) else 0, "maxChannelDelta": 255}
                    else:
                        diff = compare_rgba(png, golden)
                        if diff["differentPixels"] != 0 or diff["maxChannelDelta"] != 0:
                            failures.append(f"{scene_id}: pixel mismatch {diff}")
                info = state.get("rendererInfo", {})
                perf = state.get("portalPerf", {}) or {}
                active_spaces = len([space for space in scene.get("compressedSpaces", []) if space.get("enabled", True)])
                expected_renderer = "metric-bounded-extension" if active_spaces else "euclidean-exact-fair"
                if info.get("renderer") != expected_renderer:
                    failures.append(f"{scene_id}: renderer {info.get('renderer')} != {expected_renderer}")
                if bool(info.get("canonical")) != (active_spaces == 0):
                    failures.append(f"{scene_id}: canonical flag wrong")
                if not active_spaces:
                    if perf.get("scheduler") != "breadth-fair-v1":
                        failures.append(f"{scene_id}: fair scheduler missing")
                    if perf.get("conservativeTerminal") is not True:
                        failures.append(f"{scene_id}: conservative terminal missing")
                    if float(perf.get("fairnessSpan", 0)) > 1:
                        failures.append(f"{scene_id}: branch fairness span {perf.get('fairnessSpan')}")
                if float(state.get("renderMs") or 0) > (15000 if active_spaces else 5000):
                    failures.append(f"{scene_id}: render exceeded release ceiling ({state.get('renderMs')} ms)")
                report["scenes"][scene_id] = {
                    "viewport": list(size),
                    "pngSha256": sha256(png),
                    "rgbaSha256": sha256(rgba),
                    "golden": str(golden.relative_to(ROOT)),
                    "pixelDiff": diff,
                    "renderer": info,
                    "renderMs": state.get("renderMs"),
                    "portalLevels": state.get("portalLevels"),
                    "renderCalls": state.get("renderCalls"),
                    "triangles": state.get("triangles"),
                    "portalPerf": perf,
                }

            # Representative resize matrix: exact canvas dimensions and live redraw.
            basic_scene = next(entry["scene"] for entry in corpus["scenes"] if entry["id"] == "basic-pair")
            cdp.evaluate(f"PortalWorkshopEngine.runtime().loadScene({json.dumps(basic_scene, separators=(',', ':'))}); true")
            for width, height in oracle["scenes"]["basic-pair"]["resize"]["viewports"]:
                set_viewport(cdp, width, height)
                state = cdp.evaluate("window.__portalDebug.forceRender()", timeout=180)
                observed = [state.get("width"), state.get("height")]
                passed = observed == [width, height] and state.get("rendererInfo", {}).get("renderer") == "euclidean-exact-fair"
                report["resize"].append({"requested": [width, height], "observed": observed, "renderer": state.get("rendererInfo", {}).get("renderer"), "pass": passed})
                if not passed:
                    failures.append(f"resize {width}x{height}: observed {observed}")

            # Editor transaction matrix against the live workshop, including history.
            editor_scene = next(entry["scene"] for entry in corpus["scenes"] if entry["id"] == "editor-fixture")
            set_viewport(cdp, 640, 360)
            cdp.evaluate(f"PortalWorkshopEngine.runtime().loadScene({json.dumps(editor_scene, separators=(',', ':'))}); true")
            editor = cdp.evaluate(r'''(()=>{
              const r=PortalWorkshopEngine.runtime();
              const initial=r.getScene();
              const edit=r.setEditMode(true);
              const addedId=r.addPair('oval');
              const afterAdd=r.getScene();
              const duplicated=r.duplicate();
              const afterDuplicate=r.getScene();
              const undo=r.undo();
              const afterUndo=r.getScene();
              const redo=r.redo();
              const afterRedo=r.getScene();
              const removed=r.remove();
              const afterRemove=r.getScene();
              const undoRemove=r.undo();
              const restored=r.getScene();
              r.setEditMode(false);
              window.__portalDebug.forceRender();
              return {initial:initial.portals.length,edit,addedId,afterAdd:afterAdd.portals.length,hasOval:afterAdd.portals.some(p=>p.shape==='oval'),duplicated,afterDuplicate:afterDuplicate.portals.length,undo,afterUndo:afterUndo.portals.length,redo,afterRedo:afterRedo.portals.length,removed,afterRemove:afterRemove.portals.length,undoRemove,restored:restored.portals.length,selected:restored.selectedId};
            })()''', timeout=180)
            editor_pass = (
                editor.get("edit") is True and editor.get("afterAdd") == editor.get("initial") + 2 and editor.get("hasOval") is True
                and editor.get("duplicated") is True and editor.get("afterDuplicate") == editor.get("initial") + 4
                and editor.get("undo") is True and editor.get("afterUndo") == editor.get("initial") + 2
                and editor.get("redo") is True and editor.get("afterRedo") == editor.get("initial") + 4
                and editor.get("removed") is True and editor.get("afterRemove") == editor.get("initial") + 2
                and editor.get("undoRemove") is True and editor.get("restored") == editor.get("initial") + 4
            )
            report["editor"] = {**editor, "pass": editor_pass}
            if not editor_pass:
                failures.append(f"editor transaction failed: {editor}")

            # Actual WebGL context loss and restoration.
            cdp.evaluate(f"PortalWorkshopEngine.runtime().loadScene({json.dumps(basic_scene, separators=(',', ':'))}); window.__portalDebug.forceRender(); true", timeout=180)
            cycle_supported = cdp.evaluate("window.__portalDebug.contextCycle(160)", timeout=30)
            restored = False
            lifecycle_state = None
            if cycle_supported:
                try:
                    lifecycle_state = cdp.wait_for("(()=>{const s=window.__portalDebug.lifecycle();return s.contextRestoredCount>0&&!s.contextLost?s:null})()", timeout=15)
                    restored = bool(lifecycle_state)
                    if restored:
                        cdp.evaluate("window.__portalDebug.forceRender()", timeout=180)
                except Exception as exc:
                    lifecycle_state = {"error": str(exc)}
            if not cycle_supported or not restored:
                failures.append(f"WebGL context loss/restore failed: supported={cycle_supported}, state={lifecycle_state}")

            # Browser lifecycle visibility transition. This is a real CDP lifecycle state,
            # not a synthetic DOM event; it is restored before querying the page.
            visibility_ok = False
            visibility_error = None
            before_visibility = cdp.evaluate("window.__portalDebug.lifecycle()")
            try:
                cdp.command("Page.setWebLifecycleState", {"state": "frozen"}, timeout=10)
                time.sleep(0.2)
                cdp.command("Page.setWebLifecycleState", {"state": "active"}, timeout=10)
                time.sleep(0.2)
                after_visibility = cdp.evaluate("window.__portalDebug.lifecycle()")
                visibility_ok = after_visibility.get("visibilityChanges", 0) > before_visibility.get("visibilityChanges", 0)
            except Exception as exc:
                after_visibility = None
                visibility_error = str(exc)
            if not visibility_ok:
                failures.append(f"visibility lifecycle transition failed: {visibility_error or after_visibility}")
            report["lifecycle"] = {
                "contextCycleSupported": cycle_supported,
                "contextRestored": restored,
                "contextState": lifecycle_state,
                "visibilityBefore": before_visibility,
                "visibilityAfter": after_visibility,
                "visibilityPass": visibility_ok,
                "visibilityError": visibility_error,
            }

            # Drain queued runtime events.
            with contextlib.suppress(Exception):
                cdp.evaluate("0")
            errors, console = event_errors(cdp.events)
            report["errors"] = errors
            report["console"] = console
            if errors:
                failures.append(f"browser console/runtime errors: {errors[:3]}")
        finally:
            with contextlib.suppress(Exception):
                cdp.command("Page.close", timeout=5)
            cdp.close()

    report["finishedUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report["pass"] = not failures
    report["failures"] = failures
    args.results.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"pass": report["pass"], "failures": failures, "results": str(args.results), "sceneCount": len(report["scenes"])}, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
