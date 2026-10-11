// 3D view of the home, loaded on demand when you switch the map to 3D.
//
// The colour map becomes the floor, walls and furniture are raised from the
// room mask, and the robot, dock, invisible walls and zones are small models on
// top. One scene unit is one map block (5 cm). Controls follow the 2D map:
// drag turns, a two-finger swipe moves, pinch or the wheel zooms.

import * as THREE from "three";
import type { Layers, Pt } from "./state";
import type { MapPayload, Mask, Point, Polyline, RestrictionType } from "./types";

const WALL_H = 11; // 55 cm: low enough to see into rooms from most angles
const FURNITURE_H = 6;
const RUG_H = 0.6; // carpets stand a little proud of the floor
const PATH_Y = RUG_H + 0.08;
const MOP_WIDTH = 3; // mopped strip, drawn narrower than the pads so the map stays readable
const ROBOT_R = 3.5; // the robot is about 35 cm across
const ROBOT_H = 2;
const MIN_PITCH = 0.08; // radians from straight down
const MAX_PITCH = 1.3;

export interface Map3DHooks {
  roomAt(p: Point): number;
  onRoomClick(id: number): void;
  onHover(id: number): void;
}

/** A small marker floating over the floor: an obstacle, the go-to target. */
export interface Marker3D {
  x: number; // base px
  y: number;
  cls: string;
  title: string;
  icon: string;
}

export interface Label3D {
  id: number;
  name: string;
  x: number; // base px
  y: number;
  sel: boolean;
}

interface View {
  tx: number;
  tz: number;
  dist: number;
  yaw: number;
  pitch: number;
}

interface RobotPose {
  x: number;
  z: number;
  a: number;
}

type Drag =
  | { type: "pinch"; d: number; m: Point; angle: number; moved: true }
  | { type: "pan" | "orbit"; x: number; y: number; x0: number; y0: number; moved: boolean };

type SafariGesture = Event & { scale: number; clientX: number; clientY: number };

export function createMap3D(container: HTMLElement, hooks: Map3DHooks): Map3D {
  return new Map3D(container, hooks);
}

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c] ?? c);

// A flat strip along a polyline, so paths stay visible from above (WebGL lines are 1px).
function ribbon(points: Pt[], width: number, y: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  points.forEach(([x, z], i) => {
    const [ax, az] = points[Math.max(0, i - 1)];
    const [bx, bz] = points[Math.min(points.length - 1, i + 1)];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const nx = (-(bz - az) / len) * (width / 2);
    const nz = ((bx - ax) / len) * (width / 2);
    pos.push(x + nx, y, z + nz, x - nx, y, z - nz);
    if (i > 0) {
      const k = i * 2;
      idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// Cover a grid of cells with as few rectangles as possible ("greedy meshing"),
// so a whole wall becomes a handful of boxes instead of hundreds of cubes.
function rectangles(w: number, h: number, test: (i: number) => boolean): [number, number, number, number][] {
  const used = new Uint8Array(w * h);
  const out: [number, number, number, number][] = [];
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

export class Map3D {
  spaceDown = false;

  private readonly container: HTMLElement;
  private readonly hooks: Map3DHooks;
  private active = false;
  private W = 1;
  private H = 1;
  private scale = 4;
  private maskKey = "";
  private floorSrc = "";
  private view: View = { tx: 0, tz: 0, dist: 100, yaw: 0, pitch: 0.95 };
  private fitDist = 100;
  private camAnim: { from: View; to: View; start: number; ms: number } | null = null;
  private robotAnim: { from: RobotPose; to: RobotPose; start: number; ms: number } | null = null;
  private hover = 0;
  private raf = 0;
  private labels: (Label3D & { pos: THREE.Vector3 })[] = [];
  private markers: THREE.Vector3[] = [];
  private layers: Layers = { path: true, carpets: true, obstacles: true, restrictions: true };

  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelsEl: HTMLDivElement;
  private readonly markersEl: HTMLDivElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 1, 50000);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xd8e0ec, 2.1);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private readonly floorTex = new THREE.Texture();
  private readonly floorMat: THREE.MeshStandardMaterial;
  private readonly floor: THREE.Mesh;
  private selTex: THREE.CanvasTexture | null = null;
  private readonly selMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  private readonly selection: THREE.Mesh;
  private readonly wallMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  private readonly furnitureMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  private walls: THREE.InstancedMesh | null = null;
  private furniture: THREE.InstancedMesh | null = null;
  private rugs: THREE.InstancedMesh | null = null;
  private readonly rugMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  private readonly pathGroup = new THREE.Group();
  private readonly infoGroup = new THREE.Group();
  private readonly noCarpetGroup = new THREE.Group();
  private readonly restrictions = new THREE.Group();
  private readonly accentMat = new THREE.MeshStandardMaterial({ color: 0x4c7df0, roughness: 0.4, emissive: 0x4c7df0, emissiveIntensity: 0.25 });
  private readonly robot: THREE.Group;
  private readonly dock: THREE.Group;

  constructor(container: HTMLElement, hooks: Map3DHooks) {
    this.container = container;
    this.hooks = hooks;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "map3d-canvas";
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.markersEl = document.createElement("div");
    this.markersEl.className = "map3d-markers";
    container.appendChild(this.markersEl);
    this.labelsEl = document.createElement("div");
    this.labelsEl.className = "map3d-labels";
    container.appendChild(this.labelsEl);

    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.4;
    this.scene.add(this.sun, this.sun.target);

    // Floor: the same image as the 2D map, plus the selection overlay on top.
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    this.floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // alphaTest cuts out the unmapped area around the home instead of painting it black.
    this.floorMat = new THREE.MeshStandardMaterial({ map: this.floorTex, roughness: 1, metalness: 0, alphaTest: 0.5 });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.selection = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.selMat);
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.position.y = 0.06;
    this.selection.renderOrder = 1;
    this.scene.add(this.selection);

    this.scene.add(this.restrictions, this.pathGroup, this.infoGroup, this.noCarpetGroup);
    this.robot = this.makeRobot();
    this.robot.visible = false;
    this.scene.add(this.robot);
    this.dock = this.makeDock();
    this.dock.visible = false;
    this.scene.add(this.dock);

    this.applyTheme();
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  /* ---------- models ---------- */

  private makeRobot(): THREE.Group {
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
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 3.4), this.accentMat);
    nose.position.set(ROBOT_R - 0.75, ROBOT_H + 0.25, 0);
    g.add(body, ring, lidar, nose);
    return g;
  }

  private makeDock(): THREE.Group {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(6.5, 7, 4.5), new THREE.MeshStandardMaterial({ color: 0xf7f8fa, roughness: 0.5 }));
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

  /* ---------- data ---------- */

  /** Called whenever the app has a new map. Cheap when only the robot moved. */
  setMap(m: MapPayload, mask: Mask, maskKey: string): void {
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

  private setFloorImage(src: string): void {
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

  setSelectionCanvas(canvas: HTMLCanvasElement): void {
    if (!this.selTex || this.selTex.image !== canvas) {
      this.selTex?.dispose();
      this.selTex = new THREE.CanvasTexture(canvas);
      this.selTex.colorSpace = THREE.SRGBColorSpace;
      this.selTex.magFilter = THREE.NearestFilter;
      this.selMat.map = this.selTex;
      this.selMat.needsUpdate = true;
    }
    this.selTex.needsUpdate = true;
    this.requestRender();
  }

  private buildWalls(mask: Mask): void {
    const { w, h, data } = mask;
    for (const mesh of [this.walls, this.furniture, this.rugs]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    const kind = (k: number) => (i: number) => !!data[i * 4 + 3] && !data[i * 4] && data[i * 4 + 1] === k;
    this.walls = this.instanced(rectangles(w, h, kind(1)), WALL_H, this.wallMat);
    this.furniture = this.instanced(rectangles(w, h, kind(2)), FURNITURE_H, this.furnitureMat);
    const carpet = (i: number) => !!data[i * 4 + 3] && data[i * 4 + 2] === 1 && data[i * 4 + 1] !== 1;
    this.rugs = this.instanced(rectangles(w, h, carpet), RUG_H, this.rugMat);
    this.rugs.castShadow = false;
    this.rugs.visible = this.layers.carpets;
  }

  private instanced(rects: [number, number, number, number][], height: number, material: THREE.Material): THREE.InstancedMesh {
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

  /** Walls and zones as tinted glass, with corners in base-image px. */
  setRestrictions(items: { type: RestrictionType; pts: Pt[] }[]): void {
    for (const child of [...this.restrictions.children]) {
      this.restrictions.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) child.geometry.dispose();
    }
    const colour: Record<RestrictionType, number> = { wall: 0xe5484d, no_go: 0xe5484d, no_mop: 0x8b5cf6 };
    for (const it of items) {
      const pts = it.pts.map(([x, y]): Pt => [x / this.scale - this.W / 2, y / this.scale - this.H / 2]);
      const mat = new THREE.MeshBasicMaterial({
        color: colour[it.type],
        transparent: true,
        opacity: it.type === "wall" ? 0.72 : 0.32,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
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

  /** The cleaning path (and where it mopped), no-carpet zones, the zone being cleaned and the go-to route. */
  setThings(m: MapPayload, markers: Marker3D[]): void {
    for (const group of [this.pathGroup, this.infoGroup, this.noCarpetGroup]) {
      for (const child of [...group.children]) {
        group.remove(child);
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) child.geometry.dispose();
      }
    }
    const world = (line: Polyline): Pt[] => line.map(([x, y]): Pt => [x / this.scale - this.W / 2, y / this.scale - this.H / 2]);
    const flat = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    const mop = flat(0xffffff, 0.32);
    const vac = flat(0xffffff, 0.95);
    for (const line of m.mop_path ?? []) this.pathGroup.add(new THREE.Mesh(ribbon(world(line), MOP_WIDTH, PATH_Y - 0.02), mop));
    for (const line of m.path ?? []) this.pathGroup.add(new THREE.Mesh(ribbon(world(line), 0.3, PATH_Y), vac));

    const outline = (pts: Pt[], color: number, fill: number, group: THREE.Group) => {
      const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      const area = new THREE.Mesh(new THREE.ShapeGeometry(shape), flat(color, fill));
      area.rotation.x = -Math.PI / 2;
      area.position.y = PATH_Y + 0.02;
      const edge = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, PATH_Y + 0.04, z))),
        new THREE.LineBasicMaterial({ color }),
      );
      group.add(area, edge);
    };
    for (const area of m.no_carpet ?? []) outline(world(area), 0xe0900f, 0.26, this.noCarpetGroup);
    const accent = new THREE.Color(css("--accent", "#4c7df0")).getHex();
    for (const [x0, y0, x1, y1] of m.zones ?? []) {
      outline(world([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), accent, 0.14, this.infoGroup);
    }
    for (const line of m.goto_path ?? []) this.infoGroup.add(new THREE.Mesh(ribbon(world(line), 0.6, PATH_Y + 0.05), flat(accent, 0.85)));

    this.markers = markers.map((k) => new THREE.Vector3(k.x / this.scale - this.W / 2, 1.5, k.y / this.scale - this.H / 2));
    this.markersEl.innerHTML = markers
      .map((k) => `<span class="thing ${k.cls}" title="${esc(k.title)}"><svg class="i"><use href="#i-${k.icon}"/></svg></span>`)
      .join("");
    this.setLayers(this.layers);
  }

  setLayers(l: Layers): void {
    this.layers = { ...l };
    this.pathGroup.visible = l.path;
    if (this.rugs) this.rugs.visible = l.carpets;
    this.restrictions.visible = l.restrictions;
    this.noCarpetGroup.visible = l.restrictions;
    this.markersEl.hidden = !l.obstacles;
    this.requestRender();
  }

  private setRobot(robot: MapPayload["robot"], charger: MapPayload["charger"], jump: boolean): void {
    if (charger) {
      this.dock.visible = true;
      this.dock.position.set(charger.x / this.scale - this.W / 2, 0, charger.y / this.scale - this.H / 2);
    } else {
      this.dock.visible = false;
    }
    if (!robot) {
      this.robot.visible = false;
      return;
    }
    const to: RobotPose = { x: robot.x / this.scale - this.W / 2, z: robot.y / this.scale - this.H / 2, a: ((robot.a || 0) * Math.PI) / 180 };
    if (!this.robot.visible || jump) {
      this.robot.visible = true;
      this.robot.position.set(to.x, 0, to.z);
      this.robot.rotation.y = to.a;
      this.robotAnim = null;
      return;
    }
    const from: RobotPose = { x: this.robot.position.x, z: this.robot.position.z, a: this.robot.rotation.y };
    if (Math.hypot(to.x - from.x, to.z - from.z) < 0.01 && Math.abs(to.a - from.a) < 0.01) return;
    // Glide between map updates instead of jumping, turning the short way round.
    let da = (to.a - from.a) % (Math.PI * 2);
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    this.robotAnim = { from, to: { ...to, a: from.a + da }, start: performance.now(), ms: 1200 };
  }

  /** Room labels float just above the floor. */
  setLabels(rooms: Label3D[]): void {
    this.labels = rooms.map((r) => ({ ...r, pos: new THREE.Vector3(r.x / this.scale - this.W / 2, 1, r.y / this.scale - this.H / 2) }));
    this.labelsEl.innerHTML = rooms
      .map((r) => `<button class="room-label ${r.sel ? "sel" : ""}" data-room="${r.id}"><svg class="i tick"><use href="#i-check"/></svg>${esc(r.name)}</button>`)
      .join("");
    this.requestRender();
  }

  applyTheme(): void {
    this.wallMat.color.set(css("--map3d-wall", "#f4f6fa"));
    this.furnitureMat.color.set(css("--map3d-furniture", "#e1e5ec"));
    this.rugMat.color.set(css("--map3d-rug", "#e8dcc6"));
    this.floorMat.color.set(css("--map3d-floor", "#ffffff"));
    this.hemi.groundColor.set(css("--map3d-ground", "#d8e0ec"));
    this.accentMat.color.set(css("--accent", "#4c7df0"));
    this.accentMat.emissive.set(css("--accent", "#4c7df0"));
    this.requestRender();
  }

  /* ---------- camera ---------- */

  private placeSun(): void {
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

  private fitDistance(): number {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect || 1;
    const need = Math.max(this.H * 0.95, (this.W / aspect) * 1.05);
    return (need / 2 / Math.tan(fov / 2)) * 1.12;
  }

  resetView(animate = true): void {
    this.fitDist = this.fitDistance();
    this.animateTo({ tx: 0, tz: this.H * 0.03, dist: this.fitDist, yaw: 0, pitch: 0.68 }, animate);
  }

  centerOnRobot(): boolean {
    if (!this.robot.visible) return false;
    this.animateTo({ ...this.view, tx: this.robot.position.x, tz: this.robot.position.z, dist: Math.min(this.view.dist, this.fitDist * 0.45) }, true);
    return true;
  }

  zoomBy(f: number): void {
    this.animateTo({ ...this.view, dist: this.clampDist(this.view.dist / f) }, true);
  }

  /** Move the view by screen pixels (positive dx shows more to the right). */
  pan(dx: number, dy: number): void {
    const k = this.unitsPerPixel();
    const { right, forward } = this.groundAxes();
    this.view.tx += (right.x * dx + forward.x * dy) * k;
    this.view.tz += (right.z * dx + forward.z * dy) * k;
    this.clampTarget();
    this.requestRender();
  }

  private animateTo(target: View, animate: boolean): void {
    if (!animate) {
      Object.assign(this.view, target);
      this.camAnim = null;
      this.requestRender();
      return;
    }
    this.camAnim = { from: { ...this.view }, to: target, start: performance.now(), ms: 420 };
    this.requestRender();
  }

  private clampDist(d: number): number {
    return THREE.MathUtils.clamp(d, this.fitDist * 0.12, this.fitDist * 2.5);
  }

  private clampTarget(): void {
    this.view.tx = THREE.MathUtils.clamp(this.view.tx, -this.W * 0.6, this.W * 0.6);
    this.view.tz = THREE.MathUtils.clamp(this.view.tz, -this.H * 0.6, this.H * 0.6);
  }

  private unitsPerPixel(): number {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    return (2 * this.view.dist * Math.tan(fov / 2)) / (this.container.clientHeight || 1);
  }

  private groundAxes(): { right: THREE.Vector3; forward: THREE.Vector3 } {
    const { yaw } = this.view;
    return {
      right: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
      forward: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), // points toward the camera
    };
  }

  private updateCamera(): void {
    const { tx, tz, dist, yaw, pitch } = this.view;
    this.camera.position.set(tx + dist * Math.sin(pitch) * Math.sin(yaw), dist * Math.cos(pitch), tz + dist * Math.sin(pitch) * Math.cos(yaw));
    this.camera.lookAt(tx, 0, tz);
  }

  private groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector3(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5);
    p.unproject(this.camera);
    const dir = p.sub(this.camera.position).normalize();
    if (dir.y > -1e-4) return null;
    const t = -this.camera.position.y / dir.y;
    return this.camera.position.clone().add(dir.multiplyScalar(t));
  }

  /** Base-image pixel under the pointer (what the 2D map's room lookup expects). */
  private pixelAt(clientX: number, clientY: number): Point | null {
    const g = this.groundAt(clientX, clientY);
    if (!g) return null;
    return { x: (g.x + this.W / 2) * this.scale, y: (g.z + this.H / 2) * this.scale };
  }

  /* ---------- rendering ---------- */

  setActive(on: boolean): void {
    this.active = on;
    if (on) {
      this.resize();
      this.requestRender();
    }
  }

  private resize(): void {
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

  private requestRender(): void {
    if (!this.active || this.raf) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    let moving = false;
    const ease = (k: number) => 1 - Math.pow(1 - k, 3);
    if (this.camAnim) {
      const { from, to, start, ms } = this.camAnim;
      const k = Math.min(1, (now - start) / ms);
      for (const key of Object.keys(to) as (keyof View)[]) this.view[key] = from[key] + (to[key] - from[key]) * ease(k);
      if (k < 1) moving = true;
      else this.camAnim = null;
    }
    if (this.robotAnim) {
      const { from, to, start, ms } = this.robotAnim;
      const k = Math.min(1, (now - start) / ms);
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

  private placeLabels(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const markerEls = this.markersEl.children;
    const mv = new THREE.Vector3();
    this.markers.forEach((pos, i) => {
      const el = markerEls[i] as HTMLElement | undefined;
      if (!el) return;
      mv.copy(pos).project(this.camera);
      el.style.display = mv.z > 1 ? "none" : "";
      el.style.left = `${((mv.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - mv.y) / 2) * h}px`;
    });
    const els = this.labelsEl.children;
    const v = new THREE.Vector3();
    this.labels.forEach((l, i) => {
      const el = els[i] as HTMLElement | undefined;
      if (!el) return;
      v.copy(l.pos).project(this.camera);
      const off = v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2;
      el.style.display = off ? "none" : "";
      el.style.left = `${((v.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - v.y) / 2) * h}px`;
    });
  }

  /* ---------- input ---------- */

  private bindEvents(): void {
    const el = this.container;
    const pointers = new Map<number, Point>();
    let drag: Drag | null = null;

    el.addEventListener(
      "wheel",
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        this.camAnim = null;
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        const dx = e.deltaX * unit;
        const dy = e.deltaY * unit;
        const notches = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
        const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && !!notches && notches % 120 === 0 && Math.abs(e.deltaY) >= 50);
        if (e.ctrlKey || mouseWheel) this.zoomAt(e.clientX, e.clientY, Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0025)));
        else this.pan(dx, dy);
      },
      { passive: false },
    );

    // Safari sends trackpad pinch as gesture events.
    let gestureBase = 1;
    el.addEventListener("gesturestart", (e) => {
      if (!this.active) return;
      e.preventDefault();
      gestureBase = this.view.dist;
    });
    el.addEventListener("gesturechange", (e) => {
      if (!this.active) return;
      e.preventDefault();
      const g = e as SafariGesture;
      const d = this.clampDist(gestureBase / g.scale);
      this.zoomAt(g.clientX, g.clientY, d / this.view.dist);
    });

    el.addEventListener("pointerdown", (e) => {
      if (!this.active || (e.target instanceof Element && e.target.closest(".room-label"))) return;
      this.camAnim = null;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone
      }
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
          if (id !== this.hover) {
            this.hover = id;
            this.hooks.onHover(id);
          }
          el.classList.toggle("over-room", !!id);
        }
        return;
      }
      if (drag.type === "pinch") {
        if (pointers.size < 2) return;
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

    const end = (e: PointerEvent) => {
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
      if (!drag && this.hover) {
        this.hover = 0;
        this.hooks.onHover(0);
      }
    });
    el.addEventListener("contextmenu", (e) => {
      if (this.active) e.preventDefault();
    });
    this.labelsEl.addEventListener("click", (e) => {
      const b = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-room]") : null;
      if (b) this.hooks.onRoomClick(Number(b.dataset.room));
    });
  }

  /** Zoom by a factor (<1 = closer), keeping the floor point under the pointer in place. */
  private zoomAt(clientX: number, clientY: number, factor: number): void {
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
