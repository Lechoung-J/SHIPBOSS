import * as THREE from 'three';
import { createShifts } from './shift.js';
import { createParallelShifts } from './parallel-shifts.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createArchitecturalMaterials } from './materials.js';
import { roomIsIdle, roomTheme, themedFloor, isolateRoomMaterials, createStatusIndicators, createWaitingLamp, createSkillPile } from './room-style.js';

// All scene assets are original procedural geometry; no remote models or textures.
const C = {
  wall: '#bcb9b0', wallEdge: '#d5d1c7', trim: '#484542', base: '#888782',
  floor: '#b2b0a7', wood: '#644334', woodEdge: '#402c25', ivory: '#d9d5ca',
  steel: '#aaa9a2', dark: '#30312f', navy: '#453b35', blue: '#50463f',
  sage: '#574a3b', green: '#66715d', orange: '#bb774f', paper: '#eee8da',
  skin: '#dab997', hair: '#554f46', ink: '#435c61', glass: '#a7c7c6',
};
let architecturalMaterials;
// Idle rooms stay readable at 40% albedo; the transition matches the 0.3s
// requested for state changes so a room never flashes between levels.
const IDLE_LIGHT_SCALE = .4;
const LIGHT_TRANSITION_SECONDS = .3;

export function createOffice(scene, options = {}) {
const parallel = options.parallel === true;
const projectId = options.projectId ?? null;
const theme = roomTheme(projectId, options.themeIndex);
const A = architecturalMaterials ??= createArchitecturalMaterials();
const materials = new Map();
function material(color, opts = {}) {
  if (A && Object.keys(opts).length === 0) {
    if (color === C.wall || color === C.base) return A.concrete;
    if (color === C.wood || color === C.woodEdge) return A.walnut;
    if (color === C.steel) return A.steel;
    if (color === C.dark || color === C.trim) return A.darkMetal;
    if ([C.sage, C.navy, C.blue].includes(color)) return A.leather;
  }
  const key = color + JSON.stringify(opts);
  if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: .9, metalness: 0, ...opts }));
  return materials.get(key);
}
function box(parent, w, h, d, x, y, z, color, opts = {}) {
  const mat = material(color, opts);
  const geo = new THREE.BoxGeometry(w, h, d);
  if (mat.userData.tileSize) {
    const uv = geo.attributes.uv, [tileU, tileV] = mat.userData.tileSize;
    const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    faces.forEach(([u, v], f) => { for (let i = 0; i < 4; i++) { const j = f * 4 + i; uv.setXY(j, uv.getX(j) * u / tileU, uv.getY(j) * v / tileV); } });
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function rounded(parent, w, h, d, x, y, z, mat, radius = .05) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), mat);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function cylinder(parent, rTop, rBottom, h, x, y, z, color, sides = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, sides), material(color));
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function sphere(parent, radius, x, y, z, color, sx = 1, sy = 1, sz = 1) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), material(color));
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.castShadow = true; parent.add(mesh); return mesh;
}
function group(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g;
}
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function plaque(parent, text, w, h, x, y, z, background = '#e8e6d5', color = '#647d7b') {
  box(parent, w + .05, h + .05, .045, x, y, z, C.trim);
  const tex = canvasTexture(768, 160, (ctx, cw, ch) => {
    ctx.fillStyle = background; ctx.fillRect(0, 0, cw, ch); ctx.fillStyle = color;
    ctx.font = '600 64px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, cw / 2, ch / 2 + 3);
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  m.position.set(x, y, z + .028); parent.add(m); return m;
}
function paper(parent, x, y, z, angle = 0, w = .39, d = .5) {
  const p = group(parent, x, y, z); p.rotation.y = angle;
  box(p, w, .016, d, 0, 0, 0, C.paper);
  for (let i = 0; i < 4; i++) box(p, w * (.65 - i % 2 * .14), .002, .012, -.015, .01, -.15 + i * .065, '#a2aaa0');
  return p;
}
function plant(parent, x, y, z, scale = 1) {
  const p = group(parent, x, y, z); p.scale.setScalar(scale);
  cylinder(p, .24, .18, .4, 0, .2, 0, '#b9ae98');
  cylinder(p, .245, .245, .055, 0, .405, 0, '#d9cfb8');
  cylinder(p, .21, .21, .015, 0, .43, 0, '#655f4b');
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.4; const r = .12 + (i % 3) * .06;
    const stem = cylinder(p, .018, .018, .5 + i * .04, Math.cos(angle) * r * .4, .65 + i * .02, Math.sin(angle) * r * .4, '#75856b', 6);
    stem.rotation.z = Math.cos(angle) * .2; stem.rotation.x = Math.sin(angle) * .2;
    const leaf = sphere(p, .2, Math.cos(angle) * r, .85 + i * .04, Math.sin(angle) * r, i % 2 ? '#79936f' : '#8da47c', .65, 1.8, .35);
    leaf.rotation.z = -Math.cos(angle) * .7; leaf.rotation.y = -angle;
  }
  return p;
}
function books(parent, x, y, z, count = 6) {
  const colors = ['#77939b', '#c3aa81', '#b9c3af', '#526d79', '#b1876a', '#a5b6aa'];
  for (let i = 0; i < count; i++) {
    const h = .38 + (i % 3) * .07;
    box(parent, .12, h, .3, x + i * .145, y + h / 2, z, colors[i % colors.length]);
    box(parent, .075, .018, .005, x + i * .145, y + h * .28, z + .153, '#d8d6be');
  }
}
function shelf(parent, x, z, width = 1.65) {
  const g = group(parent, x, 0, z);
  box(g, width, 2.1, .12, 0, 1.1, -.23, C.wood);
  for (const side of [-1, 1]) box(g, .07, 2.18, .55, side * width / 2, 1.13, 0, C.dark);
  for (let j = 0; j < 4; j++) box(g, width, .045, .55, 0, .14 + j * .66, 0, C.steel);
  books(g, -width / 2 + .17, .17, .05, 6); books(g, -width / 2 + .17, .83, .05, 4);
  box(g, .47, .33, .4, width * .24, 1.02, .04, '#b0a79b');
  box(g, .16, .05, .008, width * .24, 1.03, .246, C.paper);
  for (let i = 0; i < 3; i++) box(g, .68, .065, .36, -.2, 1.54 + i * .07, 0, ['#b3ad9c', '#b89874', '#636d6b'][i]);
  plant(g, .48, 2.15, 0, .5); return g;
}
function monitor(parent, x, y, z, variant) {
  box(parent, .55, .035, .32, x, y, z, C.dark);
  box(parent, .08, .22, .08, x, y + .13, z - .05, C.steel);
  box(parent, 1.05, .64, .075, x, y + .52, z, '#344a53');
  const tex = canvasTexture(512, 300, (ctx, w, h) => {
    ctx.fillStyle = '#243d47'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#42606a'; ctx.fillRect(0, 0, w, 27);
    for (let i = 0; i < 3; i++) { ctx.fillStyle = ['#b78c67', '#d5ba86', '#8fab96'][i]; ctx.beginPath(); ctx.arc(14 + i * 15, 13, 4, 0, Math.PI * 2); ctx.fill(); }
    if (variant === 0) {
      ctx.fillStyle = '#c5d0bf'; ctx.fillRect(23, 45, 90, 12);
      for (let col = 0; col < 3; col++) { ctx.fillStyle = '#35545d'; ctx.fillRect(23 + col * 158, 79, 144, 202); for (let j = 0; j < 3 - col % 2; j++) { ctx.fillStyle = ['#9bb3a0', '#c7b68e', '#7d9eaa'][j]; ctx.fillRect(35 + col * 158, 94 + j * 57, 118, 43); } }
    } else if (variant === 1) {
      ctx.fillStyle = '#35535d'; ctx.fillRect(0, 29, 100, h - 29);
      for (let i = 0; i < 12; i++) { ctx.fillStyle = '#718e91'; ctx.fillRect(14, 47 + i * 18, 48 + i % 3 * 10, 5); }
      for (let i = 0; i < 15; i++) { ctx.fillStyle = ['#afbe9a', '#a5c2c0', '#ccae7f', '#82a7b4'][i % 4]; ctx.fillRect(123 + i % 3 * 17, 47 + i * 15, 90 + (i * 41 % 210), 5); }
    } else {
      ctx.fillStyle = '#c8d1be'; ctx.fillRect(26, 47, 220, 12);
      for (let i = 0; i < 6; i++) { ctx.strokeStyle = '#98b59d'; ctx.lineWidth = 4; ctx.strokeRect(28, 85 + i * 31, 14, 14); ctx.fillStyle = '#87a4a5'; ctx.fillRect(58, 89 + i * 31, 230 + i % 3 * 40, 6); }
    }
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(.94, .52), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(x, y + .52, z + .039); parent.add(screen);
  const led = box(parent, .025, .012, .008, x + .45, y + .23, z + .044, '#a1c1a3');
  led.material = led.material.clone(); screen.userData.led = led;
  return screen;
}
function keyboard(parent, x, y, z) {
  box(parent, .75, .035, .25, x, y, z, '#c3c9bc');
  for (let row = 0; row < 3; row++) for (let col = 0; col < 10; col++) box(parent, .05, .009, .04, x - .31 + col * .068, y + .024, z - .08 + row * .061, '#e3e4d4');
  box(parent, .29, .01, .035, x, y + .025, z + .09, '#e3e4d4');
  sphere(parent, .09, x + .55, y + .025, z, '#d8ddcf', .7, .4, 1.2);
}
function chair(parent, x, z, color) {
  const g = group(parent, x, 0, z);
  cylinder(g, .045, .045, .48, 0, .32, 0, C.steel);
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * .4; const foot = box(g, .055, .045, .4, Math.sin(a) * .18, .1, Math.cos(a) * .18, C.dark); foot.rotation.y = a;
    sphere(g, .06, Math.sin(a) * .34, .07, Math.cos(a) * .34, C.dark);
  }
  box(g, .62, .12, .57, 0, .58, 0, color);
  const back = box(g, .6, .57, .1, 0, .96, .26, color); back.rotation.x = -.08;
  for (const s of [-1, 1]) { box(g, .04, .22, .05, s * .35, .76, .05, C.steel); box(g, .09, .055, .35, s * .35, .89, -.01, color); }
  return g;
}
function person(parent, x, z, shirt, hair, variant) {
  const p = group(parent, x, .04, z);
  const hips = box(p, .4, .17, .29, 0, .86, 0, '#536674');
  const legs = [];
  for (const side of [-1, 1]) {
    const thigh = group(p, side * .13, .86, 0);
    box(thigh, .15, .34, .16, 0, -.17, 0, '#536674');
    const knee = group(thigh, 0, -.34, 0);
    box(knee, .14, .34, .15, 0, -.17, 0, '#536674');
    box(knee, .18, .1, .27, 0, -.37, -.055, '#3d4c50');
    legs.push({ thigh, knee });
  }
  const body = group(p, 0, .97, 0);
  cylinder(body, .22, .25, .47, 0, .18, 0, shirt, 6);
  cylinder(body, .065, .07, .13, 0, .48, 0, C.skin, 8);
  const head = group(body, 0, .67, -.025);
  box(head, .29, .35, .29, 0, 0, 0, C.skin);
  box(head, .32, .13, .32, 0, .15, .01, hair);
  box(head, .32, .23, .09, 0, .025, .14, hair);
  box(head, .06, .07, .04, 0, -.015, -.165, C.skin);
  for (const side of [-1, 1]) box(head, .026, .025, .014, side * .075, .035, -.153, '#554f46');
  if (variant === 0) sphere(head, .11, 0, .1, .23, hair, 1, 1, .8);
  if (variant === 2) { box(head, .3, .018, .02, 0, .045, -.17, C.dark); box(body, .035, .23, .012, 0, .22, -.216, '#c6d5c4'); }
  const arms = [];
  for (const side of [-1, 1]) {
    const shoulder = group(body, side * .25, .36, 0);
    box(shoulder, .135, .25, .15, 0, -.125, 0, shirt);
    const elbow = group(shoulder, 0, -.25, 0);
    box(elbow, .115, .23, .13, 0, -.115, 0, shirt);
    box(elbow, .105, .1, .115, 0, -.275, 0, C.skin);
    arms.push({ shoulder, elbow });
  }
  function pose(seated, time, walking, working, still) {
    const gait = walking && !still ? Math.sin(time * 19) : 0;
    const bob = walking && !still ? Math.abs(Math.sin(time * 19)) * .055 : 0;
    hips.position.y = THREE.MathUtils.lerp(.86, .76, seated) + bob;
    body.position.y = THREE.MathUtils.lerp(.97, .91, seated) + bob;
    body.rotation.x = walking && !still ? .1 : working && !still ? .065 + Math.sin(time * 7) * .025 : 0;
    body.rotation.z = walking && !still ? gait * .035 : working && !still ? Math.sin(time * 9) * .015 : 0;
    head.rotation.y = working && !still ? Math.sin(time * 2.4 + variant) * .07 : 0;
    legs.forEach(({ thigh, knee }, i) => {
      thigh.position.y = hips.position.y;
      thigh.rotation.x = THREE.MathUtils.lerp(gait * (i ? -.65 : .65), 1.22, seated);
      knee.rotation.x = THREE.MathUtils.lerp(Math.max(0, gait * (i ? 1 : -1)) * -.35, -1.22, seated);
    });
    arms.forEach(({ shoulder, elbow }, i) => {
      const typing = working && !still ? Math.sin(time * 15 + i * Math.PI) * .13 : 0;
      shoulder.rotation.x = THREE.MathUtils.lerp(gait * (i ? .5 : -.5), .8 + typing, seated);
      elbow.rotation.x = THREE.MathUtils.lerp(.06, .8 - typing * .5, seated);
    });
  }
  pose(0, 0, false, false, true);
  return { root: p, head, pose, snapshot: () => ({
    shoulders: arms.map(a => +a.shoulder.rotation.x.toFixed(4)),
    elbows: arms.map(a => +a.elbow.rotation.x.toFixed(4)),
    thighs: legs.map(l => +l.thigh.rotation.x.toFixed(4)),
    knees: legs.map(l => +l.knee.rotation.x.toFixed(4)),
    body: +body.rotation.x.toFixed(4), headX: +head.rotation.x.toFixed(4), headY: +head.rotation.y.toFixed(4),
  }) };
}
function paperStack(parent, x, y, z, width = .43, depth = .35) {
  const stack = group(parent, x, y, z);
  const layers = [];
  for (let i = 0; i < 12; i++) {
    const layer = group(stack, (i % 3 - 1) * .009, 0, (i % 2) * .008);
    box(layer, width, .037, depth, 0, .0185, 0, i % 4 === 0 ? '#d9c49d' : C.paper);
    box(layer, width * .88, .003, .004, 0, .015, depth / 2 + .002, '#bcc3b5');
    if (i % 3 === 0) box(layer, .08, .009, .055, width * .3, .033, depth / 2, '#a7b9aa');
    layers.push(layer);
  }
  let amount = 0;
  function setAmount(value) {
    amount = THREE.MathUtils.clamp(value, 0, 12);
    layers.forEach((layer, i) => { const fraction = THREE.MathUtils.clamp(amount - i, 0, 1); layer.visible = fraction > .001; layer.position.y = i * .04; layer.scale.y = Math.max(.001, fraction); });
  }
  setAmount(0);
  return { root: stack, setAmount, get amount() { return amount; } };
}
function desk(parent, x, z, index, topMaterial = A.travertine) {
  const g = group(parent, x, 0, z); const deskWidth = 3.1;
  rounded(g, deskWidth, .17, 1.4, 0, 1.01, 0, topMaterial, .025);
  box(g, 2.94, .045, 1.28, 0, .905, 0, C.dark);
  box(g, .61, .84, 1.12, -1.1, .5, 0, C.wood);
  for (let i = 0; i < 3; i++) { box(g, .54, .25, .03, -1.1, .25 + i * .27, .575, C.wood); box(g, .24, .018, .025, -1.1, .35 + i * .27, .603, C.dark); }
  rounded(g, .18, .85, 1.14, 1.32, .5, 0, A.concrete, .014);
  box(g, 1.9, .04, .045, .23, .82, -.57, C.steel);
  const screen = monitor(g, -.1, 1.11, -.31, index); keyboard(g, -.1, 1.11, .26);
  paper(g, .96, 1.1, .28, -.08);
  // Stackable inbox with a visible lip.
  box(g, .52, .035, .46, -1.12, 1.12, .27, C.steel);
  for (const s of [-1, 1]) box(g, .025, .09, .46, -1.12 + s * .25, 1.16, .27, C.steel);
  const stack = paperStack(g, -1.12, 1.15, .24);
  cylinder(g, .075, .065, .19, .7, 1.19, -.38, index === 1 ? '#c2a077' : '#b2a18a');
  const handle = new THREE.Mesh(new THREE.TorusGeometry(.05, .015, 5, 10), material('#b2a18a')); handle.position.set(.79, 1.2, -.38); g.add(handle);
  // Compact articulated desk lamp.
  cylinder(g, .16, .17, .035, 1.19, 1.12, -.43, C.dark);
  const pole = cylinder(g, .018, .018, .52, 1.19, 1.39, -.43, C.steel, 8); pole.rotation.z = -.2;
  const arm = cylinder(g, .018, .018, .38, 1.09, 1.69, -.43, C.steel, 8); arm.rotation.z = .9;
  const shade = cylinder(g, .07, .17, .14, .93, 1.76, -.43, C.dark); shade.rotation.z = .2;
  cylinder(g, .145, .145, .008, .916, 1.69, -.43, '#f2d3a0');
  const light = sphere(g, .055, -1.35, 1.14, -.38, '#abb8a1');
  light.material = material('#abb8a1').clone();
  chair(parent, x - .1, z + 1.14, [C.sage, C.navy, C.blue][index]);
  const character = person(parent, x - .1, z + 1.12, ['#ae8057', '#788e98', '#c8c8b5'][index], ['#6d5945', '#424b4a', '#8b8070'][index], index);
  return { root: g, screen, light, character, stack, x, z };
}
function whiteboard(parent, x, dark = true) {
  box(parent, 2.4, 1.17, .065, x, 2.05, -4.72, C.steel);
  box(parent, 2.3, 1.07, .02, x, 2.05, -4.674, dark ? '#353b38' : '#e2e3da');
  box(parent, 2.35, .04, .12, x, 1.48, -4.64, C.steel);
  for (let col = 0; col < 3; col++) {
    box(parent, .55, .04, .008, x - .76 + col * .76, 2.43, -4.659, ['#9eafaa', '#b4a384', '#8daca5'][col]);
    for (let row = 0; row < 2; row++) {
      const note = box(parent, .31, .25, .009, x - .9 + col * .76 + row * .13, 2.15 - row * .36, -4.655, ['#d5c18e', '#b9cbc1', '#cba994'][(row + col) % 3]); note.rotation.z = .025 * (col - 1);
      for (let j = 0; j < 2; j++) box(parent, .19, .012, .006, note.position.x, note.position.y + .04 - j * .07, -4.646, '#a9a990');
    }
  }
}
function windowUnit(parent, x) {
  box(parent, 3.75, 1.75, .2, x, 2.05, -4.76, C.dark);
  const sky = canvasTexture(512, 256, (ctx, w, h) => {
    const grad = ctx.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, '#bdc5c5'); grad.addColorStop(1, '#e3ded0'); ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) { ctx.fillStyle = i % 2 ? '#bdc3be' : '#b5bdb9'; ctx.fillRect(i * 84 - 30, 150 + i % 3 * 20, 65, 110); }
  });
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(3.56, 1.56), new THREE.MeshBasicMaterial({ map: sky })); pane.position.set(x, 2.05, -4.65); parent.add(pane);
  return pane;
  for (let i = 0; i < 3; i++) box(parent, .055, 1.6, .1, x - 1.78 + i * 1.78, 2.05, -4.6, C.steel);
  rounded(parent, 3.95, .14, .4, x, 1.13, -4.57, A.concrete, .02);
  plant(parent, x - 1.25, 1.21, -4.57, .39);
}
function copier(parent, x, z) {
  const p = group(parent, x, 0, z);
  box(p, .9, .81, .73, 0, .44, 0, '#ccd2c5'); box(p, .96, .15, .77, 0, .91, 0, '#e3e5d6');
  box(p, .74, .055, .57, -.04, 1.014, -.03, '#849b99');
  box(p, .63, .03, .47, -.04, 1.05, -.05, '#dce0d2');
  box(p, .68, .12, .035, 0, .73, .383, '#536d73');
  box(p, .72, .25, .025, 0, .29, .38, '#dfe1d2'); box(p, .26, .025, .03, 0, .37, .4, '#82978f');
  box(p, .19, .01, .12, .32, 1, .26, '#3f616c'); paper(p, 0, .68, .47, 0, .48, .3); return p;
}
function deliveryTray(parent) {
  const g = group(parent, 4.5, 0, 3.25);
  rounded(g, 1.86, .76, .9, 0, .46, 0, A.walnut, .13);
  rounded(g, 2.04, .12, 1.05, 0, .9, 0, A.travertine, .16);
  box(g, 1.56, .08, .68, 0, .09, 0, C.dark);
  for (let i = 0; i < 14; i++) box(g, .012, .65, .015, -.78 + i * .12, .48, .45, C.woodEdge);
  box(g, .92, .025, .59, 0, .98, 0, C.steel);
  for (const side of [-1, 1]) box(g, .025, .08, .59, side * .45, 1.01, 0, C.steel);
  plaque(g, 'DELIVERED', .92, .15, 0, .66, .463, '#44332b', '#ddd1b7');
  return g;
}
function entrance(parent) {
  // The opening is a real gap in the wall. The door swings into free corridor space.
  const frame = group(parent, -7.02, .04, .35);
  box(frame, .28, 2.6, .11, 0, 1.3, 0, C.dark);
  box(frame, .28, 2.6, .11, 0, 1.3, 1.8, C.dark);
  box(frame, .28, .12, 1.91, 0, 2.61, .9, C.dark);
  box(frame, .36, .04, 1.8, 0, .02, .9, C.steel);
  const hinge = group(frame, .02, 0, .055);
  box(hinge, .075, 2.49, 1.69, 0, 1.27, .845, C.wood);
  box(hinge, .084, 1.04, .67, 0, 1.68, .845, C.dark);
  box(hinge, .09, .91, .54, 0, 1.68, .845, '#bed1c7');
  box(hinge, .09, .04, .65, 0, 1.68, .845, C.steel);
  box(hinge, .13, .24, .06, .08, 1.06, 1.43, C.dark);
  box(hinge, .18, .045, .21, .12, 1.1, 1.36, '#c2b597');
  const sign = group(parent, -6.83, 2.96, 1.25); sign.rotation.y = Math.PI / 2;
  plaque(sign, 'STAFF / IN-OUT', 1.55, .23, 0, 0, 0, '#3d3a34', '#f0edda');
  box(parent, 2.15, .38, 2.65, -8.12, -.24, 1.25, C.base);
  box(parent, 2.15, .08, 2.65, -8.12, -.015, 1.25, '#aaa89f');
  box(parent, 1.25, .02, 1.35, -7.88, .04, 1.25, '#706a5f');
  return { hinge };
}

  const room = group(scene);
  room.userData.projectId = projectId;
  room.userData.themeIndex = theme.index;
  room.userData.themeName = parallel ? theme.name : 'Original study';
  const hitTargets = [];
  const windowPanes = [];
  let waitingState = false;
  // Idle rooms use a room-local light scale rather than the global exposure,
  // so neighbouring busy rooms keep their normal brightness.
  let idleScale = 1, idleTarget = 1, dimInitialized = false, projectStatus = null, fadeFrom = 1, fadeStartedAt = 0;
  let environment = { windowTint: '#ffffff', interiorIntensity: 0 };
  const interiorLight = new THREE.PointLight('#ffcf9a', 0, 14.5, 2);
  interiorLight.position.set(0, 3.05, -.4); room.add(interiorLight);
  function applyEnvironment() {
    const tint = environment.windowTint instanceof THREE.Color ? environment.windowTint : new THREE.Color(environment.windowTint);
    windowPanes.forEach(pane => pane.material.color.copy(tint).multiplyScalar(waitingState ? .14 : idleScale));
    interiorLight.intensity = waitingState ? 0 : environment.interiorIntensity * idleScale;
  }
  function setEnvironment(next) {
    environment = { ...environment, ...next };
    applyEnvironment();
  }
  box(room, 14.35, .38, 10.35, 0, -.24, 0, C.base);
  box(room, 14.25, .08, 10.25, 0, -.015, 0, '#a0b0aa');
  const floorGeo = new THREE.PlaneGeometry(14, 10);
  const floorUV = floorGeo.attributes.uv;
  for (let i = 0; i < floorUV.count; i++) floorUV.setXY(i, floorUV.getX(i) * 14 / 2.4, floorUV.getY(i) * 10 / 2.4);
  const floor = new THREE.Mesh(floorGeo, parallel ? themedFloor(theme, A) : A.floor);
  floor.userData.kind = 'project-floor'; floor.userData.projectId = projectId;
  floor.rotation.x = -Math.PI / 2; floor.position.y = .035; floor.receiveShadow = true; room.add(floor);
  // Fine expansion joints in a continuous honed-concrete floor.
  if (!parallel || theme.index === 1) {
    for (let x = -3.5; x < 7; x += 3.5) box(room, .012, .003, 10, x, .039, 0, '#96958e');
    for (const z of [-1.65, 1.68]) box(room, 14, .003, .012, 0, .039, z, '#96958e');
  }
  // Full-height cutaway walls retain the same entrance and walking routes.
  box(room, 14.2, 3.35, .34, 0, 1.71, -5.02, C.wall);
  box(room, 13.82, 3.1, .06, 0, 1.67, -4.813, C.wood);
  for (let x = -6.3; x <= 6.3; x += 1.4) box(room, .013, 3.1, .008, x, 1.67, -4.777, C.woodEdge);
  box(room, .32, 3.35, 5.45, -7.02, 1.71, -2.375, C.wall);
  box(room, .32, 3.35, 2.95, -7.02, 1.71, 3.625, C.wall);
  box(room, .32, .73, 1.8, -7.02, 3.02, 1.25, C.wall);
  const door = entrance(room);
  box(room, 14.35, .1, .4, 0, 3.44, -5.02, C.wallEdge);
  box(room, .4, .1, 10.2, -7.02, 3.44, 0, C.wallEdge);
  box(room, 14, .075, .035, 0, .14, -4.75, C.dark);
  for (const z of [-4.92, -2.2, .2, 2.3, 4.9]) {
    box(room, .012, 3.1, .009, -6.85, 1.7, z, '#96948a');
    for (const y of [.42, 2.9]) {
      const tie = cylinder(room, .035, .035, .005, -6.848, y, z + .07, '#939188', 12); tie.rotation.z = Math.PI / 2;
    }
  }
  for (const x of (parallel ? [-3.4, 0, 3.4] : [-2.25, 2.25])) {
    rounded(room, .24, 1.38, 2.8, x, .74, -3.45, A.concrete, .018);
    box(room, .26, .055, 2.84, x, 1.46, -3.45, C.wood);
  }
  const swappedWalls = parallel && theme.index === 1;
  whiteboard(room, swappedWalls ? 5.1 : -4.6, !parallel || theme.board === 'blackboard');
  windowPanes.push(windowUnit(room, 0)); shelf(room, swappedWalls ? -4.7 : 5.65, -4.42, 1.85);
  plaque(room, 'S H I P B O S S   /   A T E L I E R', 3.65, .21, -.1, 3.19, -4.73, '#48342b', '#d4c5a9');
  // Side-wall framed drawings and clock.
  const wallArt = group(room, -6.81, 2.1, -1.3); wallArt.rotation.y = Math.PI / 2;
  plaque(wallArt, parallel ? ['MAKE IT SHIP.', 'BUILD / TEST / LEARN', 'IDEAS INTO OBJECTS'][theme.index] : 'MAKE IT SHIP.', 1.7, .4, 0, .35, 0, ['#363835', '#47535a', '#735b43'][parallel ? theme.index : 0], '#d7d0be');
  box(wallArt, 1.72, .9, .05, 0, -.38, 0, '#b5a080'); box(wallArt, 1.6, .78, .02, 0, -.38, .04, '#e9e4cd');
  for (let i = 0; i < 4; i++) box(wallArt, 1.2 - i * .19, .025, .01, -.1, -.15 - i * .15, .055, '#a2b5a8');
  const clock = group(room, swappedWalls ? -3.15 : 3.5, 2.5, -4.72);
  const clockFace = cylinder(clock, .27, .27, .045, 0, 0, 0, '#657f7c', 32); clockFace.rotation.x = Math.PI / 2;
  const face = cylinder(clock, .23, .23, .05, 0, 0, .01, '#eae8d4', 32); face.rotation.x = Math.PI / 2;
  box(clock, .022, .16, .014, 0, .065, .041, '#526c69'); const hand = box(clock, .12, .022, .014, .05, 0, .041, '#526c69'); hand.rotation.z = -.4;
  plant(room, -6.1, .05, -4.35, 1.18); plant(room, 6.25, .05, 3.83, 1.13);
  // Leather lounge chairs on a woven rug, with a monolithic stone coffee table.
  const lounge = group(room, -4.7, .05, 3.5);
  rounded(lounge, 2.8, .025, 1.95, 0, 0, 0, A.rug, .025);
  if (parallel && theme.lounge === 'sofa') {
    rounded(lounge, 2.6, .26, .82, 0, .43, -.27, A.leather, .1);
    for (const x of [-.73, .73]) rounded(lounge, 1.18, .1, .77, x, .56, -.27, A.leather, .065);
    const back = rounded(lounge, 2.58, .61, .2, 0, .8, -.62, A.leather, .085); back.rotation.x = -.13;
    for (const side of [-1, 1]) {
      rounded(lounge, .16, .27, .7, side * 1.25, .67, -.26, A.leather, .065);
      for (const z of [-.56, .08]) box(lounge, .045, .34, .045, side * 1.12, .18, z, C.steel);
    }
    cylinder(lounge, .48, .48, .06, 0, .42, .62, C.wood, 32);
    cylinder(lounge, .09, .13, .35, 0, .23, .62, C.steel, 16);
  } else {
    for (const x of [-.73, .73]) {
      rounded(lounge, 1.02, .25, .82, x, .43, -.27, A.leather, .11);
      const back = rounded(lounge, .97, .61, .2, x, .77, -.62, A.leather, .085); back.rotation.x = -.13;
      for (const side of [-1, 1]) {
        rounded(lounge, .16, .23, .67, x + side * .45, .64, -.26, A.leather, .065);
        for (const z of [-.56, .08]) box(lounge, .035, .34, .035, x + side * .37, .18, z, C.steel);
      }
    }
    rounded(lounge, 1.1, .33, .58, 0, .24, .62, A.concrete, .035);
    box(lounge, 1.13, .028, .6, 0, .42, .62, C.steel);
  }
  const restPositions = { 'eng-a': new THREE.Vector3(-5.43, .04, 3.23), 'eng-b': new THREE.Vector3(-3.97, .04, 3.23) };
  const shiftOptions = { restPositions, pacingCorridor: { minX: -2, maxX: 2, z: 2.1 } };
  paper(lounge, .14, .445, .66, .2, .29, .32); cylinder(lounge, .058, .05, .13, -.28, .51, .6, '#b49e7b');
  copier(room, 3.25, -4.25);
  // Move the cooler away from the new doorway.
  const cooler = group(room, 0, 0, -4.1);
  box(cooler, .64, .88, .64, -6.5, .49, 1.1, '#dfe2d3');
  box(cooler, .39, .29, .03, -6.5, .7, 1.435, '#8a9e9d');
  cylinder(cooler, .23, .23, .43, -6.5, 1.17, 1.1, '#a7c3c1'); cylinder(cooler, .12, .12, .1, -6.5, 1.43, 1.1, '#b5ceca');
  box(cooler, .055, .04, .08, -6.59, .77, 1.48, '#8d9eaa'); box(cooler, .055, .04, .08, -6.42, .77, 1.48, '#bda78f');
  const desks = (parallel ? [-5.1, -1.7, 1.7, 5.1] : [-4.5, 0, 4.5]).map((x, i) => desk(room, x, -1.45, parallel ? [0, 1, 1, 2][i] : i, parallel ? A[theme.tops[i]] : A.travertine));
  desks.forEach((d, i) => {
    const hit = box(room, parallel ? 3.2 : 3.7, 2.3, 3.5, d.x, 1.15, -1, '#ffffff');
    hit.material = new THREE.MeshBasicMaterial({ visible: false }); hit.visible = false; hit.castShadow = false; hit.receiveShadow = false;
    hit.userData.kind = 'station'; hit.userData.index = i; hit.userData.projectId = projectId; hitTargets.push(hit);
  });
  const tray = deliveryTray(room);
  const trayHit = box(room, 1.7, 1.5, 1.2, 4.5, .75, 3.25, '#ffffff'); trayHit.material = new THREE.MeshBasicMaterial({ visible: false }); trayHit.visible = false; trayHit.castShadow = false; trayHit.userData.kind = 'delivery'; trayHit.userData.projectId = projectId; hitTargets.push(trayHit);
  const deliveryStack = paperStack(tray, 0, 1.005, 0, .66, .47);
  const deliveryReady = sphere(tray, .045, .58, 1.01, .22, '#77947d');
  deliveryReady.visible = false;
  const seal = group(room, 5.45, 1.12, -1.04);
  box(seal, .19, .07, .15, 0, 0, 0, C.dark); cylinder(seal, .055, .045, .14, 0, .1, 0, '#a88e69'); sphere(seal, .07, 0, .19, 0, '#b29b74', 1, .65, 1);
  // Flat station marker highlights are temporary and never obscure the furniture.
  const selection = new THREE.Mesh(new THREE.PlaneGeometry(3.86, 3.8), new THREE.MeshBasicMaterial({ color: '#f4dc9d', transparent: true, opacity: .16, depthWrite: false }));
  selection.rotation.x = -Math.PI / 2; selection.position.y = .068; selection.visible = false; room.add(selection);
  const anchors = desks.map(d => new THREE.Vector3(d.x - .1, 1.99, d.z - .31));
  const deliveryAnchor = new THREE.Vector3(4.5, .08, 4.13);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (parallel) {
    const scribeCharacter = person(room, -8.55, 1.25, '#5c6f70', '#3f3a34', 2);
    scribeCharacter.root.userData.kind = 'scribe'; scribeCharacter.root.userData.projectId = projectId;
    const statusIndicators = createStatusIndicators(room, [...desks, { character: scribeCharacter }], projectId);
    const waitingLamp = createWaitingLamp(room, desks[0]);
    desks[0].screen.material.userData.waitingExempt = true;
    const roomMaterials = isolateRoomMaterials(room);
    const shifts = createParallelShifts([...desks, { id: 'recording', character: scribeCharacter }], door, reducedMotion, shiftOptions);
    const recorder = { snapshot: () => shifts.snapshot().find(a => a.id === 'recording') };
    const stacks = [...desks.map(d => d.stack), deliveryStack];
    const skillPile = createSkillPile(room);
    const slots = ['pm', 'eng-a', 'eng-b', 'verifier'];
    let bindings = [], targets = [0, 0, 0, 0, 0], time = 0, lastTime = 0, waiting = false, presenceIdleConflict = false;
    function applyLighting() {
      roomMaterials.apply(waiting, idleScale);
      waitingState = waiting;
      applyEnvironment();
    }
    function setProject(project, immediate = false) {
      roomMaterials.restore();
      projectStatus = project.status;
      presenceIdleConflict = project.isIdle === true && !roomIsIdle(project);
      const nextTarget = roomIsIdle(project) ? IDLE_LIGHT_SCALE : 1;
      if (nextTarget !== idleTarget) { fadeFrom = idleScale; fadeStartedAt = performance.now(); }
      idleTarget = nextTarget;
      // New rooms start at the correct level; subsequent status changes fade.
      if (!dimInitialized) { idleScale = idleTarget; dimInitialized = true; }
      waiting = Boolean(project.needsAttention || project.awaitingUser);
      bindings = slots.map(id => project.actors.find(actor => actor.id === id) ?? { id, active: false, papers: 0 });
      shifts.sync([...bindings, { id: 'recording', active: Boolean(project.recording),
        motion: 'reading', uncertain: project.recordingUncertain === true }]);
      targets = [...bindings.map(actor => Math.min(12, Math.max(0, actor.papers || 0) * 5)), Math.min(12, project.reports.length * 3)];
      if (immediate || reducedMotion) stacks.forEach((stack, i) => stack.setAmount(targets[i]));
      deliveryReady.visible = project.reports.length > 0;
      desks.forEach((desk, i) => {
        const active = bindings[i].active;
        desk.screen.material.color.setScalar(active ? 1.4 : .01);
        desk.screen.userData.led.material.color.set(active ? '#a6d5b7' : '#526660');
        desk.light.material.color.set(active ? '#e7b46c' : '#a7b5a5');
        desk.light.material.emissive.set(active ? '#a47935' : '#000000'); desk.light.material.emissiveIntensity = .15;
      });
      roomMaterials.capture(); waitingLamp.setWaiting(waiting); applyLighting();
      skillPile.setCount(project.skillsUsed);
      statusIndicators.update(bindings, waiting, reducedMotion ? 0 : time);
    }
    function update(now) {
      time = now; const delta = Math.max(0, Math.min(.12, time - lastTime)); lastTime = time;
      if (idleScale !== idleTarget) {
        // Wall time avoids stretching the fade at idle FPS or in offscreen rooms.
        const progress = Math.min(1, (performance.now() - fadeStartedAt) / (LIGHT_TRANSITION_SECONDS * 1000));
        idleScale = THREE.MathUtils.lerp(fadeFrom, idleTarget, progress);
        applyLighting();
      }
      stacks.forEach((stack, i) => stack.setAmount(reducedMotion ? targets[i] : THREE.MathUtils.damp(stack.amount, targets[i], 4, delta)));
      shifts.update(time, delta);

      statusIndicators.update(bindings, waiting, reducedMotion ? 0 : time);
    }
    function snapshot() {
      const indicators = statusIndicators.snapshot();
      return { characters: shifts.snapshot().filter(a => a.id !== 'recording'), scribe: recorder.snapshot(), screens: bindings.map(actor => actor.active), stacks: stacks.map(stack => +stack.amount.toFixed(2)), slots, doorAngle: door.hinge.rotation.y, projectId, status: projectStatus, presenceIdleConflict, idle: idleTarget === IDLE_LIGHT_SCALE, dimmed: idleScale < .999, lightScale: +idleScale.toFixed(3), theme: theme.index, themeName: theme.name, floorStyle: theme.floor, waiting, skillsUsed: skillPile.count, skillBoxesShown: skillPile.shown, ...indicators, statusIndicators: indicators };
    }
    function select(index) { selection.visible = index !== null; if (index !== null) { selection.scale.x = .84; selection.position.set(desks[index].x, .068, -1.45); } }
    return { room, hitTargets, anchors, deliveryAnchor, setProject, update, select, snapshot, slots, statusIndicators, skillPile, recorder, setEnvironment, getHeadAnchor: statusIndicators.getHeadAnchor };
  }
  isolateRoomMaterials(room);
  const shifts = createShifts(desks, door, reducedMotion, shiftOptions);
  const stacks = [...desks.map(d => d.stack), deliveryStack];
  let currentStage = -1, elapsed = 0, lastTime = 0, transferStart = 0;
  let stackFrom = [0, 0, 0, 0], stackTo = [0, 0, 0, 0];
  function setStage(stage) {
    const initial = currentStage === -1;
    currentStage = stage; transferStart = elapsed;
    stackFrom = stacks.map(stack => stack.amount);
    stackTo = [0, 0, 0, 0]; stackTo[stage === 3 ? 0 : stage === 4 ? 3 : stage] = 12;
    if (initial || reducedMotion) { stackFrom = [...stackTo]; stacks.forEach((stack, i) => stack.setAmount(stackTo[i])); }
    shifts.setRole(stage === 3 ? 0 : stage < 3 ? stage : -1);
    deliveryReady.visible = stage === 4;
    desks.forEach((d, i) => {
      const active = i === (stage === 3 ? 0 : stage < 3 ? stage : -1);
      d.screen.material.color.setScalar(active ? 1.3 : .018);
      d.screen.userData.led.material.color.set(active ? '#9fc9b1' : '#526660');
      d.light.material.color.set(active ? '#e7b46c' : '#a7b5a5');
      d.light.material.emissive.set(active ? '#a47935' : '#000000'); d.light.material.emissiveIntensity = .15;
    });
  }
  function update(time) {
    elapsed = time; const delta = Math.max(0, Math.min(.05, time - lastTime)); lastTime = time;
    const t = reducedMotion ? 1 : THREE.MathUtils.clamp((time - transferStart) / 1.65, 0, 1);
    const smooth = t * t * (3 - 2 * t);
    stacks.forEach((stack, i) => stack.setAmount(THREE.MathUtils.lerp(stackFrom[i], stackTo[i], smooth)));
    shifts.update(time, delta);
  }
  function settled() { return shifts.settled() && (reducedMotion || elapsed - transferStart >= 1.65); }
  function snapshot() {
    return { characters: shifts.snapshot(), stacks: stacks.map(s => +s.amount.toFixed(3)), screens: desks.map((d, i) => i === (currentStage === 3 ? 0 : currentStage < 3 ? currentStage : -1)), doorAngle: +door.hinge.rotation.y.toFixed(3), settled: settled(), reportReady: currentStage >= 3 };
  }
  function select(index) { selection.visible = index !== null; if (index !== null) selection.position.set(desks[index].x, .068, -1.45); }
  waitingState = false; applyEnvironment();
  return { room, hitTargets, anchors, deliveryAnchor, setStage, update, select, settled, snapshot, setEnvironment };
}
