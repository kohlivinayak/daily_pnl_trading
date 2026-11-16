/* ==========================================================
   P&L Skyline — a 3D city of trading days.
   x = week, z = weekday (Mon→Fri). Profit days rise as
   glowing towers; loss days sink below a glass floor.
   ========================================================== */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GAIN = new THREE.Color('#3eeaa0');
const LOSS = new THREE.Color('#ff5b70');
const GOLD = new THREE.Color('#f4c56b');
const BG = new THREE.Color('#06070b');
const SPACING = 1.12;
const MAX_H = 5.6;

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

export function createSkyline(canvas, { onHover, reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setClearColor(BG, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 22, 62);

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);

  // ---- lights ----
  scene.add(new THREE.AmbientLight(0x8890b0, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(8, 14, 10);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8f7dff, 0.9);
  rim.position.set(-10, 6, -12);
  scene.add(rim);
  const goldLight = new THREE.PointLight(GOLD, 18, 30, 1.6);
  goldLight.position.set(0, 7, 3);
  scene.add(goldLight);

  // ---- floor: glass slab + grid + soft halo ----
  const floorGroup = new THREE.Group();
  scene.add(floorGroup);

  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshBasicMaterial({ color: 0x0a0d15, transparent: true, opacity: 0.66, depthWrite: false })
  );
  glass.rotation.x = -Math.PI / 2;
  glass.renderOrder = 2;
  floorGroup.add(glass);

  const grid = new THREE.GridHelper(80, 72, 0x2a2f40, 0x161a26);
  grid.position.y = 0.002;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  grid.renderOrder = 3;
  floorGroup.add(grid);

  const haloTex = radialTexture('rgba(244,197,107,0.10)', 'rgba(244,197,107,0)');
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.01;
  halo.renderOrder = 4;
  floorGroup.add(halo);

  // ---- dust particles ----
  const dust = makeDust(520);
  scene.add(dust);

  // ---- post ----
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---- city ----
  let city = new THREE.Group();
  scene.add(city);
  let towers = [];
  let cityCenter = new THREE.Vector3();
  let cityRadius = 8;
  let buildStart = 0;

  const bodyGeoUp = new THREE.BoxGeometry(0.8, 1, 0.8); bodyGeoUp.translate(0, 0.5, 0);
  const bodyGeoDown = new THREE.BoxGeometry(0.8, 1, 0.8); bodyGeoDown.translate(0, -0.5, 0);
  const edgeGeoUp = new THREE.EdgesGeometry(bodyGeoUp);
  const edgeGeoDown = new THREE.EdgesGeometry(bodyGeoDown);
  const capGeo = new THREE.PlaneGeometry(0.8, 0.8); capGeo.rotateX(-Math.PI / 2);

  function setDays(days) {
    // dispose previous city materials
    city.traverse(o => { if (o.material) o.material.dispose(); });
    scene.remove(city);
    city = new THREE.Group();
    scene.add(city);
    towers = [];
    if (!days.length) { cityCenter.set(0, 0, 0); return; }

    const first = mondayOf(days[0].date);
    const maxAbs = Math.max(...days.map(d => Math.abs(d.pnl)), 1);
    const latest = days[days.length - 1].date;
    const spanWeeks = Math.round((mondayOf(days[days.length - 1].date) - first) / (7 * 864e5));
    const maxH = Math.max(MAX_H, spanWeeks * SPACING * 0.2);
    const stagger = Math.min(22, 1600 / days.length);
    let maxWeek = 0;

    days.forEach((d, i) => {
      const dt = new Date(d.date + 'T00:00:00');
      const dow = (dt.getDay() + 6) % 7; // Mon=0
      if (dow > 4) return;
      const week = Math.round((mondayOf(d.date) - first) / (7 * 864e5));
      maxWeek = Math.max(maxWeek, week);

      const up = d.pnl >= 0;
      const col = up ? GAIN : LOSS;
      const h = Math.max(0.06, Math.sqrt(Math.abs(d.pnl) / maxAbs) * maxH);

      const g = new THREE.Group();
      g.position.set(week * SPACING, 0, dow * SPACING);

      const body = new THREE.Mesh(up ? bodyGeoUp : bodyGeoDown, new THREE.MeshStandardMaterial({
        color: col.clone().multiplyScalar(0.18),
        emissive: col, emissiveIntensity: up ? 0.16 : 0.22,
        metalness: 0.55, roughness: 0.28, transparent: true, opacity: 0.92,
      }));
      body.scale.y = h;
      body.userData.idx = towers.length;
      const edges = new THREE.LineSegments(up ? edgeGeoUp : edgeGeoDown, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.55 }));
      edges.scale.y = h;
      const cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.6), transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
      cap.position.y = up ? h + 0.001 : -h - 0.001;

      g.add(body, edges, cap);
      g.scale.y = reducedMotion ? 1 : 0.0001;
      city.add(g);

      towers.push({ group: g, body, edges, cap, day: d, h, up, delay: i * stagger, isLatest: d.date === latest, hover: 0 });
    });

    cityCenter.set((maxWeek * SPACING) / 2, 0, (4 * SPACING) / 2);
    cityRadius = Math.max(6, maxWeek * SPACING * 0.62);
    halo.position.x = cityCenter.x; halo.position.z = cityCenter.z;
    halo.scale.setScalar(Math.max(1, cityRadius / 7));
    goldLight.position.set(cityCenter.x, 7, cityCenter.z + 3);
    dust.position.copy(cityCenter);
    buildStart = performance.now();
  }

  // ---- interaction ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-9, -9);
  let hovered = null;
  let parallaxX = 0, parallaxY = 0, targetPX = 0, targetPY = 0;
  let dragYaw = 0, dragging = false, lastX = 0, dragVel = 0;

  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    targetPX = pointer.x; targetPY = pointer.y;
    if (dragging) {
      const dx = e.clientX - lastX; lastX = e.clientX;
      dragVel = dx * 0.006; dragYaw += dragVel;
    }
  });
  canvas.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', e => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener('pointerleave', () => { pointer.set(-9, -9); targetPX = 0; targetPY = 0; });

  // ---- sizing ----
  let W = 1, H = 1, viewShift = 0;
  function resize() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
    bloom.setSize(W, H);
    camera.aspect = W / H;
    // push the city to the right on wide screens so the headline breathes
    viewShift = W > 900 ? -W * 0.11 : 0;
    if (viewShift) camera.setViewOffset(W, H, viewShift, H > 800 ? -H * 0.02 : 0, W, H); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // ---- loop ----
  let running = true, raf = 0;
  const io = new IntersectionObserver(([en]) => {
    running = en.isIntersecting;
    if (running) { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
  });
  io.observe(canvas);

  const tmp = new THREE.Vector3();
  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const t = now / 1000;

    // grow-in
    for (const tw of towers) {
      if (reducedMotion) break;
      const p = Math.min(1, Math.max(0, (now - buildStart - tw.delay) / 1100));
      tw.group.scale.y = Math.max(0.0001, easeOutBack(p));
    }

    // camera: slow orbit + drag + parallax
    parallaxX += (targetPX - parallaxX) * 0.04;
    parallaxY += (targetPY - parallaxY) * 0.04;
    if (!dragging) { dragVel *= 0.94; dragYaw += dragVel; }
    const yaw = (reducedMotion ? 0 : Math.sin(t * 0.07) * 0.32) + dragYaw + parallaxX * 0.12 - 0.62;
    const dist = cityRadius * 1.25 + 13;
    const height = 9.5 + cityRadius * 0.38 - parallaxY * 1.2;
    scene.fog.near = dist * 0.6;
    scene.fog.far = dist * 2.4;
    camera.position.set(
      cityCenter.x + Math.sin(yaw) * dist,
      height,
      cityCenter.z + Math.cos(yaw) * dist
    );
    camera.lookAt(cityCenter.x, 0.4, cityCenter.z);

    // hover
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(towers.map(x => x.body), false);
    const hit = hits.length ? towers[hits[0].object.userData.idx] : null;
    if (hit !== hovered) {
      hovered = hit;
      canvas.style.cursor = hit ? 'pointer' : (dragging ? 'grabbing' : 'crosshair');
    }
    for (const tw of towers) {
      const target = tw === hovered ? 1 : 0;
      tw.hover += (target - tw.hover) * 0.18;
      const pulse = tw.isLatest ? (Math.sin(t * 3) * 0.5 + 0.5) * 0.35 : 0;
      tw.body.material.emissiveIntensity = (tw.up ? 0.16 : 0.22) + tw.hover * 0.6 + pulse * 0.4;
      tw.edges.material.opacity = 0.55 + tw.hover * 0.45;
      tw.cap.material.opacity = 0.75 + tw.hover * 0.25 + pulse;
      const s = 1 + tw.hover * 0.12;
      tw.group.scale.x = s; tw.group.scale.z = s;
    }
    if (onHover) {
      if (hovered) {
        tmp.set(hovered.group.position.x, hovered.up ? hovered.h * hovered.group.scale.y : 0.2, hovered.group.position.z).project(camera);
        onHover(hovered.day, { x: (tmp.x * 0.5 + 0.5) * W, y: (-tmp.y * 0.5 + 0.5) * H });
      } else onHover(null);
    }

    dust.rotation.y = t * 0.015;
    dust.material.opacity = 0.55 + Math.sin(t * 0.6) * 0.1;

    composer.render();
  }
  raf = requestAnimationFrame(tick);

  return { setDays };
}

/* ---------- helpers ---------- */
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDust(n) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 4 + Math.random() * 22;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * 12 - 2;
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: GOLD, size: 0.06, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  return new THREE.Points(geo, mat);
}
