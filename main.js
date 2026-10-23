// Bbabbi Soul: low-res pixelated 3D world + an 8-direction 2D sprite character
// that picks its view from the angle between its facing and the camera.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Pass } from "three/addons/postprocessing/Pass.js";
// [progression] growth system; every hook below checks it exists, so deleting this line and
// progression.js removes it cleanly
import { progression } from "./progression.js";
import { SKILLS, SKILL_MIND_COST, SKILL_DAMAGE, SKILL_STAMINA } from "./skills.js";

const canvas = document.getElementById("view");
const dirLabel = document.getElementById("dir");

// ---------- renderer: draw at a fraction of the window size, upscale with nearest ----------
const PIXEL_SIZES = [2, 3, 4];   // 2 matches the 96px sprites about 1:1 at the default zoom
let pixelIdx = 0;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

function resize() {
  const px = PIXEL_SIZES[pixelIdx];
  const w = Math.ceil(innerWidth / px), h = Math.ceil(innerHeight / px);
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

const scene = new THREE.Scene();
scene.background = new THREE.Color("#9fd3e8");
scene.fog = new THREE.Fog("#9fd3e8", 28, 60);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
addEventListener("resize", resize);

// ---------- post: a light bloom over the whole frame ----------
// Runs at the same low resolution as the scene, so the glow is pixelated too.
// Sunlit ground, flowers and metal glow softly; shadowed areas stay crisp.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// ---------- Effekseer: authored particle effects (EffekseerForWebGL runtime in lib/) ----------
// Drawn into the scene's buffer before the bloom, so they glow and pixelate like everything else,
// and are depth-tested against the world. If the runtime or a file fails to load, the code-built
// effects further down are used instead.
const efk = { ctx: null, shockSlash: null, handles: [] };
const EFK_MAX = 6;                                     // simultaneous effect instances
const fxBytes = (url) => fetch(url).then((r) => r.arrayBuffer());
function initEffekseer() {
  if (typeof effekseer === "undefined") return console.warn("[fx] Effekseer runtime missing");
  effekseer.initRuntime("lib/effekseer.wasm", async () => {
    try {
      const ctx = effekseer.createContext();
      ctx.init(renderer.getContext());
      ctx.setRestorationOfStatesFlag(false);           // three.js state is reset after each draw instead
      const effect = ctx.loadEffect(await fxBytes("assets/fx/shock_slash.efkefc"), 1.0,
        () => { efk.ctx = ctx; efk.shockSlash = effect; },
        (m, url) => console.warn("[fx]", m, url),
        (path) => "assets/fx/" + path);                // textures sit next to the effect
    } catch (e) { console.warn("[fx] Effekseer unavailable", e); }
  }, () => console.warn("[fx] Effekseer runtime failed to load"));
}
function playFx(effect, p, rot, scale) {
  efk.handles = efk.handles.filter((h) => h.exists);
  if (efk.handles.length >= EFK_MAX) efk.handles.shift().stop();
  const h = efk.ctx.play(effect, p.x, p.y, p.z);
  h.setRotation(rot.x, rot.y, rot.z);
  h.setScale(scale, scale, scale);
  efk.handles.push(h);
  return h;
}
class EffekseerPass extends Pass {
  constructor() { super(); this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer) {
    if (!efk.ctx || wire) return;
    renderer.setRenderTarget(readBuffer);
    efk.ctx.setProjectionMatrix(camera.projectionMatrix.elements);
    efk.ctx.setCameraMatrix(camera.matrixWorldInverse.elements);
    efk.ctx.draw();
    renderer.resetState();
  }
}
composer.addPass(new EffekseerPass());

const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.5, 0.45);  // strength, radius, threshold
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- lighting ----------
const hemi = new THREE.HemisphereLight("#e8f4ff", "#5b6b3a", 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff1d6", 2.2);
sun.position.set(12, 20, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.0015;
scene.add(sun, sun.target);

// 3-step toon ramp: gives the flat, banded shading of a pixel-art 3D world
const ramp = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.needsUpdate = true;

// ---------- world ----------
const colliders = [];   // {x, z, r}
const props = [];       // meshes that may block the camera view
const worldMeshes = []; // every map mesh, for the wireframe toggle
const terrain = [];     // ground meshes (a multi-material node loads as a group of meshes)
let water = null;
let spawn = new THREE.Vector3();

async function loadWorld() {
  heightmap = await fetch("assets/heightmap.json").then((r) => r.json());
  const gltf = await new GLTFLoader().loadAsync("assets/map.glb");
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const wp = new THREE.Vector3(), ws = new THREE.Vector3();
  // glTF extras sit on the node; when a node has several materials, GLTFLoader turns it
  // into a Group whose child meshes carry no extras, so flags are looked up the parent chain
  const flag = (o, key) => { for (let p = o; p; p = p.parent) if (p.userData?.[key]) return true; return false; };
  root.traverse((o) => {
    const ud = o.userData || {};
    if (o.isMesh) {
      const walkable = flag(o, "walkable"), isWater = flag(o, "water");
      const src = o.material;
      o.material = new THREE.MeshToonMaterial({
        color: src.color, emissive: src.emissive, emissiveIntensity: src.emissiveIntensity ?? 1, gradientMap: ramp,
      });
      o.castShadow = !walkable && !isWater;
      o.receiveShadow = true;
      if (!walkable && !isWater) props.push(o);
      if (walkable) terrain.push(o);
      worldMeshes.push(o);
    }
    if (ud.water) {
      water = o;
      o.material = new THREE.MeshToonMaterial({ color: "#4fa3c7", gradientMap: ramp, transparent: true, opacity: 0.82 });
      o.castShadow = false;
    }
    if (ud.collider_radius) {
      o.getWorldPosition(wp);
      o.getWorldScale(ws);
      colliders.push({ x: wp.x, z: wp.z, r: ud.collider_radius * Math.max(ws.x, ws.z) });
    }
    if (o.name === "Spawn") o.getWorldPosition(spawn);
  });
  scene.add(root);
}

// Ground height comes from heightmap.json (build_map.py samples the terrain's own height function
// on a 1 m grid): a bilinear lookup instead of a raycast, cheap enough for a crowd of monsters.
let heightmap = null;
const groundNormal = new THREE.Vector3(0, 1, 0);   // surface normal under the last groundY() sample
function groundY(x, z) {
  if (!heightmap) return null;
  const { origin, step, n, h } = heightmap;
  const fx = (x - origin) / step, fy = (-z - origin) / step;    // the map's Blender y is three.js -z
  if (fx < 0 || fy < 0 || fx > n - 1 || fy > n - 1) return null; // off the map: callers keep their height
  const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fy));
  const u = fx - i, v = fy - j;
  const h00 = h[j * n + i], h10 = h[j * n + i + 1], h01 = h[(j + 1) * n + i], h11 = h[(j + 1) * n + i + 1];
  const dhx = ((h10 - h00) * (1 - v) + (h11 - h01) * v) / step;
  const dhy = ((h01 - h00) * (1 - u) + (h11 - h10) * u) / step;
  groundNormal.set(-dhx, 1, dhy).normalize();
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}

// ---------- 8-direction sprite character ----------
// Sectors clockwise from "facing the camera". Mirrored views reuse a generated view, flipped.
const SECTORS = [
  { view: "down", flip: false },
  { view: "down45", flip: false },
  { view: "side", flip: false },
  { view: "up45", flip: false },
  { view: "up", flip: false },
  { view: "up45", flip: true },
  { view: "side", flip: true },
  { view: "down45", flip: true },
];

class SpriteCharacter {
  constructor(atlas, texture, { blobRadius = 0.42 } = {}) {
    this.atlas = atlas;
    this.tex = texture;
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;

    // unit plane anchored at its bottom edge; each frame scales it to that motion's cell
    // size (attack frames are larger) at a fixed pixels-per-metre
    this.pixelWorld = atlas.pixelWorld ?? (atlas.worldHeight ?? 2.0) / atlas.cell[1];
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    this.mat = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, this.mat);
    // shadow from the sprite cut-out itself, plus a soft blob for grounding
    this.mesh.castShadow = true;
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: texture, alphaTest: 0.5 });
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(blobRadius, 12),
      new THREE.MeshBasicMaterial({ color: "#000", transparent: true, opacity: 0.25, depthWrite: false })
    );
    blob.position.y = 0.04;
    this.blob = blob;
    this.root = new THREE.Group();
    this.root.add(this.mesh, blob);
    // outline of the sprite's plane, shown in wireframe mode: the hero is one flat quad
    this.quadLines = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: "#ffd479" })
    );
    this.quadLines.visible = false;
    this.mesh.add(this.quadLines);

    this.facing = 0;      // yaw in radians, 0 = +Z
    this.state = "idle";
    this.time = 0;
    this.oneShot = null;  // {name, t} while a play-once motion (attack, shoot) runs
    this.shown = "";      // state on screen last frame
    this.frame = 0;       // frame index on screen (enemies time their shots off it)
    this.animRate = 1;    // scales looping motions (zombies shamble slowly)
    this.stateTime = 0;   // time since that state started (entry frames play from 0)
    this.sector = 0;
  }

  get attacking() { return this.oneShot !== null; }

  // play a motion once over whatever state is set, then hand back to it.
  // speed scales its frame rate (goblin wind-ups are slowed down so they can be read)
  playOnce(name, speed = 1) {
    if (this.oneShot) return;
    this.oneShot = { name, t: 0, speed };
    // `frame` is only recomputed in update(); until then it still holds the previous loop's frame,
    // and hit checks (frame >= hitFrame) in the same step would land the blow before the wind-up
    this.frame = 0;
  }

  update(dt, cam) {
    this.time += dt;
    if (this.oneShot) this.oneShot.t += dt * this.oneShot.speed;
    // cylindrical billboard: rotate around Y only, so the sprite stays upright
    const toCam = new THREE.Vector3().subVectors(cam.position, this.root.position).setY(0).normalize();
    this.mesh.rotation.y = Math.atan2(toCam.x, toCam.z);
    // stand the plane a little toward the camera so its bottom edge is not buried in a
    // slope rising in front of the feet
    this.mesh.position.x = toCam.x * 0.3;
    this.mesh.position.z = toCam.z * 0.3;

    // relative angle between facing and the camera decides which of the 8 views to show
    const f = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    const right = new THREE.Vector3().crossVectors(toCam.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();
    const theta = Math.atan2(f.dot(right), f.dot(toCam));
    this.sector = ((Math.round(theta / (Math.PI / 4)) % 8) + 8) % 8;
    // Blender atlases render all 8 views (dir0..dir7); sprite-gen atlases mirror 3 of them
    const { view, flip } = this.atlas.directions === 8
      ? { view: `dir${this.sector}`, flip: false }
      : SECTORS[this.sector];

    let state = this.state;
    let anim = this.oneShot && this.atlas.anims[`${view}_${this.oneShot.name}`];
    let fi;
    if (anim) {
      fi = Math.floor(this.oneShot.t * anim.fps);
      if (fi >= anim.frames.length) this.oneShot = null;
      else state = this.oneShot.name;
    } else {
      this.oneShot = null;
    }
    if (state !== this.shown) { this.shown = state; this.stateTime = 0; }
    this.stateTime += dt;
    if (!this.oneShot) {
      anim = this.atlas.anims[`${view}_${state}`] ?? this.atlas.anims[`${view}_idle`];
      // frames before loopFrom play once on entry (raising the guard), the rest loop
      const n = anim.frames.length, from = anim.loopFrom ?? 0;
      fi = Math.floor(this.stateTime * anim.fps * this.animRate);
      if (fi >= n) fi = from + ((fi - from) % (n - from));
    }
    this.frame = fi;
    const [fx, fy] = anim.frames[fi];
    const [cw, ch] = anim.cell ?? this.atlas.cell;
    const pad = anim.footPad ?? this.atlas.footPad ?? 0;
    this.mesh.scale.set(cw * this.pixelWorld, ch * this.pixelWorld, 1);
    this.mesh.position.y = -pad * ch * this.pixelWorld;
    const [W, H] = this.atlas.size;
    const u = fx / W, v = 1 - (fy + ch) / H, du = cw / W, dv = ch / H;
    this.tex.repeat.set(flip ? -du : du, dv);
    this.tex.offset.set(flip ? u + du : u, v);
    return `${view}${flip ? " (mirror)" : ""} · ${state}`;
  }
}

// ---------- timing ----------
// The game runs on a fixed 120 Hz step, apart from the screen's frame rate, and simNow is the
// moment (ms, performance.now() base, same as event.timeStamp) the current step stands for.
// Inputs keep their own timestamps, so a parry is judged against when the blow really lands.
const FIXED = 1 / 120;
let simNow = performance.now();

// ---------- sound: tiny synthesized cues (a glint ping before a blow, a clang on a parry) ----------
let actx = null;
function audio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = false; } }
  return actx || null;
}
addEventListener("pointerdown", () => audio()?.resume(), { once: true, capture: true });   // audio needs a gesture
addEventListener("keydown", () => audio()?.resume(), { once: true, capture: true });
function tone(freq, dur, gain, type = "sine", glideTo = null) {
  const a = audio();
  if (!a || a.state !== "running") return;
  const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur);
}
function glintSound() { tone(2600, 0.09, 0.035); }
function clangSound() { tone(1350, 0.35, 0.12, "triangle", 900); tone(2400, 0.25, 0.06, "square", 1900); tone(180, 0.12, 0.1, "sawtooth", 90); }

// ---------- input ----------
const keys = new Set();
addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "KeyG") setWire(!wire);
  if (e.code === "KeyK" && !e.repeat) H.guardPressAt = e.timeStamp;
  if (e.code === "KeyF" && !e.repeat) bufferAction("skill");
  if (/^Digit[1-9]$/.test(e.code)) selectSkill(+e.code.slice(5) - 1);
  if (e.code === "KeyP") { pixelIdx = (pixelIdx + 1) % PIXEL_SIZES.length; resize(); }
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) bufferAction("roll"); }
  if (e.code === "KeyJ" && !e.repeat) bufferAction("attack");
});
addEventListener("keyup", (e) => keys.delete(e.code));

const cam = { yaw: Math.PI * 0.25, pitch: 0.72, dist: 13 };
let dragging = false, lastX = 0, lastY = 0;
// mouse (the pointer stays visible): left button attacks, holding the right button guards.
// Resting the pointer near the left or right edge of the screen turns the camera that way
// (faster the closer it is); the middle button drags the camera; Q / E still turn it.
let mouseGuard = false;
const pointer = { x: 0, inside: false };
const EDGE = 0.1, EDGE_SPEED = 2.2;        // edge band as a share of the width, max turn (rad/s)
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });   // no autoscroll
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 0) bufferAction("attack");
  else if (e.button === 2) { mouseGuard = true; H.guardPressAt = e.timeStamp; }
  else if (e.button === 1) { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); }
});
addEventListener("pointerup", (e) => {
  if (e.button === 2) mouseGuard = false;
  if (e.button === 1) dragging = false;
});
addEventListener("blur", () => { mouseGuard = false; dragging = false; pointer.inside = false; keys.clear(); });
document.addEventListener("mouseleave", () => (pointer.inside = false));
function edgeTurn(dt) {
  if (!pointer.inside || dragging) return;
  const band = innerWidth * EDGE;
  if (pointer.x < band) cam.yaw += EDGE_SPEED * (1 - pointer.x / band) * dt;
  else if (pointer.x > innerWidth - band) cam.yaw -= EDGE_SPEED * (1 - (innerWidth - pointer.x) / band) * dt;
}
document.addEventListener("mousemove", (e) => {
  pointer.x = e.clientX;
  pointer.inside = e.target === canvas;     // not while over a button or the death screen
  if (!dragging) return;
  cam.yaw -= (e.clientX - lastX) * 0.008;
  cam.pitch = THREE.MathUtils.clamp(cam.pitch + (e.clientY - lastY) * 0.005, 0.2, 1.25);
  lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener("wheel", (e) => { cam.dist = THREE.MathUtils.clamp(cam.dist + e.deltaY * 0.01, 5, 22); }, { passive: true });

// ---------- fade props that sit between the camera and the hero ----------
const occRay = new THREE.Raycaster();
let faded = new Set();
function fadeOccluders(target) {
  const dir = target.clone().sub(camera.position);
  const len = dir.length();
  occRay.set(camera.position, dir.normalize());
  occRay.far = len - 0.6;
  const now = new Set();
  for (const hit of occRay.intersectObjects(props, false)) now.add(hit.object);
  for (const m of faded) if (!now.has(m)) { m.material.opacity = 1; m.material.transparent = false; m.material.depthWrite = true; }
  for (const m of now) { m.material.transparent = true; m.material.opacity = 0.3; m.material.depthWrite = false; }
  faded = now;
}

// ---------- goblins: hide in bushes, charge when the hero comes near, reset when he leaves ----------
const GOBLINS = {
  // detect: hero distance that wakes it      reach: weapon reach beyond the two bodies
  // hitFrame: attack frame where the blow lands      atkSpeed: attack playback rate (lower = longer wind-up)
  // poise: hits it takes before it staggers      barY: height of its health bar
  small: { detect: 7, speed: 4.4, radius: 0.25, blob: 0.22, bush: 0.8, reach: 0.45, cooldown: 1.1,
           hp: 120, dmg: 10, hitFrame: 3, atkSpeed: 0.6, poise: 1, barY: 1.25, barW: 0.6 },
  mid:   { detect: 12, speed: 3.2, radius: 0.35, blob: 0.38, bush: 1.1, reach: 0.6, cooldown: 2.4, meleeCooldown: 1.6,
           keepFar: 11, meleeSwitch: 3.5, releaseFrame: 4, arrowDmg: 12,
           hp: 180, dmg: 12, hitFrame: 3, atkSpeed: 0.6, poise: 1, barY: 2.0, barW: 0.8 },
  large: { detect: 8, speed: 2.4, radius: 0.60, blob: 0.62, bush: 1.6, reach: 0.9, cooldown: 2.4,
           hp: 450, dmg: 30, hitFrame: 4, atkSpeed: 0.45, poise: 2, barY: 3.15, barW: 1.2 },  // frame 4 = club hits the ground
  // zombies: no bush; they wander the infected zone in numbers, slow but many.
  // giveUp: hero this far away and they lose interest and wander where they are
  zombie: { detect: 9, speed: 1.9, radius: 0.32, blob: 0.36, bush: 0, reach: 0.5, cooldown: 1.5,
            hp: 100, dmg: 9, hitFrame: 3, atkSpeed: 0.6, poise: 1, barY: 2.0, barW: 0.8,
            wander: true, wanderSpeed: 0.6, giveUp: 20, animRate: 0.55 },
  // medusa: no melee. Holds the hero keepNear..keepFar away, lobs venom (VENOM / POISON below) and
  // every gazeCooldown s stares (PETRIFY): the hero must look away or roll when her eyes flare.
  medusa: { detect: 13, speed: 2.2, radius: 0.34, blob: 0.4, bush: 0, reach: 0.5, cooldown: 2.6,
            hp: 140, dmg: 0, hitFrame: 99, atkSpeed: 1, poise: 1, barY: 2.15, barW: 0.8,
            wander: true, wanderSpeed: 0.5, giveUp: 22,
            spitter: true, keepNear: 6, keepFar: 11, spitRange: 13, releaseFrame: 3,
            gazeRange: 8, gazeCooldown: 9, gazeSpeed: 0.67 },   // 8 m ≈ half the screen width at the default zoom
  // boss, the medusa queen: the medusa scaled up and gilded, waiting in her nest (ARENA) in the
  // infected zone. Fans of venom (volley), a venom burst round her when the hero closes in
  // (burst*: a red ring warns first), the stare. Below rageAt of her health she rages: more globs,
  // shorter waits. Leaves her nest only up to `arena` m; the hero leaving (`leash`) resets her.
  queen: { detect: 14, speed: 2.0, radius: 0.75, blob: 0.4, bush: 0, reach: 0.5, cooldown: 2.4,
           hp: 1400, dmg: 0, hitFrame: 99, atkSpeed: 1, poise: 8, barY: 2.15, barW: 0.8,
           boss: true, name: "메두사 여왕", scale: 1.8, tint: [1, 0.86, 0.55], reward: 20,
           arena: 9, leash: 26,
           spitter: true, keepNear: 5, keepFar: 9, spitRange: 14, releaseFrame: 3,
           volley: 3, rageVolley: 5, volleySpread: 1.7,
           gazeRange: 10, gazeCooldown: 10, gazeSpeed: 0.67,
           burstRange: 3.6, burstRadius: 3.8, burstDmg: 22, burstCooldown: 5, burstSpeed: 0.45,
           rageAt: 0.5, rageSpeed: 0.7, rageText: "여왕이 분노한다" },
};
for (const k of ["small", "mid", "large"]) GOBLINS[k].atlas = `goblin_${k}`;
GOBLINS.zombie.atlas = "zombie";
GOBLINS.medusa.atlas = "medusa";
GOBLINS.queen.atlas = "medusa";
const ZOMBIE_COUNT = 90;
const MEDUSA_COUNT = 5;
const ARENA = { want: new THREE.Vector2(34, -34), pos: null, clear: 14 };   // the queen's nest (found at load)
let queen = null;
const CULL = 46;           // monsters farther than this from the hero are hidden and skipped
// wanted hideouts (x, z); each is moved to the nearest free, dry, off-path spot at load
const HIDEOUTS = [
  ["small", -6, 14], ["small", -7.5, 15.5], ["mid", 13, -9], ["large", -15, -10],
  ["small", 16, 15], ["small", 17.5, 13], ["mid", -17, 6], ["large", 13, -16],
  ["mid", 4, -17], ["small", -14, -16], ["large", -4, 18],
];
const LEASH = 30;          // hero this far from the hideout: the goblin (alive or dead) hides there again
const HERO_RADIUS = 0.35;
const enemies = [];
const arrows = [];
const bushMats = [
  new THREE.MeshToonMaterial({ color: "#3f8a3a", gradientMap: ramp }),
  new THREE.MeshToonMaterial({ color: "#4f9a44", gradientMap: ramp }),
];

function pathX(z) { return Math.sin(-z * 0.12) * 5; }     // dirt path centre (build_map.py, in three.js axes)

function freeSpot(x, z, r, taken) {
  const ok = (px, pz) => Math.abs(px) < 19 && Math.abs(pz) < 19 && Math.abs(px - pathX(pz)) > 2.6 &&
    colliders.every((c) => Math.hypot(px - c.x, pz - c.z) > c.r + r + 0.8) &&
    taken.every((t) => Math.hypot(px - t.x, pz - t.z) > t.r + r + 0.6) &&      // bushes stay apart
    (groundY(px, pz) ?? 99) < 2.2;                          // not up on the rim
  for (let ring = 0; ring < 12; ring++)
    for (let a = 0; a < 12; a++) {
      const px = x + Math.cos(a * Math.PI / 6) * ring * 0.8, pz = z + Math.sin(a * Math.PI / 6) * ring * 0.8;
      if (ok(px, pz)) return [px, pz];
    }
  return [x, z];
}

function makeBush(size) {
  const g = new THREE.Group();
  const blobs = [[0, 0.45, 0, 0.62], [0.45, 0.35, 0.15, 0.48], [-0.4, 0.32, -0.1, 0.5], [0.05, 0.3, -0.42, 0.45], [-0.1, 0.72, 0.1, 0.42]];
  blobs.forEach(([x, y, z, r], i) => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), bushMats[i % 2]);
    m.position.set(x, y, z);
    m.rotation.set(i, i * 2, 0);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    props.push(m);
    worldMeshes.push(m);
  });
  g.scale.setScalar(size);
  return g;
}

// small health bar over a goblin's head, shown once it has been hurt
function makeHealthBar(width) {
  const g = new THREE.Group();
  const mk = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.04, 0.1), mk("#14161c"));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.06).translate(0.5, 0, 0), mk("#c8473f"));
  fill.position.set(-width / 2, 0, 0.001);
  back.renderOrder = fill.renderOrder = 20;
  g.add(back, fill);
  g.userData = { fill, width };
  g.visible = false;
  return g;
}

function facingVec(yaw) { return new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)); }

class Goblin {
  constructor(kind, atlas, tex, x, z) {
    this.kind = kind;
    this.cfg = GOBLINS[kind];
    this.sprite = new SpriteCharacter(atlas, tex, { blobRadius: this.cfg.blob });
    this.sprite.animRate = this.cfg.animRate ?? 1;
    if (this.cfg.scale) this.sprite.root.scale.setScalar(this.cfg.scale);
    this.home = new THREE.Vector3(x, groundY(x, z) ?? 0, z);
    this.bush = this.cfg.bush ? makeBush(this.cfg.bush) : null;
    if (this.bush) { this.bush.position.copy(this.home); scene.add(this.bush); }
    this.bar = makeHealthBar(this.cfg.barW);
    this.bar.position.y = this.cfg.barY;
    this.sprite.root.add(this.bar);
    scene.add(this.sprite.root);
    this.shake = 0;
    this.knock = new THREE.Vector3();                     // knockback velocity, decays
    this.hide();
  }

  get alive() { return this.state === "hunt"; }

  // knocked off balance by a parry: groggy (frozen, flashing red), and the next hit on it is a critical
  parried() {
    this.stagger = PARRY.stagger;
    this.sprite.oneShot = null;
    this.riposteUntil = simNow + PARRY.stagger * 1000;
  }

  // back in the bush (zombies: back at their spot, wandering) at full health; also the respawn
  hide() {
    this.state = this.cfg.wander ? "wander" : "hidden";
    this.anchor = this.home.clone();
    this.wanderTo = null;
    this.wanderWait = Math.random() * 2;
    this.hp = this.cfg.hp;
    this.hits = 0;
    this.stagger = 0;
    this.flash = 0;
    this.cooldown = 0;
    this.knock.set(0, 0, 0);
    this.riposteUntil = 0;
    this.gazeCd = (this.cfg.gazeCooldown ?? 0) * 0.5;      // medusa: first stare comes sooner
    this.gazing = false;
    this.bursting = false;
    this.burstCd = 0;
    this.raged = false;
    const s = this.sprite;
    s.root.visible = !!this.cfg.wander || !!this.cfg.boss;  // the boss waits in plain sight in her nest
    s.root.position.copy(this.home);
    s.oneShot = null;
    s.mat.opacity = 1;
    s.mat.transparent = false;
    s.mat.color.setRGB(...(this.cfg.tint ?? [1, 1, 1]));
    this.bar.visible = false;
  }

  emerge(hero) {
    this.state = "hunt";
    this.sprite.root.visible = true;
    this.shake = 0.6;
    // step out of the bush on the hero's side
    const d = hero.clone().sub(this.home).setY(0).normalize();
    this.sprite.root.position.copy(this.home).addScaledVector(d, this.cfg.bush * 0.7);
    this.sprite.facing = Math.atan2(d.x, d.z);
    this.cooldown = 0.6;
  }

  // knock: launch speed of a knockback (shockwave); big goblins move less
  takeHit(dmg, from, knock = 0) {
    if (!this.alive) return;
    this.hp -= dmg;
    this.hits++;
    this.flash = 0.15;
    const p = this.sprite.root.position;
    const away = p.clone().sub(from).setY(0).normalize();
    const heavy = this.kind === "large" || this.cfg.boss;
    p.addScaledVector(away, heavy ? 0.12 : 0.35);
    if (knock) {
      this.knock.copy(away).multiplyScalar(knock * (this.cfg.boss ? 0.15 : heavy ? 0.4 : 1));
      if (!this.cfg.boss) {                                 // the boss shrugs a shockwave off
        this.stagger = Math.max(this.stagger, 0.7);
        this.sprite.oneShot = null;
      }
    }
    if (this.hits % this.cfg.poise === 0) {                 // poise broken: the attack is cancelled
      this.stagger = heavy ? 0.6 : 0.45;
      this.sprite.oneShot = null;
    }
    this.bar.visible = !this.cfg.boss;                     // the boss has the big bar at the bottom
    if (this.hp <= 0) {
      if (typeof progression !== "undefined") progression.onKill(this.kind);   // [progression] points
      if (this.cfg.boss) bossDefeated(this);
      this.state = "dead";
      this.deadT = 0;
      this.sprite.oneShot = null;
      this.sprite.state = "idle";
      this.sprite.mat.transparent = true;
      this.bar.visible = false;
    }
  }

  // a slow aimless shuffle around its anchor, pausing now and then
  wander(dt) {
    const s = this.sprite, p = s.root.position;
    if (this.wanderWait > 0) { this.wanderWait -= dt; s.state = "idle"; return; }
    if (!this.wanderTo || p.distanceTo(this.wanderTo) < 0.3) {
      const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 3.5;
      this.wanderTo = this.anchor.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      this.wanderWait = 1 + Math.random() * 2.5;
      return;
    }
    const to = this.wanderTo.clone().sub(p).setY(0).normalize();
    p.addScaledVector(to, this.cfg.wanderSpeed * dt);
    let df = Math.atan2(to.x, to.z) - s.facing;
    df = Math.atan2(Math.sin(df), Math.cos(df));
    s.facing += df * Math.min(1, dt * 4);
    s.state = "run";
  }

  // medusa, between motions: stare when ready, else spit when ready, else keep keepNear..keepFar away.
  // returns the move (+1 toward the hero, -1 away, 0 hold)
  spitterTurn(dt, dist) {
    const cfg = this.cfg, s = this.sprite;
    // boss: rage below rageAt of her health (more globs, shorter waits)
    if (cfg.rageAt && !this.raged && this.hp < cfg.hp * cfg.rageAt) {
      this.raged = true;
      showToast(cfg.rageText, "rage");
      tone(90, 0.8, 0.09, "sawtooth", 60);
    }
    const wait = this.raged ? cfg.rageSpeed : 1;
    this.gazeCd -= dt;
    this.burstCd -= dt;
    // boss, hero too close: a venom burst all round her, warned by a red ring on the ground
    if (cfg.burstRange && this.burstCd <= 0 && dist < cfg.burstRange) {
      s.playOnce("spit", cfg.burstSpeed);
      this.bursting = true;
      this.spat = false;
      this.burstCd = cfg.burstCooldown * wait;
      burstWarnFx(this);
      return 0;
    }
    if (this.gazeCd <= 0 && dist < cfg.gazeRange) {
      s.playOnce("gaze", cfg.gazeSpeed);
      this.gazeCd = cfg.gazeCooldown * wait;
      this.gazing = true;
      gazeFx(this);
      return 0;
    }
    if (this.cooldown <= 0 && dist < cfg.spitRange) {
      s.playOnce("spit");
      this.cooldown = cfg.cooldown * wait;
      this.spat = false;
      return 0;
    }
    return dist < cfg.keepNear ? -1 : dist > cfg.keepFar ? 1 : 0;
  }

  // pushed out of props, kept on the map and on the ground
  settle(dt) {
    const s = this.sprite, p = s.root.position;
    pushOut(p, this.cfg.radius);
    p.x = THREE.MathUtils.clamp(p.x, -LIMIT, LIMIT);
    p.z = THREE.MathUtils.clamp(p.z, -LIMIT, LIMIT);
    const gy = groundY(p.x, p.z);
    if (gy !== null) p.y = THREE.MathUtils.lerp(p.y, gy, Math.min(1, dt * 20));
    s.blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), groundNormal);
  }

  update(dt, heroPos) {
    if (this.shake > 0 && this.bush) {                      // bush rustles when it bursts out
      this.shake -= dt;
      this.bush.rotation.z = Math.sin(this.shake * 40) * 0.12 * Math.max(0, this.shake / 0.6);
    }
    const s = this.sprite, p = s.root.position, cfg = this.cfg;
    if (this.state === "hidden") {
      if (!H.dead && heroPos.distanceTo(this.home) < cfg.detect) this.emerge(heroPos);
      return;
    }
    if (this.state === "wander") {
      const far = heroPos.distanceTo(p) > CULL;
      s.root.visible = !far;                                // a far-off crowd costs nothing
      if (far) return;
      if (!H.dead && heroPos.distanceTo(p) < cfg.detect) {
        this.state = "hunt";
        this.cooldown = 0.5;
      } else {
        this.wander(dt);
        this.settle(dt);
        return;
      }
    }
    // hero gone far away: back into hiding (a dead goblin respawns this way). The boss resets to
    // full health when the hero leaves her nest, but once beaten she stays gone.
    if (cfg.boss) {
      if (this.state !== "dead" && heroPos.distanceTo(this.home) > cfg.leash) { this.hide(); return; }
    } else if (heroPos.distanceTo(this.home) > LEASH && heroPos.distanceTo(p) > 22) { this.hide(); return; }
    if (this.state === "dead") {                            // fade out and sink, then stay gone
      this.deadT += dt;
      s.mat.opacity = Math.max(0, 1 - this.deadT / 0.8);
      p.y -= dt * 0.4;
      if (this.deadT > 0.8) s.root.visible = false;
      return;
    }

    this.flash -= dt;
    if (this.flash > 0) s.mat.color.setRGB(1, 0.45, 0.45);
    else if (this.riposteUntil > simNow) {                  // groggy after a parry: pulsing red, ~6 blinks a second
      const k = 0.5 + 0.5 * Math.sin(simNow * 0.04);
      s.mat.color.setRGB(1, 0.25 + 0.55 * k, 0.25 + 0.55 * k);
    } else s.mat.color.setRGB(...(cfg.tint ?? [1, 1, 1]));
    if (this.riposteUntil > simNow) this.knock.set(0, 0, 0);   // groggy: rooted to the spot
    if (this.knock.lengthSq() > 1e-4) {                     // thrown back by a shockwave
      p.addScaledVector(this.knock, dt);
      this.knock.multiplyScalar(Math.max(0, 1 - dt * 5));
    }
    this.bar.userData.fill.scale.x = Math.max(0, this.hp / cfg.hp) * this.bar.userData.width;

    const to = heroPos.clone().sub(p).setY(0);
    const dist = to.length();
    to.normalize();
    this.cooldown -= dt;
    let move = 0;
    if (cfg.giveUp && dist > cfg.giveUp && !s.attacking) {   // lost the hero: wander where it stands
      this.state = "wander";
      this.anchor = p.clone();
      this.wanderTo = null;
      this.bar.visible = false;
      return;
    }

    if (this.stagger > 0) {
      this.stagger -= dt;
      this.gazing = false;                                  // a hit breaks the medusa's stare
      this.bursting = false;
    } else if (!H.dead) {
      // turn to face the hero, but commit once the blow is on its way
      const committed = s.oneShot && s.frame >= cfg.hitFrame - 1;
      if (!committed) {
        let df = Math.atan2(to.x, to.z) - s.facing;
        df = Math.atan2(Math.sin(df), Math.cos(df));
        s.facing += df * Math.min(1, dt * 8);
      }
      const bodies = cfg.reach + cfg.radius + HERO_RADIUS;
      if (cfg.spitter) {
        if (!s.attacking) move = this.spitterTurn(dt, dist);
      } else if (!s.attacking) {
        const melee = this.kind !== "mid" || dist < cfg.meleeSwitch;   // the archer fights hand to hand up close
        if (melee) {
          if (dist > bodies) move = 1;
          else if (this.cooldown <= 0) {
            s.playOnce("attack", cfg.atkSpeed);
            this.cooldown = this.kind === "mid" ? cfg.meleeCooldown : cfg.cooldown;
            this.struck = false;
            // the blow lands hitFrame frames in; the weapon glints GLINT_LEAD before that
            const fps = s.atlas.anims.dir0_attack.fps * cfg.atkSpeed;
            this.glintAt = cfg.hitFrame / fps - GLINT_LEAD;
            this.glinted = false;
          }
        } else if (dist > cfg.keepFar) {
          move = 1;
        } else if (this.cooldown <= 0) {
          s.playOnce("shoot");
          this.cooldown = cfg.cooldown;
          this.loosed = false;
        }
      }
      // oneShot.t runs at the playback rate; divide it back out to compare in real seconds
      if (s.oneShot?.name === "attack" && !this.glinted && s.oneShot.t / cfg.atkSpeed >= this.glintAt) {
        this.glinted = true;
        glintFx(this);
      }
      // melee blow lands on its hit frame: hero in reach and in front of the goblin
      if (s.oneShot?.name === "attack" && s.frame >= cfg.hitFrame && !this.struck) {
        this.struck = true;
        if (dist <= bodies + 0.35 && facingVec(s.facing).dot(to) > 0.35) {
          if (damageHero(cfg.dmg, p) === "parried") this.parried();
        }
      }
      // the archer lets go on the release frame of its draw
      if (s.oneShot?.name === "shoot" && s.frame >= cfg.releaseFrame && !this.loosed) {
        this.loosed = true;
        fireArrow(p, heroPos, s.facing, cfg.arrowDmg);
      }
      // medusa: the glob leaves on the lunge frame; the stare lands when the gaze motion ends
      if (s.oneShot?.name === "spit" && s.frame >= cfg.releaseFrame && !this.spat) {
        this.spat = true;
        if (this.bursting) { this.bursting = false; venomBurst(this); }
        else spitVolley(this, heroPos);
      }
      if (this.gazing && s.oneShot?.name !== "gaze") {
        this.gazing = false;
        gazeLands(this);
      }
    }
    if (move) {
      p.addScaledVector(to, move * cfg.speed * dt);
      if (cfg.arena) {                                      // the boss keeps to her nest
        const off = new THREE.Vector3(p.x - this.home.x, 0, p.z - this.home.z);
        if (off.length() > cfg.arena) { off.setLength(cfg.arena); p.x = this.home.x + off.x; p.z = this.home.z + off.z; }
      }
      s.state = "run";
    } else {
      s.state = "idle";
    }
    this.settle(dt);
  }
}

function pushOut(p, r) {
  for (const c of colliders) {
    const dx = p.x - c.x, dz = p.z - c.z, rr = c.r + r;
    const d2 = dx * dx + dz * dz;
    if (d2 < rr * rr && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      p.x = c.x + (dx / d) * rr;
      p.z = c.z + (dz / d) * rr;
    }
  }
}

const arrowMat = new THREE.MeshToonMaterial({ color: "#7a5530", gradientMap: ramp });
const arrowGeo = new THREE.BoxGeometry(0.035, 0.035, 0.75);
function fireArrow(from, target, facing, dmg) {
  const m = new THREE.Mesh(arrowGeo, arrowMat);
  m.castShadow = true;
  const start = from.clone().add(new THREE.Vector3(Math.sin(facing) * 0.5, 1.15, Math.cos(facing) * 0.5));
  const aim = target.clone().add(new THREE.Vector3(0, 1.0, 0));
  const dist = aim.distanceTo(start);
  const v = aim.sub(start).normalize().multiplyScalar(17);
  v.y += 0.5 * 4 * (dist / 17);                             // lob a little against gravity (4 m/s^2)
  m.position.copy(start);
  scene.add(m);
  arrows.push({ m, v, age: 0, stuck: false, from: start.clone(), dmg, passed: false });
}

function updateArrows(dt) {
  const hp = hero.root.position;
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.age += dt;
    if (!a.stuck) {
      a.v.y -= 4 * dt;
      a.m.position.addScaledVector(a.v, dt);
      a.m.lookAt(a.m.position.clone().add(a.v));
      // does it pass through the hero's body (a 1.6 m tall column)?
      const q = a.m.position;
      if (!a.passed && Math.hypot(q.x - hp.x, q.z - hp.z) < 0.45 && q.y > hp.y + 0.1 && q.y < hp.y + 1.7) {
        const r = damageHero(a.dmg, a.from);
        if (r === "dodged") a.passed = true;               // rolled through it: it flies on
        else if (r === "parried") sparkFx(q);              // knocked out of the air
        else { scene.remove(a.m); arrows.splice(i, 1); continue; }
      }
      const gy = groundY(q.x, q.z);
      if (gy !== null && q.y <= gy + 0.05) { a.stuck = true; a.age = 0; }   // sticks in the ground
      else if (a.age > 3) a.age = 99;
    }
    if ((a.stuck && a.age > 4) || a.age > 90) { scene.remove(a.m); arrows.splice(i, 1); }
  }
}

// ---------- medusa: venom globs, poison puddles, poison stacks and the petrifying stare ----------
// A glob is lobbed at where the hero stands, with a ring marking the landing spot. A direct hit
// (or a block) adds a poison stack; it always leaves a puddle that adds a stack per second stood in.
// POISON.max stacks: poisoned for POISON.time s at POISON.dps. Stacks fade one per POISON.decay s.
const VENOM = { gravity: 14, flight: 0.75, hitRadius: 0.9, dmg: 4, puddleRadius: 1.0, puddleTime: 2.6, puddleTick: 1.0 };
const POISON = { max: 5, decay: 3, time: 10, dps: 2 };
// the stare: when the gaze motion ends, a hero within gazeRange facing her (inside ±60°) is slowed
const PETRIFY = { time: 2.0, slow: 0.35, facing: Math.cos(THREE.MathUtils.degToRad(60)) };
const venomGeo = new THREE.IcosahedronGeometry(0.14, 0);
const venomMat = new THREE.MeshBasicMaterial({ color: "#8dff4a" });
const globs = [], puddles = [];

function spitVenom(m, target) {
  const s = m.sprite;
  const k = m.cfg.scale ?? 1;
  const from = s.root.position.clone().addScaledVector(facingVec(s.facing), 0.3 * k).add(new THREE.Vector3(0, 1.55 * k, 0));
  const at = target.clone();
  at.y = groundY(at.x, at.z) ?? at.y;
  const T = VENOM.flight + Math.hypot(at.x - from.x, at.z - from.z) * 0.02;   // farther: a little longer in the air
  const v = new THREE.Vector3((at.x - from.x) / T, (at.y - from.y + 0.5 * VENOM.gravity * T * T) / T, (at.z - from.z) / T);
  const glob = new THREE.Mesh(venomGeo, venomMat);
  glob.position.copy(from);
  const mark = new THREE.Mesh(new THREE.RingGeometry(VENOM.hitRadius * 0.8, VENOM.hitRadius, 32), fxMaterial("#9dff6a"));
  mark.rotation.x = -Math.PI / 2;
  mark.position.copy(at).add(new THREE.Vector3(0, 0.06, 0));
  scene.add(glob, mark);
  globs.push({ glob, mark, v, t: 0, T, at, src: m });
  tone(320, 0.12, 0.04, "sawtooth", 180);
}

// one glob, or for the boss a fan of them spread across the line to the hero
function spitVolley(m, target) {
  const cfg = m.cfg;
  const n = cfg.volley ? (m.raged ? cfg.rageVolley : cfg.volley) : 1;
  const p = m.sprite.root.position;
  const side = new THREE.Vector3(target.z - p.z, 0, p.x - target.x).normalize();   // across the line of fire
  for (let i = 0; i < n; i++) spitVenom(m, target.clone().addScaledVector(side, (i - (n - 1) / 2) * (cfg.volleySpread ?? 0)));
}

// boss: a red ring round her for the wind-up, then the venom bursts out to that ring
function burstWarnFx(m) {
  const cfg = m.cfg, s = m.sprite;
  const a = s.atlas.anims.dir0_spit;
  const dur = cfg.releaseFrame / (a.fps * cfg.burstSpeed);
  const ring = new THREE.Mesh(new THREE.RingGeometry(cfg.burstRadius - 0.25, cfg.burstRadius, 48), fxMaterial("#ff5a4a"));
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(s.root.position).add(new THREE.Vector3(0, 0.07, 0));
  addEffect(ring, dur, (o, k) => {
    o.position.copy(s.root.position).add(new THREE.Vector3(0, 0.07, 0));
    o.material.opacity = 0.35 + 0.6 * Math.abs(Math.sin(k * 14));
  });
  tone(240, dur, 0.05, "square", 120);
}
function venomBurst(m) {
  const cfg = m.cfg, q = m.sprite.root.position, hp = hero.root.position;
  const wave = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 48), fxMaterial("#9dff6a"));
  wave.rotation.x = -Math.PI / 2;
  wave.position.copy(q).add(new THREE.Vector3(0, 0.1, 0));
  addEffect(wave, 0.35, (o, k) => { o.scale.setScalar(0.5 + k * cfg.burstRadius); o.material.opacity = 0.95 * (1 - k); });
  H.shake = Math.max(H.shake, 0.15);
  if (Math.hypot(hp.x - q.x, hp.z - q.z) < cfg.burstRadius + HERO_RADIUS) {
    const r = damageHero(cfg.burstDmg, q);
    if (r === "hit" || r === "blocked") addPoison();
  }
}

function bossDefeated(m) {
  if (typeof progression !== "undefined") progression.onBossKill(m.cfg.reward);   // [progression]
  const deaths = typeof progression !== "undefined" ? progression.data.deaths : 0;
  showVictory(`${m.cfg.name} 처치`, `포인트 +${m.cfg.reward} 확보 · 누적 사망 ${deaths}회`);
  tone(523, 0.3, 0.08, "triangle", 784);
  setTimeout(() => tone(659, 0.5, 0.08, "triangle", 1046), 260);
}

function makePuddle(at) {
  const mat = new THREE.MeshBasicMaterial({ color: "#6fd13a", transparent: true, opacity: 0, depthWrite: false });
  const m = new THREE.Mesh(new THREE.CircleGeometry(VENOM.puddleRadius, 24), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.copy(at).add(new THREE.Vector3(0, 0.04, 0));
  scene.add(m);
  puddles.push({ m, t: 0, tick: 0.4 });
}

function updateVenom(dt) {
  const hp = hero.root.position;
  for (let i = globs.length - 1; i >= 0; i--) {
    const g = globs[i];
    g.t += dt;
    g.v.y -= VENOM.gravity * dt;
    g.glob.position.addScaledVector(g.v, dt);
    g.mark.material.opacity = 0.35 + 0.55 * Math.abs(Math.sin(g.t * 10));
    if (g.t < g.T) continue;
    scene.remove(g.glob, g.mark);
    g.mark.geometry.dispose();
    g.mark.material.dispose();
    globs.splice(i, 1);
    if (Math.hypot(hp.x - g.at.x, hp.z - g.at.z) < VENOM.hitRadius) {
      const r = damageHero(VENOM.dmg, g.src.sprite.root.position);
      if (r === "hit" || r === "blocked") addPoison();                       // a guard stops the hurt, not the venom
      else if (r === "parried" && g.src.alive) g.src.takeHit(COMBAT.heroDmg, hp);   // flicked back at her
    }
    makePuddle(g.at);
  }
  for (let i = puddles.length - 1; i >= 0; i--) {
    const pd = puddles[i];
    pd.t += dt;
    const left = VENOM.puddleTime - pd.t;
    pd.m.material.opacity = 0.5 * Math.min(1, pd.t / 0.15, left / 0.5);
    pd.m.scale.setScalar(1 + 0.04 * Math.sin(pd.t * 9));                      // a slow bubbling
    if (Math.hypot(hp.x - pd.m.position.x, hp.z - pd.m.position.z) < VENOM.puddleRadius) {
      pd.tick -= dt;
      if (pd.tick <= 0) { pd.tick = VENOM.puddleTick; addPoison(); }
    } else pd.tick = 0.4;
    if (left <= 0) {
      scene.remove(pd.m);
      pd.m.geometry.dispose();
      pd.m.material.dispose();
      puddles.splice(i, 1);
    }
  }
}

function addPoison() {
  if (H.dead || H.poisonT > 0) return;                    // already poisoned: stacks wait until it wears off
  H.poisonStacks++;
  H.poisonDecay = POISON.decay;
  if (H.poisonStacks >= POISON.max) {
    H.poisonStacks = 0;
    H.poisonT = POISON.time;
    H.poisonTick = 1;
    tone(150, 0.4, 0.07, "sawtooth", 90);
  }
}

function updatePoison(dt) {
  if (H.dead) return;
  if (H.poisonT > 0) {
    H.poisonT -= dt;
    H.poisonTick -= dt;
    if (H.poisonTick <= 0) {
      H.poisonTick += 1;
      H.hp -= POISON.dps * COMBAT.damageTaken;
      H.lagWait = 0.6;
      if (H.hp <= 0) killHero();
    }
  } else if (H.poisonStacks > 0) {
    H.poisonDecay -= dt;
    if (H.poisonDecay <= 0) { H.poisonStacks--; H.poisonDecay = POISON.decay; }
  }
  if (H.petrifyT > 0) H.petrifyT -= dt;
}

// her eyes flare for the whole wind-up of the stare
function gazeFx(m) {
  const s = m.sprite;
  const dur = s.atlas.anims.dir0_gaze.frames.length / (s.atlas.anims.dir0_gaze.fps * m.cfg.gazeSpeed);
  const size = m.cfg.scale ?? 1;
  const star = starMesh(0.8 * size, "#f6ec5a");
  addEffect(star, dur, (o, k) => {
    o.position.copy(s.root.position).add(new THREE.Vector3(0, 1.72 * size, 0)).addScaledVector(facingVec(s.facing), 0.12 * size);
    o.quaternion.copy(camera.quaternion);
    o.rotateZ(k * 3);
    o.scale.setScalar(0.4 + k * 1.1 + 0.15 * Math.sin(k * 40));
    o.material.opacity = 0.6 + 0.4 * k;
  });
  if (s.root.position.distanceTo(hero.root.position) < 16) tone(880, 0.5, 0.05, "triangle", 1320);
}

function gazeLands(m) {
  if (H.dead || !m.alive) return;
  const hp = hero.root.position, q = m.sprite.root.position;
  const to = new THREE.Vector3(q.x - hp.x, 0, q.z - hp.z);
  const d = to.length();
  if (d > m.cfg.gazeRange) return;
  if (H.roll && H.roll.t >= COMBAT.iFrom && H.roll.t <= COMBAT.iTo) return;       // rolled through it
  if (facingVec(hero.facing).dot(to.divideScalar(d)) < PETRIFY.facing) return;    // looked away
  H.petrifyT = PETRIFY.time;
  tone(110, 0.5, 0.08, "square", 70);
}

function updateEnemies(dt, heroPos) {
  for (const g of enemies) {
    g.update(dt, heroPos);
    if (!g.alive) continue;
    // goblins do not walk through the hero: keep them at body distance
    const p = g.sprite.root.position;
    const dx = p.x - heroPos.x, dz = p.z - heroPos.z, rr = g.cfg.radius + HERO_RADIUS;
    const d = Math.hypot(dx, dz);
    if (d < rr && d > 1e-4) { p.x = heroPos.x + dx / d * rr; p.z = heroPos.z + dz / d * rr; }
    g.bar.quaternion.copy(camera.quaternion);
  }
  // keep awake goblins from stacking on each other
  for (let i = 0; i < enemies.length; i++)
    for (let j = i + 1; j < enemies.length; j++) {
      const a = enemies[i], b = enemies[j];
      if (!a.alive || !b.alive) continue;
      const pa = a.sprite.root.position, pb = b.sprite.root.position;
      const dx = pb.x - pa.x, dz = pb.z - pa.z, rr = a.cfg.radius + b.cfg.radius;
      const d = Math.hypot(dx, dz);
      if (d < rr && d > 1e-4) {
        const k = (rr - d) / 2 / d;
        pa.x -= dx * k; pa.z -= dz * k; pb.x += dx * k; pb.z += dz * k;
      }
    }
  updateArrows(dt);
  updateVenom(dt);
}

async function loadEnemies() {
  const kinds = Object.keys(GOBLINS);
  const assets = await Promise.all(kinds.map(async (k) => {
    const atlas = await fetch(`assets/${GOBLINS[k].atlas}.json`).then((r) => r.json());
    const tex = await new THREE.TextureLoader().loadAsync(`assets/${atlas.image}`);
    return [k, { atlas, tex }];
  }));
  const byKind = Object.fromEntries(assets);
  const taken = [];
  for (const [kind, x, z] of HIDEOUTS) {
    const [fx, fz] = freeSpot(x, z, GOBLINS[kind].bush, taken);
    taken.push({ x: fx, z: fz, r: GOBLINS[kind].bush });
    // each goblin gets its own texture object (same image) so frame offsets do not clash
    const tex = byKind[kind].tex.clone();
    tex.needsUpdate = true;
    enemies.push(new Goblin(kind, byKind[kind].atlas, tex, fx, fz));
  }
  // the queen's nest: the open, level spot in the infected zone nearest ARENA.want
  ARENA.pos = findArena();
  const inNest = (x, z) => Math.hypot(x - ARENA.pos.x, z - ARENA.pos.y) < ARENA.clear;   // kept clear of the crowd
  // zombies: scattered over the infected ring (fixed seed, so the same layout every game)
  let seed = 5;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const spots = [];
  for (let t = 0; t < 6000 && spots.length < ZOMBIE_COUNT; t++) {
    const x = (rand() * 2 - 1) * 42, z = (rand() * 2 - 1) * 42;
    const r = Math.max(Math.abs(x), Math.abs(z));
    if (r < 27.5 || r > 42.5 || groundY(x, z) === null || inNest(x, z)) continue;
    if (!colliders.every((c) => Math.hypot(x - c.x, z - c.z) > c.r + 0.7)) continue;
    if (!spots.every((q) => Math.hypot(x - q[0], z - q[1]) > 1.6)) continue;
    spots.push([x, z]);
  }
  for (const [x, z] of spots) {
    const tex = byKind.zombie.tex.clone();
    tex.needsUpdate = true;
    enemies.push(new Goblin("zombie", byKind.zombie.atlas, tex, x, z));
  }
  // medusas: a few spitters among the zombies, spread round the ring (own seed: the zombie layout stays)
  seed = 11;
  const mspots = [];
  for (let t = 0; t < 4000 && mspots.length < MEDUSA_COUNT; t++) {
    const x = (rand() * 2 - 1) * 40, z = (rand() * 2 - 1) * 40;
    const r = Math.max(Math.abs(x), Math.abs(z));
    if (r < 30 || r > 40 || groundY(x, z) === null || inNest(x, z)) continue;
    if (!colliders.every((c) => Math.hypot(x - c.x, z - c.z) > c.r + 0.8)) continue;
    if (!mspots.every((q) => Math.hypot(x - q[0], z - q[1]) > 14)) continue;
    mspots.push([x, z]);
  }
  for (const [x, z] of mspots) {
    const tex = byKind.medusa.tex.clone();
    tex.needsUpdate = true;
    enemies.push(new Goblin("medusa", byKind.medusa.atlas, tex, x, z));
  }
  // the boss, unless she has already been beaten in an earlier run
  if (!(typeof progression !== "undefined" && progression.data.queenDefeated)) {
    const tex = byKind.queen.tex.clone();
    tex.needsUpdate = true;
    queen = new Goblin("queen", byKind.queen.atlas, tex, ARENA.pos.x, ARENA.pos.y);
    enemies.push(queen);
  }
}

// open (no props within 6 m), level (under 0.8 m of rise across 8 m) ground in the infected zone,
// as near ARENA.want as possible
function findArena() {
  const ok = (x, z) => {
    const r = Math.max(Math.abs(x), Math.abs(z));
    if (r < 29 || r > 41) return false;
    const h = groundY(x, z);
    if (h === null) return false;
    for (let a = 0; a < 8; a++) {
      const hx = groundY(x + Math.cos(a * Math.PI / 4) * 4, z + Math.sin(a * Math.PI / 4) * 4);
      if (hx === null || Math.abs(hx - h) > 0.8) return false;
    }
    return colliders.every((c) => Math.hypot(x - c.x, z - c.z) > c.r + 6);
  };
  for (let ring = 0; ring < 16; ring++)
    for (let a = 0; a < 16; a++) {
      const x = ARENA.want.x + Math.cos(a * Math.PI / 8) * ring, z = ARENA.want.y + Math.sin(a * Math.PI / 8) * ring;
      if (ok(x, z)) return new THREE.Vector2(x, z);
    }
  return ARENA.want.clone();
}

// ---------- companion: a papillon that trots along beside the hero (no part in combat) ----------
class Dog {
  constructor(atlas, tex) {
    this.sprite = new SpriteCharacter(atlas, tex, { blobRadius: 0.18 });
    scene.add(this.sprite.root);
  }

  place(at) {
    this.sprite.root.position.copy(at).add(new THREE.Vector3(0.8, 0, 0.6));
  }

  update(dt, heroPos, heroYaw) {
    const s = this.sprite, p = s.root.position;
    // keep a spot at the hero's right, a little behind
    const fwd = facingVec(heroYaw), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const spot = heroPos.clone().addScaledVector(right, -0.85).addScaledVector(fwd, -0.55);
    const to = spot.sub(p).setY(0);
    const dist = to.length();
    if (heroPos.distanceTo(p) > 14) { this.place(heroPos); return; }   // lost: catch up at once
    if (dist > 0.3) {
      to.normalize();
      const speed = Math.min(7.5, Math.max(2.2, dist * 3.2));          // hurries when far behind
      p.addScaledVector(to, Math.min(dist, speed * dt));
      let d = Math.atan2(to.x, to.z) - s.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      s.facing += d * Math.min(1, dt * 12);
      s.state = "run";
    } else {
      s.state = "idle";
      let d = heroYaw - s.facing;                                       // settle facing the same way
      d = Math.atan2(Math.sin(d), Math.cos(d));
      s.facing += d * Math.min(1, dt * 3);
    }
    pushOut(p, 0.18);
    p.x = THREE.MathUtils.clamp(p.x, -LIMIT, LIMIT);
    p.z = THREE.MathUtils.clamp(p.z, -LIMIT, LIMIT);
    const gy = groundY(p.x, p.z);
    if (gy !== null) p.y = THREE.MathUtils.lerp(p.y, gy, Math.min(1, dt * 20));
    s.blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), groundNormal);
  }
}
let dog = null;

// ---------- birds: every 3 s a small group flies across the sky ----------
const birdMat = new THREE.MeshToonMaterial({ color: "#3a3f4c", gradientMap: ramp, side: THREE.DoubleSide });
const birds = [];
const BIRD_EVERY = 3, BIRD_SPEED = 7;
let birdClock = 1.5;     // first group shows up 1.5 s after start

function makeBird() {
  // body along +Z (Object3D.lookAt points +Z), two triangular wings hinged at the body
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.5, 4).rotateX(Math.PI / 2), birdMat);
  const wingGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0.12), new THREE.Vector3(0, 0, -0.1), new THREE.Vector3(0.55, 0, -0.12),
  ]);
  wingGeo.computeVertexNormals();
  const left = new THREE.Mesh(wingGeo, birdMat), right = new THREE.Mesh(wingGeo, birdMat);
  right.scale.x = -1;
  g.add(body, left, right);
  for (const m of g.children) m.castShadow = true;
  g.userData.wings = [left, right];
  return g;
}

function spawnBirds(center) {
  // enter ~30 m out on a random side, cross near the hero, leave on the other side
  const a = Math.random() * Math.PI * 2;
  const dir = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a));
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const start = center.clone().addScaledVector(dir, -30).addScaledVector(side, (Math.random() - 0.5) * 16);
  start.y = center.y + 3 + Math.random() * 2;   // below the camera (~9.6 m up), so they cross the view
  const n = 2 + (Math.random() < 0.35 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const b = makeBird();
    // loose V: followers trail behind and to the side
    b.position.copy(start).addScaledVector(dir, -1.4 * i).addScaledVector(side, (i % 2 ? 1 : -1) * 1.1 * i);
    b.position.y += (Math.random() - 0.5) * 0.6;
    b.userData.dir = dir.clone();
    b.userData.phase = Math.random() * Math.PI * 2;
    b.userData.travelled = 0;
    b.lookAt(b.position.clone().add(dir));
    scene.add(b);
    birds.push(b);
  }
}

function updateBirds(dt, center) {
  birdClock += dt;
  if (birdClock >= BIRD_EVERY) { birdClock -= BIRD_EVERY; spawnBirds(center); }
  const t = performance.now() / 1000;
  for (let i = birds.length - 1; i >= 0; i--) {
    const b = birds[i], u = b.userData;
    b.position.addScaledVector(u.dir, BIRD_SPEED * dt);
    b.position.y += Math.sin(t * 1.3 + u.phase) * 0.004;            // gentle rise and fall
    u.travelled += BIRD_SPEED * dt;
    const flap = Math.sin(t * 11 + u.phase) * 0.7;
    u.wings[0].rotation.z = flap;
    u.wings[1].rotation.z = -flap;
    if (u.travelled > 62) { scene.remove(b); birds.splice(i, 1); }
  }
}

// ---------- atmosphere: the sky, fog and light sicken as the hero walks into the infected zone ----------
const ZONE = {
  sky: [new THREE.Color("#9fd3e8"), new THREE.Color("#2a2533")],
  hemiSky: [new THREE.Color("#e8f4ff"), new THREE.Color("#9c8fb5")],
  hemiGround: [new THREE.Color("#5b6b3a"), new THREE.Color("#2e2a26")],
  sun: [new THREE.Color("#fff1d6"), new THREE.Color("#c3d4a0")],
};
let zone = 0;                // 0 forest .. 1 infected (smoothed)
const tmpColor = new THREE.Color();
function updateAtmosphere(dt, p) {
  const r = Math.max(Math.abs(p.x), Math.abs(p.z));
  const target = THREE.MathUtils.smoothstep(r, 19, 28);
  zone += (target - zone) * Math.min(1, dt * 1.5);
  const mix = (pair) => tmpColor.copy(pair[0]).lerp(pair[1], zone);
  if (!wire) { scene.background.copy(mix(ZONE.sky)); scene.fog.color.copy(scene.background); }
  scene.fog.near = THREE.MathUtils.lerp(28, 12, zone);
  scene.fog.far = THREE.MathUtils.lerp(60, 38, zone);
  hemi.color.copy(mix(ZONE.hemiSky));
  hemi.groundColor.copy(mix(ZONE.hemiGround));
  hemi.intensity = THREE.MathUtils.lerp(1.1, 0.6, zone);
  sun.color.copy(mix(ZONE.sun));
  sun.intensity = THREE.MathUtils.lerp(2.2, 1.0, zone);
  updateSpores(dt, p);
}

// drifting spores around the hero, only visible in the infected zone
const SPORES = 350, SPORE_BOX = 20;
const sporeGeo = new THREE.BufferGeometry();
const sporePos = new Float32Array(SPORES * 3);
for (let i = 0; i < SPORES; i++) {
  sporePos[i * 3] = (Math.random() * 2 - 1) * SPORE_BOX;
  sporePos[i * 3 + 1] = Math.random() * 8;
  sporePos[i * 3 + 2] = (Math.random() * 2 - 1) * SPORE_BOX;
}
sporeGeo.setAttribute("position", new THREE.BufferAttribute(sporePos, 3));
const sporeMat = new THREE.PointsMaterial({ color: "#b8ff7a", size: 0.09, transparent: true, opacity: 0,
  depthWrite: false, blending: THREE.AdditiveBlending });
const spores = new THREE.Points(sporeGeo, sporeMat);
spores.frustumCulled = false;
scene.add(spores);
function updateSpores(dt, p) {
  sporeMat.opacity = zone * 0.85;
  spores.visible = zone > 0.02;
  if (!spores.visible) return;
  spores.position.set(p.x, p.y, p.z);              // the cloud travels with the hero
  const t = performance.now() / 1000;
  for (let i = 0; i < SPORES; i++) {
    const k = i * 3;
    sporePos[k + 1] += dt * (0.25 + (i % 5) * 0.06);
    sporePos[k] += Math.sin(t * 0.7 + i) * dt * 0.15;
    if (sporePos[k + 1] > 8) sporePos[k + 1] = 0;
  }
  sporeGeo.attributes.position.needsUpdate = true;
}

// ---------- wireframe toggle (button or F key) ----------
const wireBtn = document.getElementById("wireBtn");
let wire = false;
function setWire(on) {
  wire = on;
  if (on) efk.ctx?.stopAll();                    // Effekseer effects are hidden in wire mode (EffekseerPass skips them)
  for (const m of worldMeshes) m.material.wireframe = on;
  birdMat.wireframe = on;
  // solid shadows from wire geometry look wrong, so drop them while in wire mode
  sun.castShadow = !on;
  for (const m of worldMeshes) m.material.needsUpdate = true;
  scene.background.set(on ? "#1b2130" : "#9fd3e8");
  scene.fog.color.copy(scene.background);
  if (hero) hero.quadLines.visible = on;
  for (const g of enemies) g.sprite.quadLines.visible = on;
  if (dog) dog.sprite.quadLines.visible = on;
  arrowMat.wireframe = on;
  wireBtn.classList.toggle("on", on);
  wireBtn.textContent = on ? "와이어프레임 끄기" : "와이어프레임 보기";
}
wireBtn.addEventListener("click", () => setWire(!wire));

// ---------- hero combat (soulslike): health, stamina, roll i-frames, guard, stagger ----------
const COMBAT = {
  attackCost: 18, rollCost: 22, sprintCost: 14,  // stamina
  regen: 40, regenDelay: 0.6, guardRegen: 0.35,  // stamina per second, wait after spending, rate while guarding
  rollTime: 0.6, rollSpeed: 7.6, iFrom: 0.08, iTo: 0.43,   // roll: duration, speed, invincible window (s)
  heroDmg: 34, heroHitFrame: 3, heroReach: 1.35,  // sword: damage, frame the blade lands, reach beyond the target's body
  guardArc: 0.26, guardCost: 1.25,              // blocks hits within ~75 deg of facing; stamina per point of damage
  buffer: 0.3,                                  // an early press still fires this long afterwards
  damageTaken: 1,                               // multiplier on incoming damage (defence lowers it)
  skillMind: SKILL_MIND_COST, mindRegen: 2.5,     // special skills: mind per use, mind regained per second
};
// parry: the guard (right button / K) newly raised within `window` ms before a blow lands from the front
const PARRY = {
  window: 350,          // ms: the parry timing window (covers the glint, which shows GLINT_LEAD = 280 ms ahead)
  stagger: 1.0,         // s the attacker is groggy: frozen, flashing red, open to a riposte
  riposte: 2.5,         // damage multiplier of the first hit on a parried enemy
  mind: 5,              // mind regained by a parry
};
const GLINT_LEAD = 0.28;   // s before a blow lands that the attacker's weapon glints
// 검기 파동 (skill 3): hits a fan ahead of the hero; the Effekseer slash is placed to cover the same fan
const SHOCK_FAN = {
  range: 5.5,                       // m
  halfAngle: THREE.MathUtils.degToRad(60),
  fxForward: 1.2,                   // m from the hero to the slash's centre
  fxScale: 0.6,                     // slash outer edge = 7 x 0.6 = 4.2 m from its centre → 5.4 m ahead
};
const H = {
  hp: 100, maxHp: 100, st: 100, maxSt: 100, regenWait: 0, stagger: 0, roll: null, dead: false,
  mind: 100, maxMind: 100, skill: null,         // skill: the special skill being performed
  guardPressAt: -1e9,                           // ms timestamp the guard was last raised (for parries)
  flash: 0, shake: 0, swingHit: false, lag: 100, lagWait: 0, buffered: null,
  knock: new THREE.Vector3(),                   // knockback velocity, decays
  poisonStacks: 0, poisonDecay: 0, poisonT: 0, poisonTick: 0,   // medusa venom (see POISON)
  petrifyT: 0,                                  // s left slowed by a medusa's stare (see PETRIFY)
};
if (typeof progression !== "undefined") progression.apply(COMBAT, H);   // [progression] saved stats
let hitStop = 0;
const hpFill = document.getElementById("hpFill"), hpLag = document.getElementById("hpLag");
const hpBarEl = document.getElementById("hpBar"), vignette = document.getElementById("vignette");
const poisonEl = document.getElementById("poison"), poisonText = document.getElementById("poisonText");
const poisonFill = document.getElementById("poisonFill");
const stFill = document.getElementById("stFill"), stBar = document.getElementById("stBar");
const mpFill = document.getElementById("mpFill");
const deathEl = document.getElementById("death");

function bufferAction(a) { H.buffered = { a, t: COMBAT.buffer }; }

// returns "dodged" | "parried" | "blocked" | "hit" | "ignored"
function damageHero(amount, from) {
  if (H.dead) return "ignored";
  amount *= COMBAT.damageTaken;
  if (H.roll && H.roll.t >= COMBAT.iFrom && H.roll.t <= COMBAT.iTo) return "dodged";
  const act = H.skill && SKILL_ACTIONS[H.skill.id];
  if (act?.iFrom !== undefined && H.skill.t >= act.iFrom && H.skill.t <= act.iTo) return "dodged";
  const p = hero.root.position;
  const toSrc = from.clone().sub(p).setY(0).normalize();
  const guarding = hero.state === "defend" && H.stagger <= 0;
  // parry: a fresh guard press inside the window before this blow (only against the front)
  const sincePress = simNow - H.guardPressAt;
  const free = !H.roll && !hero.attacking && H.stagger <= 0;
  if (free && sincePress >= 0 && sincePress <= PARRY.window && facingVec(hero.facing).dot(toSrc) > COMBAT.guardArc) {
    H.guardPressAt = -1e9;                      // one press parries one blow
    H.mind = Math.min(H.maxMind, H.mind + PARRY.mind);
    hitStop = 0.12;
    H.shake = 0.12;
    clangSound();
    sparkFx(p.clone().addScaledVector(toSrc, 0.5).add(new THREE.Vector3(0, 1.1, 0)));
    return "parried";
  }
  if (guarding && facingVec(hero.facing).dot(toSrc) > COMBAT.guardArc) {
    const cost = amount * COMBAT.guardCost;
    if (H.st >= cost) {                         // blocked: stamina takes it
      H.st -= cost;
      H.regenWait = COMBAT.regenDelay;
      H.knock.copy(toSrc).multiplyScalar(-1.5);
      return "blocked";
    }
    H.st = 0;                                   // guard broken: long stagger, half the damage gets through
    H.stagger = 1.0;
    amount *= 0.5;
  }
  H.hp -= amount;
  H.lagWait = 0.6;
  H.flash = 0.18;
  H.shake = 0.25;
  hero.oneShot = null;
  H.roll = null;
  H.skill = null;                               // a hit cuts a special skill short
  H.stagger = Math.max(H.stagger, 0.35);
  H.knock.copy(toSrc).multiplyScalar(-4);
  if (H.hp <= 0) killHero();
  return "hit";
}

function killHero() {
  H.dead = true;
  H.hp = 0;
  hero.oneShot = null;
  hero.state = "die";
  deathEl.classList.add("show");                // darkens over 2 s (CSS), then YOU DIED fades in
  mouseGuard = false;
  if (typeof progression !== "undefined") {     // [progression] carried points stay here, then the spend screen
    progression.dropStain(hero.root.position);
    progression.onDeath(deathEl);
  }
  else setTimeout(() => deathEl.addEventListener("click", () => location.reload(), { once: true }), 2000);
}

function updateHud(dt) {
  H.lagWait -= dt;
  if (H.lagWait <= 0) H.lag = Math.max(H.hp, H.lag - 40 * dt);   // the yellow chunk drains after a hit
  hpFill.style.width = `${(H.hp / H.maxHp) * 100}%`;
  hpLag.style.width = `${(H.lag / H.maxHp) * 100}%`;
  stFill.style.width = `${(Math.max(0, H.st) / H.maxSt) * 100}%`;
  stBar.classList.toggle("empty", H.st <= 0);
  mpFill.style.width = `${(H.mind / H.maxMind) * 100}%`;
  skillBar.classList.toggle("nomind", H.mind < COMBAT.skillMind);
  // poison build-up meter (bottom centre, Elden Ring style): fills with stacks and drains smoothly
  // as they fade; once poisoned it turns violet and drains over the poison time
  const poisoned = H.poisonT > 0;
  poisonEl.hidden = !(poisoned || H.poisonStacks > 0);
  if (!poisonEl.hidden) {
    const fill = poisoned ? H.poisonT / POISON.time
      : (H.poisonStacks - 1 + H.poisonDecay / POISON.decay) / POISON.max;
    poisonFill.style.width = `${Math.max(0, Math.min(1, fill)) * 100}%`;
    poisonEl.classList.toggle("active", poisoned);
    poisonText.textContent = poisoned ? `중독 ${Math.ceil(H.poisonT)}초` : "독";
  }
  hpBarEl.classList.toggle("poisoned", poisoned);
  vignette.className = poisoned ? "poison" : H.petrifyT > 0 ? "stone" : "";
  updateGoals(dt);
}

// ---------- goals: area names, the objective arrow, the boss bar, the points stain ----------
const zoneEl = document.getElementById("zone"), objectiveEl = document.getElementById("objective");
const bossEl = document.getElementById("boss"), bossFill = document.getElementById("bossFill");
const toastEl = document.getElementById("toast"), victoryEl = document.getElementById("victory");
const goal = { zone: "", pending: "", pendingT: 0, stainMarker: null };

function zoneAt(p) {
  if (ARENA.pos && queen && queen.state !== "dead" && Math.hypot(p.x - ARENA.pos.x, p.z - ARENA.pos.y) < ARENA.clear) return "여왕의 둥지";
  return Math.max(Math.abs(p.x), Math.abs(p.z)) < 25 ? "고요한 숲" : "감염 지대";
}

// a name card across the upper middle, Elden Ring style: shown on entering an area
function showZone(name) {
  zoneEl.textContent = name;
  zoneEl.classList.remove("show");
  void zoneEl.offsetWidth;                         // restart the CSS fade
  zoneEl.classList.add("show");
}
function showToast(text, kind = "") {
  toastEl.textContent = text;
  toastEl.className = "";
  void toastEl.offsetWidth;
  toastEl.className = `show ${kind}`;
}
function showVictory(title, sub) {
  victoryEl.querySelector("h2").textContent = title;
  victoryEl.querySelector("p").textContent = sub;
  victoryEl.className = "";
  void victoryEl.offsetWidth;
  victoryEl.className = "show";
}

function updateGoals(dt) {
  const p = hero.root.position;
  // area name: only once the hero has stayed in the new area half a second (no flicker on a border)
  const z = zoneAt(p);
  if (z !== goal.zone) {
    if (z !== goal.pending) { goal.pending = z; goal.pendingT = 0; }
    goal.pendingT += dt;
    if (goal.pendingT > 0.5 || !goal.zone) { goal.zone = z; showZone(z); }
  }
  // objective: the queen's distance and an arrow pointing at her nest, relative to the camera
  if (queen && queen.state !== "dead" && ARENA.pos) {
    const dx = ARENA.pos.x - p.x, dz = ARENA.pos.y - p.z;
    const fx = p.x - camera.position.x, fz = p.z - camera.position.z;           // the screen's "up" on the ground
    // clockwise angle from screen-up; screen-right on the ground is (-fz, fx)
    const ang = Math.atan2(dz * fx - dx * fz, dx * fx + dz * fz);
    objectiveEl.innerHTML = `<span class="arrow" style="transform: rotate(${ang}rad)"></span>목표 · ${queen.cfg.name} 처치 <b>${Math.round(Math.hypot(dx, dz))}m</b>`;
  } else if (typeof progression !== "undefined" && progression.data.queenDefeated) {
    objectiveEl.innerHTML = `${GOBLINS.queen.name} 처치 완료 · 누적 사망 ${progression.data.deaths}회`;
  }
  // boss bar: while she is awake and the hero is in her nest
  const fight = queen && queen.alive && p.distanceTo(queen.sprite.root.position) < 30;
  bossEl.hidden = !fight;
  if (fight) bossFill.style.width = `${Math.max(0, queen.hp / queen.cfg.hp) * 100}%`;
  updateStain(dt, p);
}

// the points left at the last death: a pale gold beam; touching it banks them
function updateStain(dt, p) {
  if (typeof progression === "undefined") return;
  const s = progression.stain();
  if (!s) { if (goal.stainMarker) { scene.remove(goal.stainMarker); goal.stainMarker = null; } return; }
  if (!goal.stainMarker) {
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 3.2, 12, 1, true), fxMaterial("#ffe08a"));
    beam.position.y = 1.6;
    const core = starMesh(0.9, "#fff3c4");
    core.position.y = 0.9;
    g.add(beam, core);
    g.position.set(s.x, groundY(s.x, s.z) ?? s.y, s.z);
    scene.add(g);
    goal.stainMarker = g;
  }
  const g = goal.stainMarker, t = performance.now() * 0.001;
  g.children[0].material.opacity = 0.35 + 0.15 * Math.sin(t * 3);
  g.children[1].quaternion.copy(camera.quaternion);
  g.children[1].position.y = 0.9 + 0.15 * Math.sin(t * 2);
  if (!H.dead && Math.hypot(p.x - s.x, p.z - s.z) < 1.2) {
    const n = progression.recoverStain();
    showToast(`포인트 ${n} 회수`, "gold");
    tone(660, 0.25, 0.07, "triangle", 990);
    scene.remove(g);
    goal.stainMarker = null;
  }
}

// ---------- special skills (see skills.js): F uses the equipped one, number keys pick it ----------
// Each entry: anim (hero motion played once), speed (its playback rate), time (how long the skill
// owns the hero), optional iFrom..iTo (invincible window), start(sk) and tick(sk, dt, heroPos).
const SKILL_ACTIONS = {
  // spin: the facing turns a full circle while the sword is held out; hits everything around
  spin: {
    anim: "spin", time: 0.45,
    start(sk) { sk.yaw0 = hero.facing; },
    tick(sk, dt, p) {
      hero.facing = sk.yaw0 + Math.min(1, sk.t / 0.42) * Math.PI * 2;
      if (!sk.struck && sk.t >= 0.12) { sk.struck = true; spinFx(p); hitAround(p, 2.0, 0); }
    },
  },
  // pierce: a dash straight ahead, invincible, running every enemy on the way through
  pierce: {
    anim: "thrust", time: 0.42, iFrom: 0.04, iTo: 0.32,
    start(sk) { sk.dir = facingVec(hero.facing); },
    tick(sk, dt, p) {
      if (sk.t < 0.06 || sk.t > 0.3) return;
      if (!sk.fx) { sk.fx = true; pierceFx(p, sk.dir); }
      p.addScaledVector(sk.dir, 15 * dt);
      let hit = false;
      for (const g of enemies) {
        if (!g.alive || sk.hits.has(g)) continue;
        const q = g.sprite.root.position;
        if (Math.hypot(q.x - p.x, q.z - p.z) < 1.1 + g.cfg.radius) { sk.hits.add(g); skillHit(g, p, 0); hit = true; }
      }
      if (hit) hitStop = 0.05;
    },
  },
  // shock (검기 파동): the overhead chop slams the ground and sends a sword wave out in a fan ahead;
  // only enemies inside that fan are cut and thrown back
  shock: {
    anim: "attack", speed: 1.15, time: 0.5,
    tick(sk, dt, p) {
      if (!sk.struck && sk.t >= 0.24) {
        sk.struck = true;
        shockFx(p);
        hitCone(p, hero.facing, SHOCK_FAN.range, SHOCK_FAN.halfAngle, 14);
        H.shake = 0.2;
      }
    },
  },
};

// x2.5 on the first hit into a parried enemy (and that uses up the opening)
function riposte(g) {
  if (!(g.riposteUntil > simNow)) return 1;
  g.riposteUntil = 0;
  g.stagger = 0;
  critFx(g.sprite.root.position);
  return PARRY.riposte;
}

function skillHit(g, from, knock) {
  g.takeHit(COMBAT.heroDmg * SKILL_DAMAGE * riposte(g), from, knock);
}
function hitAround(p, range, knock) {
  let hit = false;
  for (const g of enemies) {
    if (!g.alive) continue;
    const q = g.sprite.root.position;
    if (Math.hypot(q.x - p.x, q.z - p.z) < range + g.cfg.radius) { skillHit(g, p, knock); hit = true; }
  }
  if (hit) hitStop = 0.07;
}
// enemies within `range` of p and within `halfAngle` (rad) either side of `facing`
function hitCone(p, facing, range, halfAngle, knock) {
  const f = facingVec(facing), cos = Math.cos(halfAngle);
  let hit = false;
  for (const g of enemies) {
    if (!g.alive) continue;
    const q = g.sprite.root.position;
    const to = new THREE.Vector3(q.x - p.x, 0, q.z - p.z);
    const d = to.length();
    if (d > range + g.cfg.radius) continue;
    if (d > g.cfg.radius + HERO_RADIUS && f.dot(to.divideScalar(d)) < cos) continue;   // touching counts as in front
    skillHit(g, p, knock);
    hit = true;
  }
  if (hit) hitStop = 0.07;
}

function equippedSkill() {
  return typeof progression !== "undefined" ? progression.equipped() : null;
}
function startSkill() {
  const id = equippedSkill();
  if (!id) return flashSkillBar("해금한 특수기가 없습니다 (사망 후 포인트로 해금)");
  if (H.mind < COMBAT.skillMind) return flashSkillBar("정신력이 부족합니다");
  const act = SKILL_ACTIONS[id];
  H.mind -= COMBAT.skillMind;
  H.st -= COMBAT.attackCost * SKILL_STAMINA;
  H.skill = { id, t: 0, hits: new Set() };
  act.start?.(H.skill);
  hero.playOnce(act.anim, act.speed ?? 1);
}
function updateSkill(dt, p) {
  const sk = H.skill, act = SKILL_ACTIONS[sk.id];
  sk.t += dt;
  act.tick(sk, dt, p);
  if (sk.t >= act.time) H.skill = null;
}

const skillBar = document.getElementById("skillbar");
let hintTimer = 0;
function renderSkillBar() {
  const own = typeof progression !== "undefined" ? progression.unlocked() : [];
  const eq = equippedSkill();
  skillBar.innerHTML = SKILLS.map((sk, i) => {
    const has = own.includes(sk.id);
    return `<div class="slot ${has ? "" : "locked"} ${sk.id === eq ? "on" : ""}">
      <b>${i + 1}</b><span>${sk.name}</span><small>${has ? `정신력 ${COMBAT.skillMind}` : "잠김"}</small></div>`;
  }).join("") + `<div class="hint" id="skillHint">F 특수기 사용</div>`;
}
function flashSkillBar(text) {
  const hint = document.getElementById("skillHint");
  hint.textContent = text;
  skillBar.classList.add("warn");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { skillBar.classList.remove("warn"); hint.textContent = "F 특수기 사용"; }, 1600);
}
function selectSkill(i) {
  const sk = SKILLS[i];
  if (!sk) return;
  if (typeof progression !== "undefined" && progression.equip(sk.id)) renderSkillBar();
  else flashSkillBar(`${sk.name}: 아직 잠겨 있습니다`);
}
renderSkillBar();

// ---------- skill effects: short additive flashes that the bloom picks up ----------
const effects = [];
function fxMaterial(color) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
}
function addEffect(mesh, dur, tick) {
  scene.add(mesh);
  effects.push({ mesh, dur, t: 0, tick });
}
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.t += dt;
    const k = Math.min(1, e.t / e.dur);
    e.tick(e.mesh, k);
    if (k >= 1) { scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); effects.splice(i, 1); }
  }
}
function spinFx(p) {                     // a sweeping arc around the hero at sword height
  const m = new THREE.Mesh(new THREE.RingGeometry(1.75, 2.25, 48, 1, 0, Math.PI * 1.7), fxMaterial("#cfe6ff"));
  m.rotation.x = -Math.PI / 2;
  m.position.copy(p).add(new THREE.Vector3(0, 0.9, 0));
  addEffect(m, 0.35, (o, k) => { o.rotation.z = hero.facing + k * 2; o.material.opacity = 0.75 * (1 - k); });
}
function pierceFx(p, dir) {              // a streak along the dash
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 4.2), fxMaterial("#d8ecff"));
  m.position.copy(p).addScaledVector(dir, 2.1).add(new THREE.Vector3(0, 1.0, 0));
  m.rotation.y = Math.atan2(dir.x, dir.z);
  addEffect(m, 0.35, (o, k) => { o.material.opacity = 0.9 * (1 - k); o.scale.x = 1 + k * 2; });
}
function starMesh(size, color) {          // a 4-point twinkle, faced to the camera by its tick
  const g = new THREE.Group();
  for (const r of [0, Math.PI / 2]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.14), fxMaterial(color));
    m.rotation.z = r;
    g.add(m);
  }
  // updateEffects fades mesh.material.opacity and disposes mesh.geometry/material: pass both to the arms
  g.geometry = { dispose() { g.children.forEach((c) => c.geometry.dispose()); } };
  g.material = {
    set opacity(v) { g.children.forEach((c) => (c.material.opacity = v)); },
    dispose() { g.children.forEach((c) => c.material.dispose()); },
  };
  return g;
}
function glintFx(enemy) {                 // the attacker's weapon flashes just before the blow
  const p = enemy.sprite.root.position;
  const m = starMesh(0.45, "#fff6c8");                // small: a cue, not a curtain over the fight
  const f = facingVec(enemy.sprite.facing);
  m.position.copy(p).addScaledVector(f, 0.45).add(new THREE.Vector3(0, enemy.cfg.barY * 0.75, 0));
  addEffect(m, 0.22, (o, k) => {
    o.quaternion.copy(camera.quaternion);
    o.rotateZ(k * 1.5);
    o.scale.setScalar(0.4 + Math.sin(k * Math.PI) * 1.1);
    o.material.opacity = 1 - k * 0.6;
  });
  if (enemy.sprite.root.position.distanceTo(hero.root.position) < 10) glintSound();
}
function sparkFx(at) {                    // a parry: a burst of light at the shield
  const m = starMesh(1.8, "#ffffff");
  m.position.copy(at);
  addEffect(m, 0.25, (o, k) => {
    o.quaternion.copy(camera.quaternion);
    o.rotateZ(0.6 + k);
    o.scale.setScalar(0.6 + k * 1.4);
    o.material.opacity = 1 - k;
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 32), fxMaterial("#fff2b0"));
  ring.position.copy(at);
  addEffect(ring, 0.3, (o, k) => { o.quaternion.copy(camera.quaternion); o.scale.setScalar(1 + k * 3); o.material.opacity = 0.9 * (1 - k); });
}
function critFx(p) {                      // a riposte lands
  const m = starMesh(2.4, "#ffd479");
  m.position.copy(p).add(new THREE.Vector3(0, 1.2, 0));
  addEffect(m, 0.3, (o, k) => {
    o.quaternion.copy(camera.quaternion);
    o.rotateZ(k * 2);
    o.scale.setScalar(0.5 + k * 1.2);
    o.material.opacity = 1 - k;
  });
  tone(520, 0.18, 0.08, "square", 260);
}
function shockFx(p) {                    // 검기 파동: a sword wave sweeping a fan ahead of the hero
  const f = facingVec(hero.facing);
  if (efk.ctx) {
    // Effekseer sword slash (tutorial 10) laid flat, its half circle opening forward. Its centre sits
    // SHOCK_FAN.fxForward ahead so the blade edge (7 units x scale) reaches the fan's range.
    const at = new THREE.Vector3(p.x, p.y + 0.15, p.z).addScaledVector(f, SHOCK_FAN.fxForward);
    playFx(efk.shockSlash, at, { x: -Math.PI / 2, y: hero.facing + Math.PI, z: 0 }, SHOCK_FAN.fxScale);
    return;
  }
  // fallback: a flat fan racing out over the ground. Laid flat by rotation.x = -π/2, ring angle θ points
  // at world (cos θ, 0, -sin θ), so the fan centred on the facing starts at facing - π/2 - half.
  const half = SHOCK_FAN.halfAngle;
  const m = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.0, 32, 1, hero.facing - Math.PI / 2 - half, half * 2),
    fxMaterial("#e2f4ff"));
  m.rotation.x = -Math.PI / 2;
  m.position.copy(p).add(new THREE.Vector3(0, 0.12, 0));
  addEffect(m, 0.4, (o, k) => { o.scale.setScalar(0.5 + k * (SHOCK_FAN.range - 0.5)); o.material.opacity = 0.95 * (1 - k); });
}

// ---------- main ----------
const LIMIT = 45;
let hero;

function step(dt) {
  if (hitStop > 0) { hitStop -= dt; dt *= 0.05; }       // brief freeze when the sword connects
  if (keys.has("KeyQ")) cam.yaw += dt * 1.8;
  if (keys.has("KeyE")) cam.yaw -= dt * 1.8;
  edgeTurn(dt);

  // movement input relative to the camera's ground-plane forward
  const fwd = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  const rgt = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const move = new THREE.Vector3();
  if (!H.dead) {
    if (keys.has("KeyW")) move.add(fwd);
    if (keys.has("KeyS")) move.sub(fwd);
    if (keys.has("KeyD")) move.add(rgt);
    if (keys.has("KeyA")) move.sub(rgt);
  }
  if (move.lengthSq() > 0) move.normalize();
  const p = hero.root.position;

  // buffered attack / roll fire as soon as the hero is free
  if (H.buffered) {
    H.buffered.t -= dt;
    const free = !H.dead && H.stagger <= 0 && !H.roll && !hero.attacking;
    if (free && H.st > 0) {
      const a = H.buffered.a;
      H.buffered = null;
      if (move.lengthSq() > 0) hero.facing = Math.atan2(move.x, move.z);
      if (a === "skill") {
        startSkill();
      } else if (a === "attack") {
        H.st -= COMBAT.attackCost;
        hero.playOnce("attack");
        H.swingHit = false;
      } else {
        H.st -= COMBAT.rollCost;
        H.roll = { t: 0, dir: facingVec(hero.facing) };
        hero.playOnce("roll");
      }
      H.regenWait = COMBAT.regenDelay;
    } else if (H.buffered.t <= 0) {
      H.buffered = null;
    }
  }

  const defending = !H.dead && (keys.has("KeyK") || mouseGuard) && !hero.attacking && !H.roll && H.stagger <= 0;
  const busy = defending || hero.attacking;
  let sprinting = false;
  if (H.dead) {
    hero.state = "die";
  } else if (H.roll) {                                   // roll: fast at first, easing out at the end
    H.roll.t += dt;
    const k = H.roll.t < 0.45 ? 1 : Math.max(0, (COMBAT.rollTime - H.roll.t) / 0.15);
    p.addScaledVector(H.roll.dir, COMBAT.rollSpeed * k * dt);
    if (H.roll.t >= COMBAT.rollTime) H.roll = null;
  } else if (H.stagger > 0) {
    H.stagger -= dt;
    hero.state = "idle";
  } else {
    if (move.lengthSq() > 0) {
      sprinting = (keys.has("ShiftLeft") || keys.has("ShiftRight")) && !busy && H.st > 0;
      // attacking or guarding: creep at 10% speed, keeping the current facing (shuffle/strafe)
      const speed = (sprinting ? 5.2 : 3.0) * (busy ? 0.1 : 1) * (H.petrifyT > 0 ? PETRIFY.slow : 1);
      p.addScaledVector(move, speed * dt);
      if (!busy) {
        let d = Math.atan2(move.x, move.z) - hero.facing;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        hero.facing += d * Math.min(1, dt * 14);
      }
    }
    hero.state = defending ? "defend" : move.lengthSq() > 0 ? "walk" : "idle";
  }
  // knockback from hits and blocks
  p.addScaledVector(H.knock, dt);
  H.knock.multiplyScalar(Math.max(0, 1 - dt * 8));

  // stamina: sprinting drains it; it refills after a short wait, slowly while guarding
  if (sprinting) { H.st -= COMBAT.sprintCost * dt; H.regenWait = Math.max(H.regenWait, 0.3); }
  else if (!hero.attacking && !H.roll) {
    H.regenWait -= dt;
    if (H.regenWait <= 0) H.st = Math.min(H.maxSt, H.st + COMBAT.regen * dt * (defending ? COMBAT.guardRegen : 1));
  }

  if (H.skill) updateSkill(dt, p);
  if (!H.dead) H.mind = Math.min(H.maxMind, H.mind + COMBAT.mindRegen * dt);
  updatePoison(dt);

  // the sword lands on its hit frame: every goblin in reach and in front takes it
  if (hero.oneShot?.name === "attack" && hero.frame >= COMBAT.heroHitFrame && !H.swingHit) {
    H.swingHit = true;
    const f = facingVec(hero.facing);
    let hits = 0;
    for (const g of enemies) {
      if (!g.alive) continue;
      const to = g.sprite.root.position.clone().sub(p).setY(0);
      const d = to.length();
      if (d < COMBAT.heroReach + g.cfg.radius + HERO_RADIUS && f.dot(to.normalize()) > 0.4) {
        g.takeHit(COMBAT.heroDmg * riposte(g), p);
        hits++;
      }
    }
    if (hits) hitStop = 0.07;
  }

  pushOut(p, HERO_RADIUS);
  p.x = THREE.MathUtils.clamp(p.x, -LIMIT, LIMIT);
  p.z = THREE.MathUtils.clamp(p.z, -LIMIT, LIMIT);
  const gy = groundY(p.x, p.z);
  if (gy !== null) p.y = THREE.MathUtils.lerp(p.y, gy, Math.min(1, dt * 20));
  // lay the round shadow flat on the slope under the feet
  hero.blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), groundNormal);

  // hurt flash
  H.flash -= dt;
  if (H.flash > 0) hero.mat.color.setRGB(1, 0.4, 0.4);
  else if (H.petrifyT > 0) hero.mat.color.setRGB(0.62, 0.62, 0.68);   // petrified: stony grey
  else if (H.poisonT > 0) hero.mat.color.setRGB(0.78, 1, 0.7);        // poisoned: a sickly green
  else hero.mat.color.setRGB(1, 1, 1);

  // orbit camera around the hero (shakes briefly when he is hit)
  const look = p.clone().add(new THREE.Vector3(0, 1.0, 0));
  camera.position.set(
    look.x + Math.sin(cam.yaw) * Math.cos(cam.pitch) * cam.dist,
    look.y + Math.sin(cam.pitch) * cam.dist,
    look.z + Math.cos(cam.yaw) * Math.cos(cam.pitch) * cam.dist
  );
  camera.lookAt(look);
  if (H.shake > 0) {
    H.shake -= dt;
    const a = 0.12 * (H.shake / 0.25);
    camera.position.add(new THREE.Vector3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a));
  }
  sun.position.copy(p).add(new THREE.Vector3(12, 20, 8));
  sun.target.position.copy(p);

  fadeOccluders(look);
  updateBirds(dt, p);
  updateAtmosphere(dt, p);
  updateEffects(dt);
  efk.ctx?.update(dt * 60);                       // Effekseer counts in 60 fps frames; slows with the hit stop too
  updateEnemies(dt, p);
  for (const g of enemies) if (g.sprite.root.visible) g.sprite.update(dt, camera);
  if (dog) { dog.update(dt, p, hero.facing); dog.sprite.update(dt, camera); }
  if (water) water.position.y += Math.sin(performance.now() * 0.0015) * 0.0004;
  dirLabel.textContent = hero.update(dt, camera);
  updateHud(dt);
}

async function main() {
  resize();
  initEffekseer();
  const [atlas] = await Promise.all([
    fetch("assets/hero.json").then((r) => r.json()),
    loadWorld(),
  ]);
  const tex = await new THREE.TextureLoader().loadAsync(`assets/${atlas.image}`);
  hero = new SpriteCharacter(atlas, tex);
  hero.root.position.set(spawn.x, groundY(spawn.x, spawn.z) ?? spawn.y, spawn.z);
  scene.add(hero.root);
  await loadEnemies();
  const dogAtlas = await fetch("assets/dog.json").then((r) => r.json());
  dog = new Dog(dogAtlas, await new THREE.TextureLoader().loadAsync(`assets/${dogAtlas.image}`));
  dog.place(hero.root.position);

  let last = performance.now(), acc = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);   // after a long stall, don't try to catch up
    last = now;
    let n = 0;
    while (acc >= FIXED && n < 15) {
      acc -= FIXED;
      simNow = now - acc * 1000;                      // the moment this step stands for
      step(FIXED);
      n++;
    }
    if (n === 15) acc = 0;
    composer.render();
  });
}
main();
