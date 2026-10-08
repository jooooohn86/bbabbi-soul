// Bbabbi Soul: low-res pixelated 3D world + an 8-direction 2D sprite character
// that picks its view from the angle between its facing and the camera.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
// [progression] growth system; every hook below checks it exists, so deleting this line and
// progression.js removes it cleanly
import { progression } from "./progression.js";

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
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.5, 0.45);  // strength, radius, threshold
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- lighting ----------
scene.add(new THREE.HemisphereLight("#e8f4ff", "#5b6b3a", 1.1));
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
      o.material = new THREE.MeshToonMaterial({ color: src.color, gradientMap: ramp });
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

const ray = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
const groundNormal = new THREE.Vector3(0, 1, 0);   // surface normal under the last groundY() sample
function groundY(x, z) {
  ray.set(new THREE.Vector3(x, 50, z), down);
  const hit = ray.intersectObjects(terrain, false)[0];
  if (!hit) return null;   // off the terrain: callers keep their current height
  groundNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
  return hit.point.y;
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
    this.stateTime = 0;   // time since that state started (entry frames play from 0)
    this.sector = 0;
  }

  get attacking() { return this.oneShot !== null; }

  // play a motion once over whatever state is set, then hand back to it.
  // speed scales its frame rate (goblin wind-ups are slowed down so they can be read)
  playOnce(name, speed = 1) {
    if (!this.oneShot) this.oneShot = { name, t: 0, speed };
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
      fi = Math.floor(this.stateTime * anim.fps);
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

// ---------- input ----------
const keys = new Set();
addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "KeyF") setWire(!wire);
  if (e.code === "KeyP") { pixelIdx = (pixelIdx + 1) % PIXEL_SIZES.length; resize(); }
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) bufferAction("roll"); }
  if (e.code === "KeyJ" && !e.repeat) bufferAction("attack");
});
addEventListener("keyup", (e) => keys.delete(e.code));

const cam = { yaw: Math.PI * 0.25, pitch: 0.72, dist: 13 };
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointerup", () => (dragging = false));
canvas.addEventListener("pointermove", (e) => {
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
           hp: 120, dmg: 10, hitFrame: 3, atkSpeed: 0.9, poise: 1, barY: 1.25, barW: 0.6 },
  mid:   { detect: 12, speed: 3.2, radius: 0.35, blob: 0.38, bush: 1.1, reach: 0.6, cooldown: 2.4, meleeCooldown: 1.6,
           keepFar: 11, meleeSwitch: 3.5, releaseFrame: 4, arrowDmg: 12,
           hp: 180, dmg: 12, hitFrame: 3, atkSpeed: 0.75, poise: 1, barY: 2.0, barW: 0.8 },
  large: { detect: 8, speed: 2.4, radius: 0.60, blob: 0.62, bush: 1.6, reach: 0.9, cooldown: 2.4,
           hp: 450, dmg: 30, hitFrame: 3, atkSpeed: 0.55, poise: 2, barY: 3.15, barW: 1.2 },
};
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
    this.home = new THREE.Vector3(x, groundY(x, z) ?? 0, z);
    this.bush = makeBush(this.cfg.bush);
    this.bush.position.copy(this.home);
    this.bar = makeHealthBar(this.cfg.barW);
    this.bar.position.y = this.cfg.barY;
    this.sprite.root.add(this.bar);
    scene.add(this.bush, this.sprite.root);
    this.shake = 0;
    this.hide();
  }

  get alive() { return this.state === "hunt"; }

  // back in the bush at full health (also the respawn after a death)
  hide() {
    this.state = "hidden";
    this.hp = this.cfg.hp;
    this.hits = 0;
    this.stagger = 0;
    this.flash = 0;
    this.cooldown = 0;
    const s = this.sprite;
    s.root.visible = false;
    s.root.position.copy(this.home);
    s.oneShot = null;
    s.mat.opacity = 1;
    s.mat.transparent = false;
    s.mat.color.set(1, 1, 1);
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

  takeHit(dmg, from) {
    if (!this.alive) return;
    this.hp -= dmg;
    this.hits++;
    this.flash = 0.15;
    const p = this.sprite.root.position;
    const away = p.clone().sub(from).setY(0).normalize();
    p.addScaledVector(away, this.kind === "large" ? 0.12 : 0.35);
    if (this.hits % this.cfg.poise === 0) {                 // poise broken: the attack is cancelled
      this.stagger = this.kind === "large" ? 0.6 : 0.45;
      this.sprite.oneShot = null;
    }
    this.bar.visible = true;
    if (this.hp <= 0) {
      if (typeof progression !== "undefined") progression.onKill(this.kind);   // [progression] points
      this.state = "dead";
      this.deadT = 0;
      this.sprite.oneShot = null;
      this.sprite.state = "idle";
      this.sprite.mat.transparent = true;
      this.bar.visible = false;
    }
  }

  update(dt, heroPos) {
    if (this.shake > 0) {                                   // bush rustles when it bursts out
      this.shake -= dt;
      this.bush.rotation.z = Math.sin(this.shake * 40) * 0.12 * Math.max(0, this.shake / 0.6);
    }
    const s = this.sprite, p = s.root.position, cfg = this.cfg;
    if (this.state === "hidden") {
      if (!H.dead && heroPos.distanceTo(this.home) < cfg.detect) this.emerge(heroPos);
      return;
    }
    // hero gone far away: back into hiding (a dead goblin respawns this way)
    if (heroPos.distanceTo(this.home) > LEASH && heroPos.distanceTo(p) > 22) { this.hide(); return; }
    if (this.state === "dead") {                            // fade out and sink, then stay gone
      this.deadT += dt;
      s.mat.opacity = Math.max(0, 1 - this.deadT / 0.8);
      p.y -= dt * 0.4;
      if (this.deadT > 0.8) s.root.visible = false;
      return;
    }

    this.flash -= dt;
    s.mat.color.setRGB(1, this.flash > 0 ? 0.45 : 1, this.flash > 0 ? 0.45 : 1);
    this.bar.userData.fill.scale.x = Math.max(0, this.hp / cfg.hp) * this.bar.userData.width;

    const to = heroPos.clone().sub(p).setY(0);
    const dist = to.length();
    to.normalize();
    this.cooldown -= dt;
    let move = 0;

    if (this.stagger > 0) {
      this.stagger -= dt;
    } else if (!H.dead) {
      // turn to face the hero, but commit once the blow is on its way
      const committed = s.oneShot && s.frame >= cfg.hitFrame - 1;
      if (!committed) {
        let df = Math.atan2(to.x, to.z) - s.facing;
        df = Math.atan2(Math.sin(df), Math.cos(df));
        s.facing += df * Math.min(1, dt * 8);
      }
      const bodies = cfg.reach + cfg.radius + HERO_RADIUS;
      if (!s.attacking) {
        const melee = this.kind !== "mid" || dist < cfg.meleeSwitch;   // the archer fights hand to hand up close
        if (melee) {
          if (dist > bodies) move = 1;
          else if (this.cooldown <= 0) {
            s.playOnce("attack", cfg.atkSpeed);
            this.cooldown = this.kind === "mid" ? cfg.meleeCooldown : cfg.cooldown;
            this.struck = false;
          }
        } else if (dist > cfg.keepFar) {
          move = 1;
        } else if (this.cooldown <= 0) {
          s.playOnce("shoot");
          this.cooldown = cfg.cooldown;
          this.loosed = false;
        }
      }
      // melee blow lands on its hit frame: hero in reach and in front of the goblin
      if (s.oneShot?.name === "attack" && s.frame >= cfg.hitFrame && !this.struck) {
        this.struck = true;
        if (dist <= bodies + 0.35 && facingVec(s.facing).dot(to) > 0.35) damageHero(cfg.dmg, p);
      }
      // the archer lets go on the release frame of its draw
      if (s.oneShot?.name === "shoot" && s.frame >= cfg.releaseFrame && !this.loosed) {
        this.loosed = true;
        fireArrow(p, heroPos, s.facing, cfg.arrowDmg);
      }
    }
    if (move) {
      p.addScaledVector(to, move * cfg.speed * dt);
      s.state = "run";
    } else {
      s.state = "idle";
    }
    pushOut(p, cfg.radius);
    p.x = THREE.MathUtils.clamp(p.x, -LIMIT, LIMIT);
    p.z = THREE.MathUtils.clamp(p.z, -LIMIT, LIMIT);
    const gy = groundY(p.x, p.z);
    if (gy !== null) p.y = THREE.MathUtils.lerp(p.y, gy, Math.min(1, dt * 20));
    s.blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), groundNormal);
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
        else { scene.remove(a.m); arrows.splice(i, 1); continue; }
      }
      const gy = groundY(q.x, q.z);
      if (gy !== null && q.y <= gy + 0.05) { a.stuck = true; a.age = 0; }   // sticks in the ground
      else if (a.age > 3) a.age = 99;
    }
    if ((a.stuck && a.age > 4) || a.age > 90) { scene.remove(a.m); arrows.splice(i, 1); }
  }
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
}

async function loadEnemies() {
  const kinds = Object.keys(GOBLINS);
  const assets = await Promise.all(kinds.map(async (k) => {
    const atlas = await fetch(`assets/goblin_${k}.json`).then((r) => r.json());
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

// ---------- wireframe toggle (button or F key) ----------
const wireBtn = document.getElementById("wireBtn");
let wire = false;
function setWire(on) {
  wire = on;
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
};
const H = {
  hp: 100, maxHp: 100, st: 100, maxSt: 100, regenWait: 0, stagger: 0, roll: null, dead: false,
  flash: 0, shake: 0, swingHit: false, lag: 100, lagWait: 0, buffered: null,
  knock: new THREE.Vector3(),                   // knockback velocity, decays
};
if (typeof progression !== "undefined") progression.apply(COMBAT, H);   // [progression] saved stats
let hitStop = 0;
const hpFill = document.getElementById("hpFill"), hpLag = document.getElementById("hpLag");
const stFill = document.getElementById("stFill"), stBar = document.getElementById("stBar");
const deathEl = document.getElementById("death");

function bufferAction(a) { H.buffered = { a, t: COMBAT.buffer }; }

// returns "dodged" | "blocked" | "hit" | "ignored"
function damageHero(amount, from) {
  if (H.dead) return "ignored";
  amount *= COMBAT.damageTaken;
  if (H.roll && H.roll.t >= COMBAT.iFrom && H.roll.t <= COMBAT.iTo) return "dodged";
  const p = hero.root.position;
  const toSrc = from.clone().sub(p).setY(0).normalize();
  const guarding = hero.state === "defend" && H.stagger <= 0;
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
  if (typeof progression !== "undefined") progression.onDeath(deathEl);   // [progression] spend screen
  else setTimeout(() => deathEl.addEventListener("click", () => location.reload(), { once: true }), 2000);
}

function updateHud(dt) {
  H.lagWait -= dt;
  if (H.lagWait <= 0) H.lag = Math.max(H.hp, H.lag - 40 * dt);   // the yellow chunk drains after a hit
  hpFill.style.width = `${(H.hp / H.maxHp) * 100}%`;
  hpLag.style.width = `${(H.lag / H.maxHp) * 100}%`;
  stFill.style.width = `${(Math.max(0, H.st) / H.maxSt) * 100}%`;
  stBar.classList.toggle("empty", H.st <= 0);
}

// ---------- main ----------
const LIMIT = 21;
let hero;

function step(dt) {
  if (hitStop > 0) { hitStop -= dt; dt *= 0.05; }       // brief freeze when the sword connects
  if (keys.has("KeyQ")) cam.yaw += dt * 1.8;
  if (keys.has("KeyE")) cam.yaw -= dt * 1.8;

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
      if (a === "attack") {
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

  const defending = !H.dead && keys.has("KeyK") && !hero.attacking && !H.roll && H.stagger <= 0;
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
      const speed = (sprinting ? 5.2 : 3.0) * (busy ? 0.1 : 1);
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
        g.takeHit(COMBAT.heroDmg, p);
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
  hero.mat.color.setRGB(1, H.flash > 0 ? 0.4 : 1, H.flash > 0 ? 0.4 : 1);

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
  updateEnemies(dt, p);
  for (const g of enemies) if (g.sprite.root.visible) g.sprite.update(dt, camera);
  if (dog) { dog.update(dt, p, hero.facing); dog.sprite.update(dt, camera); }
  if (water) water.position.y += Math.sin(performance.now() * 0.0015) * 0.0004;
  dirLabel.textContent = hero.update(dt, camera);
  updateHud(dt);
}

async function main() {
  resize();
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

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    step(Math.min(clock.getDelta(), 0.05));
    composer.render();
  });
}
main();
