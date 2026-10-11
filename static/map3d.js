// 3D view of the home, loaded on demand when you switch the map to 3D.
//
// The colour map becomes the floor, walls and furniture are raised from the
// room mask, and the robot, dock, invisible walls and zones are small models on
// top. One scene unit is one map block (5 cm). Controls follow the 2D map:
// drag rotates, a two-finger swipe moves, pinch or the wheel zooms.

import * as THREE from "./vendor/three.module.min.js";

const WALL_H = 11; // 55 cm: low enough to see into rooms from most angles
const FURNITURE_H = 6;
const ROBOT_R = 3.5; // the robot is about 35 cm across
const ROBOT_H = 2;
const MIN_PITCH = 0.08; // radians from straight down
const MAX_PITCH = 1.3;

export function createMap3D(container, hooks) {
  return new Map3D(container, hooks);
}

function css(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Cover a grid of cells with as few rectangles as possible ("greedy meshing"),
// so a whole wall becomes a handful of boxes instead of hundreds of cubes.
function rectangles(w, h, test) {
  const used = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (used[i] || !test(i)) continue;
      let x1 = x;
      while (x1 + 1 < w && !used[i + (x1 + 1 - x)] && test(i + (x1 + 1 - x))) x1++;
      let y1 = y;
      grow: while (y1 + 1 < h) {
        for (let k = x; k <= x1; k++) {
          const j = (y1 + 1) * w + k;
          if (used[j] || !test(j)) break grow;
        }
        y1++;
      }
      for (let yy = y; yy <= y1; yy++) used.fill(1, yy * w + x, yy * w + x1 + 1);
      out.push([x, y, x1 - x + 1, y1 - y + 1]);
    }
  }
  return out;
}

class Map3D {
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks; // { roomAt({x,y}) -> id, onRoomClick(id), onHover(id) }
    this.active = false;
    this.W = 1;
    this.H = 1;
    this.scale = 4;
    this.maskKey = "";
    this.view = { tx: 0, tz: 0, dist: 100, yaw: 0, pitch: 0.95 };
    this.fitDist = 100;
    this.robotAnim = null;
    this.hover = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "map3d-canvas";
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.labelsEl = document.createElement("div");
    this.labelsEl.className = "map3d-labels";
    container.appendChild(this.labelsEl);

    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 50000);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xd8e0ec, 2.1);
    scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.4;
    scene.add(sun, sun.target);
    this.sun = sun;

    // Floor: the same image as the 2D map, plus the selection overlay on top.
    this.floorTex = new THREE.Texture();
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    this.floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // alphaTest cuts out the unmapped area around the home instead of painting it black.
    this.floorMat = new THREE.MeshStandardMaterial({ map: this.floorTex, roughness: 1, metalness: 0, alphaTest: 0.5 });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    this.selTex = null;
    this.selMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    this.selection = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.selMat);
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.position.y = 0.06;
    this.selection.renderOrder = 1;
    scene.add(this.selection);

    this.wallMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    this.furnitureMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    this.walls = null;
    this.furniture = null;
    this.restrictions = new THREE.Group();
    scene.add(this.restrictions);

    this.robot = this.makeRobot();
    this.robot.visible = false;
    scene.add(this.robot);
    this.dock = this.makeDock();
    this.dock.visible = false;
    scene.add(this.dock);

    this.applyTheme();
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  // ---------- models ----------

  makeRobot() {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(ROBOT_R, ROBOT_R, ROBOT_H, 48), white);
    body.position.y = ROBOT_H / 2 + 0.2;
    body.castShadow = true;
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(ROBOT_R + 0.05, ROBOT_R + 0.05, 0.5, 48),
      new THREE.MeshStandardMaterial({ color: 0x9aa6b8, roughness: 0.6 }),
    );
    ring.position.y = 0.55;
    const lidar = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.9, 32), white);
    lidar.position.set(-0.6, ROBOT_H + 0.65, 0);
    lidar.castShadow = true;
    this.accentMat = new THREE.MeshStandardMaterial({ color: 0x4c7df0, roughness: 0.4, emissive: 0x4c7df0, emissiveIntensity: 0.25 });
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 3.4), this.accentMat);
    nose.position.set(ROBOT_R - 0.75, ROBOT_H + 0.25, 0);
    g.add(body, ring, lidar, nose);
    return g;
  }

  makeDock() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(6.5, 7, 4.5),
      new THREE.MeshStandardMaterial({ color: 0xf7f8fa, roughness: 0.5 }),
    );
    base.position.y = 3.5;
    base.castShadow = true;
    const light = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.4, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x1f9d6b, emissive: 0x1f9d6b, emissiveIntensity: 0.8 }),
    );
    light.position.set(0, 5.6, 2.3);
    g.add(base, light);
    return g;
  }

  // ---------- data ----------

  // Called whenever the app has a new map. Cheap when only the robot moved.
  setMap(m, mask, maskKey) {
    const sizeChanged = mask.w !== this.W || mask.h !== this.H;
    this.W = mask.w;
    this.H = mask.h;
    this.scale = m.scale;
    if (sizeChanged) {
      this.floor.geometry.dispose();
      this.floor.geometry = new THREE.PlaneGeometry(this.W, this.H);
      this.selection.geometry.dispose();
      this.selection.geometry = new THREE.PlaneGeometry(this.W, this.H);
      this.placeSun();
    }
    if (maskKey !== this.maskKey) {
      this.maskKey = maskKey;
      this.buildWalls(mask);
    }
    this.setFloorImage(m.base);
    this.setRobot(m.robot, m.charger, sizeChanged);
    if (sizeChanged) this.resetView(false);
    this.requestRender();
  }

  setFloorImage(src) {
    if (this.floorSrc === src) return;
    this.floorSrc = src;
    const img = new Image();
    img.onload = () => {
      if (this.floorSrc !== src) return;
      this.floorTex.image = img;
      this.floorTex.needsUpdate = true;
      this.requestRender();
    };
    img.src = src;
  }

  setSelectionCanvas(canvas) {
    if (!this.selTex || this.selTex.image !== canvas) {
      if (this.selTex) this.selTex.dispose();
      this.selTex = new THREE.CanvasTexture(canvas);
      this.selTex.colorSpace = THREE.SRGBColorSpace;
      this.selTex.magFilter = THREE.NearestFilter;
      this.selMat.map = this.selTex;
      this.selMat.needsUpdate = true;
    }
    this.selTex.needsUpdate = true;
    this.requestRender();
  }

  buildWalls(mask) {
    const { w, h, data } = mask;
    for (const key of ["walls", "furniture"]) {
      if (this[key]) {
        this.scene.remove(this[key]);
        this[key].geometry.dispose();
        this[key] = null;
      }
    }
    const kind = (k) => (i) => data[i * 4 + 3] && !data[i * 4] && data[i * 4 + 1] === k;
    this.walls = this.instanced(rectangles(w, h, kind(1)), WALL_H, this.wallMat);
    this.furniture = this.instanced(rectangles(w, h, kind(2)), FURNITURE_H, this.furnitureMat);
  }

  instanced(rects, height, material) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, Math.max(rects.length, 1));
    mesh.count = rects.length;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const size = new THREE.Vector3();
    rects.forEach(([x, y, rw, rh], i) => {
      pos.set(x + rw / 2 - this.W / 2, height / 2, y + rh / 2 - this.H / 2);
      size.set(rw, height, rh);
      mesh.setMatrixAt(i, m.compose(pos, quat, size));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  // Walls and zones as tinted glass: [{type, pts: [[px, py], ...]}] in base-image px.
  setRestrictions(items) {
    for (const child of [...this.restrictions.children]) {
      this.restrictions.remove(child);
      child.geometry.dispose();
    }
    const colour = { wall: 0xe5484d, no_go: 0xe5484d, no_mop: 0x8b5cf6 };
    for (const it of items) {
      const pts = it.pts.map(([x, y]) => [x / this.scale - this.W / 2, y / this.scale - this.H / 2]);
      const mat = new THREE.MeshBasicMaterial({ color: colour[it.type], transparent: true, opacity: it.type === "wall" ? 0.55 : 0.22, depthWrite: false, side: THREE.DoubleSide });
      if (it.type === "wall") {
        const [[x0, z0], [x1, z1]] = pts;
        const len = Math.hypot(x1 - x0, z1 - z0);
        const glass = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H * 0.7, 0.7), mat);
        glass.position.set((x0 + x1) / 2, (WALL_H * 0.7) / 2, (z0 + z1) / 2);
        glass.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
        this.restrictions.add(glass);
      } else {
        const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
        const area = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
        area.rotation.x = -Math.PI / 2;
        area.position.y = 0.12;
        const edge = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, 0.15, z))),
          new THREE.LineBasicMaterial({ color: colour[it.type] }),
        );
        this.restrictions.add(area, edge);
      }
    }
    this.requestRender();
  }

  setRobot(robot, charger, jump) {
    if (charger) {
      this.dock.visible = true;
      this.dock.position.set(charger.x / this.scale - this.W / 2, 0, charger.y / this.scale - this.H / 2);
    } else {
      this.dock.visible = false;
    }
    if (!robot) { this.robot.visible = false; return; }
    const to = { x: robot.x / this.scale - this.W / 2, z: robot.y / this.scale - this.H / 2, a: ((robot.a || 0) * Math.PI) / 180 };
    if (!this.robot.visible || jump) {
      this.robot.visible = true;
      this.robot.position.set(to.x, 0, to.z);
      this.robot.rotation.y = to.a;
      this.robotAnim = null;
      return;
    }
    const from = { x: this.robot.position.x, z: this.robot.position.z, a: this.robot.rotation.y };
    if (Math.hypot(to.x - from.x, to.z - from.z) < 0.01 && Math.abs(to.a - from.a) < 0.01) return;
    // Glide between map updates instead of jumping.
    let da = (to.a - from.a) % (Math.PI * 2);
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    this.robotAnim = { from, to: { ...to, a: from.a + da }, start: performance.now(), ms: 1200 };
  }

  // Room labels float just above the floor: [{id, name, x, y, sel}] in base px.
  setLabels(rooms) {
    this.labels = rooms.map((r) => ({ ...r, pos: new THREE.Vector3(r.x / this.scale - this.W / 2, 1, r.y / this.scale - this.H / 2) }));
    this.labelsEl.innerHTML = rooms
      .map((r) => `<button class="room-label ${r.sel ? "sel" : ""}" data-room="${r.id}"><svg class="i tick"><use href="#i-check"/></svg>${r.name.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))}</button>`)
      .join("");
    this.requestRender();
  }

  applyTheme() {
    this.wallMat.color.set(css("--map3d-wall", "#f4f6fa"));
    this.furnitureMat.color.set(css("--map3d-furniture", "#e1e5ec"));
    this.floorMat.color.set(css("--map3d-floor", "#ffffff"));
    this.hemi.groundColor.set(css("--map3d-ground", "#d8e0ec"));
    this.accentMat.color.set(css("--accent", "#4c7df0"));
    this.accentMat.emissive.set(css("--accent", "#4c7df0"));
    this.requestRender();
  }

  // ---------- camera ----------

  placeSun() {
    const s = Math.max(this.W, this.H);
    this.sun.position.set(-s * 0.35, s * 0.9, s * 0.55);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = -s * 0.75;
    cam.right = s * 0.75;
    cam.top = s * 0.75;
    cam.bottom = -s * 0.75;
    cam.near = 1;
    cam.far = s * 3;
    cam.updateProjectionMatrix();
  }

  fitDistance() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect || 1;
    const need = Math.max(this.H * 0.95, (this.W / aspect) * 1.05);
    return (need / 2 / Math.tan(fov / 2)) * 1.12;
  }

  resetView(animate = true) {
    this.fitDist = this.fitDistance();
    const target = { tx: 0, tz: this.H * 0.03, dist: this.fitDist, yaw: 0, pitch: 0.68 };
    this.animateTo(target, animate);
  }

  centerOnRobot() {
    if (!this.robot.visible) return false;
    this.animateTo({ ...this.view, tx: this.robot.position.x, tz: this.robot.position.z, dist: Math.min(this.view.dist, this.fitDist * 0.45) }, true);
    return true;
  }

  zoomBy(f) {
    this.animateTo({ ...this.view, dist: this.clampDist(this.view.dist / f) }, true);
  }

  pan(dx, dy) {
    const k = this.unitsPerPixel();
    const { right, forward } = this.groundAxes();
    this.view.tx += (right.x * dx + forward.x * dy) * k;
    this.view.tz += (right.z * dx + forward.z * dy) * k;
    this.clampTarget();
    this.requestRender();
  }

  animateTo(target, animate) {
    if (!animate) {
      Object.assign(this.view, target);
      this.camAnim = null;
      this.requestRender();
      return;
    }
    this.camAnim = { from: { ...this.view }, to: target, start: performance.now(), ms: 420 };
    this.requestRender();
  }

  clampDist(d) {
    return THREE.MathUtils.clamp(d, this.fitDist * 0.12, this.fitDist * 2.5);
  }

  clampTarget() {
    this.view.tx = THREE.MathUtils.clamp(this.view.tx, -this.W * 0.6, this.W * 0.6);
    this.view.tz = THREE.MathUtils.clamp(this.view.tz, -this.H * 0.6, this.H * 0.6);
  }

  unitsPerPixel() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    return (2 * this.view.dist * Math.tan(fov / 2)) / (this.container.clientHeight || 1);
  }

  groundAxes() {
    const { yaw } = this.view;
    return {
      right: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
      forward: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), // points toward the camera
    };
  }

  updateCamera() {
    const { tx, tz, dist, yaw, pitch } = this.view;
    const c = this.camera;
    c.position.set(tx + dist * Math.sin(pitch) * Math.sin(yaw), dist * Math.cos(pitch), tz + dist * Math.sin(pitch) * Math.cos(yaw));
    c.lookAt(tx, 0, tz);
  }

  groundAt(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector3(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5);
    p.unproject(this.camera);
    const dir = p.sub(this.camera.position).normalize();
    if (dir.y > -1e-4) return null;
    const t = -this.camera.position.y / dir.y;
    return this.camera.position.clone().add(dir.multiplyScalar(t));
  }

  // Base-image pixel under the pointer (what the 2D map's room lookup expects).
  pixelAt(clientX, clientY) {
    const g = this.groundAt(clientX, clientY);
    if (!g) return null;
    return { x: (g.x + this.W / 2) * this.scale, y: (g.z + this.H / 2) * this.scale };
  }

  // ---------- rendering ----------

  setActive(on) {
    this.active = on;
    if (on) {
      this.resize();
      this.requestRender();
    }
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const fit = this.fitDistance();
    if (Math.abs(fit - this.fitDist) > 1e-3) {
      // Keep the same relative zoom when the window changes size.
      this.view.dist *= fit / this.fitDist;
      this.fitDist = fit;
    }
    this.requestRender();
  }

  requestRender() {
    if (!this.active || this.raf) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  frame(now) {
    this.raf = 0;
    let moving = false;
    const ease = (k) => 1 - Math.pow(1 - k, 3);
    if (this.camAnim) {
      const k = Math.min(1, (now - this.camAnim.start) / this.camAnim.ms);
      const { from, to } = this.camAnim;
      for (const key of Object.keys(to)) this.view[key] = from[key] + (to[key] - from[key]) * ease(k);
      if (k < 1) moving = true;
      else this.camAnim = null;
    }
    if (this.robotAnim) {
      const k = Math.min(1, (now - this.robotAnim.start) / this.robotAnim.ms);
      const { from, to } = this.robotAnim;
      this.robot.position.set(from.x + (to.x - from.x) * k, 0, from.z + (to.z - from.z) * k);
      this.robot.rotation.y = from.a + (to.a - from.a) * ease(k);
      if (k < 1) moving = true;
      else this.robotAnim = null;
    }
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    if (moving) this.requestRender();
  }

  placeLabels() {
    if (!this.labels) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const els = this.labelsEl.children;
    const v = new THREE.Vector3();
    this.labels.forEach((l, i) => {
      const el = els[i];
      if (!el) return;
      v.copy(l.pos).project(this.camera);
      const off = v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2;
      el.style.display = off ? "none" : "";
      el.style.left = `${((v.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - v.y) / 2) * h}px`;
    });
  }

  // ---------- input ----------

  bindEvents() {
    const el = this.container;
    const pointers = new Map();
    let drag = null;

    el.addEventListener("wheel", (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.camAnim = null;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && e.wheelDeltaY && e.wheelDeltaY % 120 === 0 && Math.abs(e.deltaY) >= 50);
      if (e.ctrlKey || mouseWheel) this.zoomAt(e.clientX, e.clientY, Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0025)));
      else this.pan(dx, dy);
    }, { passive: false });

    // Safari sends trackpad pinch as gesture events.
    let gestureBase = 1;
    el.addEventListener("gesturestart", (e) => { if (!this.active) return; e.preventDefault(); gestureBase = this.view.dist; });
    el.addEventListener("gesturechange", (e) => {
      if (!this.active) return;
      e.preventDefault();
      const d = this.clampDist(gestureBase / e.scale);
      this.zoomAt(e.clientX, e.clientY, d / this.view.dist);
    });

    el.addEventListener("pointerdown", (e) => {
      if (!this.active || e.target.closest(".room-label")) return;
      this.camAnim = null;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        drag = { type: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, angle: Math.atan2(b.y - a.y, b.x - a.x), moved: true };
        return;
      }
      const pan = e.button === 1 || e.button === 2 || e.shiftKey || this.spaceDown;
      drag = { type: pan ? "pan" : "orbit", x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
      if (pan) e.preventDefault();
    });

    el.addEventListener("pointermove", (e) => {
      if (!this.active) return;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!drag) {
        if (e.pointerType === "mouse") {
          const px = this.pixelAt(e.clientX, e.clientY);
          const id = px ? this.hooks.roomAt(px) : 0;
          if (id !== this.hover) { this.hover = id; this.hooks.onHover(id); }
          el.classList.toggle("over-room", !!id);
        }
        return;
      }
      if (drag.type === "pinch" && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        this.pan(drag.m.x - m.x, drag.m.y - m.y);
        this.zoomAt(m.x, m.y, drag.d / d);
        this.view.yaw -= angle - drag.angle; // twist two fingers to turn
        Object.assign(drag, { m, d, angle });
        this.requestRender();
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      el.classList.add("dragging");
      if (drag.type === "pan") {
        this.pan(-dx, -dy);
      } else {
        this.view.yaw -= dx * 0.006;
        this.view.pitch = THREE.MathUtils.clamp(this.view.pitch - dy * 0.005, MIN_PITCH, MAX_PITCH);
        this.requestRender();
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (!drag) return;
      if (drag.type !== "pinch" && !drag.moved && e.type === "pointerup") {
        const px = this.pixelAt(e.clientX, e.clientY);
        const id = px ? this.hooks.roomAt(px) : 0;
        if (id) this.hooks.onRoomClick(id);
      }
      if (pointers.size === 0) {
        drag = null;
        el.classList.remove("dragging");
      } else if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        drag = { type: "orbit", x: p.x, y: p.y, x0: p.x, y0: p.y, moved: true };
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", () => {
      if (!drag && this.hover) { this.hover = 0; this.hooks.onHover(0); }
    });
    el.addEventListener("contextmenu", (e) => this.active && e.preventDefault());
    this.labelsEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-room]");
      if (b) this.hooks.onRoomClick(Number(b.dataset.room));
    });
  }

  // Zoom by a factor (<1 = closer), keeping the floor point under the pointer in place.
  zoomAt(clientX, clientY, factor) {
    const before = this.groundAt(clientX, clientY);
    this.view.dist = this.clampDist(this.view.dist * factor);
    this.updateCamera();
    const after = this.groundAt(clientX, clientY);
    if (before && after) {
      this.view.tx += before.x - after.x;
      this.view.tz += before.z - after.z;
      this.clampTarget();
    }
    this.requestRender();
  }
}
