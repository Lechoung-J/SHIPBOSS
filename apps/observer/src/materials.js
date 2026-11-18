import {
  CanvasTexture,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

// Original, deterministic surfaces. No scene imports, assets, or network requests.
const SIZE = 512;
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Periodic interpolated noise avoids both hard tile edges and white-noise grain.
function noise(seed, columns = 16, rows = columns) {
  const rng = random(seed);
  const grid = Float32Array.from({ length: columns * rows }, () => rng() * 2 - 1);
  const wrap = (n, size) => ((n % size) + size) % size;
  return (u, v) => {
    const x = u * columns;
    const y = v * rows;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const at = (dx, dy) => grid[wrap(iy + dy, rows) * columns + wrap(ix + dx, columns)];
    return mix(mix(at(0, 0), at(1, 0), fx), mix(at(0, 1), at(1, 1), fx), fy);
  };
}

function canvas() {
  const image = document.createElement('canvas');
  image.width = SIZE;
  image.height = SIZE;
  return image;
}

function texture(image, colorSpace) {
  const map = new CanvasTexture(image);
  map.colorSpace = colorSpace;
  map.wrapS = map.wrapT = RepeatWrapping;
  map.repeat.set(1, 1);
  // The renderer clamps this to hardware support; useful on isometric floors.
  map.anisotropy = 8;
  return map;
}

function seamDistance(coordinate, divisions) {
  const fraction = ((coordinate * divisions) % 1 + 1) % 1;
  return Math.min(fraction, 1 - fraction) / divisions;
}

function groove(distance, width) {
  return 1 - smooth(clamp(distance / width, 0, 1));
}

// Each field supplies grayscale albedo, linear height, and linear roughness.
// Albedo stays near white so the material's chosen base color remains readable.
function surface({ name, color, roughness, metalness = 0, bumpScale, tileSize, direction, field, details }) {
  const images = [canvas(), canvas(), canvas()];
  const contexts = images.map((image) => image.getContext('2d'));
  const pixels = contexts.map((context) => context.createImageData(SIZE, SIZE));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const samples = field(x / SIZE, y / SIZE);
      const offset = (y * SIZE + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = Math.round(clamp(samples[channel], 0, 255));
        const data = pixels[channel].data;
        data[offset] = data[offset + 1] = data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }
  }
  contexts.forEach((context, index) => context.putImageData(pixels[index], 0, 0));
  if (details) details(contexts);
  const maps = images.map((image, index) => texture(image, index === 0 ? SRGBColorSpace : NoColorSpace));
  maps.forEach((map, index) => { map.name = `${name}-${['albedo', 'height', 'roughness'][index]}`; });
  const material = new MeshStandardMaterial({
    name,
    color,
    roughness,
    metalness,
    map: maps[0],
    bumpMap: maps[1],
    bumpScale,
    roughnessMap: maps[2],
  });
  material.userData.tileSize = tileSize;
  material.userData.direction = direction;
  material.userData.mapping = 'For face width W and height H in meters, set every map.repeat to (W / tileSize[0], H / tileSize[1]).';
  return material;
}

// Tiny, soft pores placed sparsely; deliberately no full-surface random grit.
function pores(contexts, seed, count, radius, stretch = 1, opacity = 0.2) {
  const rng = random(seed);
  for (let i = 0; i < count; i++) {
    const x = rng() * SIZE;
    const y = rng() * SIZE;
    const r = radius * (0.3 + rng() * 0.7);
    const angle = rng() * Math.PI;
    contexts.forEach((context, channel) => {
      context.fillStyle = channel === 0
        ? `rgba(83,80,75,${opacity * 0.55})`
        : channel === 1 ? `rgba(34,34,34,${opacity})` : `rgba(255,255,255,${opacity})`;
      // Copy over boundaries to keep all three maps seamless.
      for (const dx of [-SIZE, 0, SIZE]) {
        for (const dy of [-SIZE, 0, SIZE]) {
          if (x + dx + r * stretch < 0 || x + dx - r * stretch > SIZE || y + dy + r * stretch < 0 || y + dy - r * stretch > SIZE) continue;
          context.beginPath();
          context.ellipse(x + dx, y + dy, r * stretch, r, angle, 0, TAU);
          context.fill();
        }
      }
    });
  }
}

/**
 * Create once per scene, then reuse the eight named MeshStandardMaterials.
 *
 * Usage:
 *   const finishes = createArchitecturalMaterials();
 *   wall.material = finishes.concrete;
 *   cabinet.material = finishes.walnut;
 *
 * Mapping: +U runs across panels; +V follows walnut grain / steel brushing.
 * BoxGeometry wall front/side faces normally put V along world Y. A horizontal
 * slab's top face puts V along its depth. Use geometry UVs to orient individual
 * faces; changing texture rotation affects every mesh sharing that texture.
 *
 * userData.tileSize gives [U, V] meters per texture tile. Default repeat is 1×1:
 * concrete 2.4×2.4, floor 2.4×2.4 (four 1.2 m slabs), walnut 1.2×2.4 (four
 * 0.3 m panels), steel/darkMetal 0.6×0.6, leather 0.24×0.24, travertine 1.2×1.2,
 * rug 0.32×0.32. For physically consistent scaling, adjust geometry UVs by
 * face size / tileSize, or set identical repeat values on map, bumpMap, and
 * roughnessMap. Clone all three textures as well as the material when an
 * instance needs independent repeats/rotation (Material.clone shares maps).
 *
 * bumpMap and roughnessMap are untagged linear data (NoColorSpace), while
 * albedo is sRGB. Bump scales assume scene units are approximately meters.
 * Dispose materials AND their three textures when removing the scene.
 */
export function createArchitecturalMaterials() {
  const concreteCloud = noise(101, 7);
  const concreteFine = noise(102, 86);
  const concrete = surface({
    name: 'Architectural / cast concrete', color: '#c2beb3',
    roughness: 0.88, bumpScale: 0.018, tileSize: [2.4, 2.4],
    direction: 'Casting joints along U and V; one 2.4 m formwork panel per tile.',
    field(u, v) {
      const cloud = concreteCloud(u, v);
      const fine = concreteFine(u, v);
      const seam = Math.max(groove(seamDistance(u, 1), 0.0035), groove(seamDistance(v, 1), 0.0035));
      // Four restrained circular form-tie recesses, not decorative polka dots.
      const tieX = Math.min(Math.abs(u - 0.18), Math.abs(u - 0.82));
      const tieY = Math.min(Math.abs(v - 0.18), Math.abs(v - 0.82));
      const tie = groove(Math.hypot(tieX, tieY), 0.005);
      return [247 + cloud * 4 + fine * 1.5 - seam * 26 - tie * 15,
        133 + cloud * 8 + fine * 6 - seam * 48 - tie * 55,
        245 + fine * 5 + seam * 8];
    },
    details: (contexts) => pores(contexts, 103, 560, 1.2, 1, 0.26),
  });

  const stoneCloud = noise(201, 9);
  const stoneFine = noise(202, 128);
  const floor = surface({
    name: 'Architectural / honed aggregate floor', color: '#b0afa9',
    roughness: 0.76, bumpScale: 0.012, tileSize: [2.4, 2.4],
    direction: 'Two by two 1.2 m slabs per tile; map U/V onto floor X/Z.',
    field(u, v) {
      const cloud = stoneCloud(u, v);
      const fine = stoneFine(u, v);
      const seam = Math.max(groove(seamDistance(u, 2), 0.0028), groove(seamDistance(v, 2), 0.0028));
      const slab = (Math.floor(u * 2) + Math.floor(v * 2)) % 2 ? 1.5 : -1.5;
      return [247 + cloud * 2.5 + fine * 2 + slab - seam * 32,
        135 + fine * 5 - seam * 52, 244 + cloud * 4 + fine * 3 + seam * 9];
    },
    details: (contexts) => pores(contexts, 203, 1300, 0.8, 1.4, 0.16),
  });

  const woodTone = noise(301, 24, 5);
  const woodFiber = noise(302, 180, 12);
  const walnut = surface({
    name: 'Architectural / quarter-cut walnut', color: '#55352a',
    roughness: 0.6, bumpScale: 0.008, tileSize: [1.2, 2.4],
    direction: 'Straight grain along V; four 300 mm panels across U.',
    field(u, v) {
      const bend = 0.0018 * Math.sin(TAU * v) + 0.001 * Math.sin(TAU * (2 * v + u));
      const x = u + bend;
      const grain = Math.sin(TAU * (x * 89 + 0.18 * Math.sin(TAU * x * 17)));
      const fine = woodFiber(u, v);
      const vessel = Math.pow(0.5 + 0.5 * Math.sin(TAU * (x * 157 + 0.12 * Math.sin(TAU * v))), 14);
      const seam = groove(seamDistance(u, 4), 0.0028);
      const panel = [2, -3, 0, -1][Math.min(3, Math.floor(u * 4))];
      return [246 + woodTone(u, v) * 5 + grain * 3 + fine * 2 + panel - vessel * 9 - seam * 43,
        136 + grain * 4 + fine * 5 - vessel * 13 - seam * 58,
        241 + grain * 3 + vessel * 8 + seam * 12];
    },
  });

  const brushed = noise(401, 250, 3);
  const steelCloud = noise(402, 8);
  const steel = surface({
    name: 'Architectural / brushed stainless steel', color: '#bfc1bf',
    roughness: 0.41, metalness: 0.94, bumpScale: 0.0016, tileSize: [0.6, 0.6],
    direction: 'Brushed micro-striations run along V. Rotate all maps together for horizontal brushing.',
    field(u, v) {
      const stroke = brushed(u, v);
      return [249 + stroke * 3 + steelCloud(u, v), 128 + stroke * 10, 247 + stroke * 6];
    },
  });

  const powder = noise(501, 128);
  const darkMetal = surface({
    name: 'Architectural / charcoal powder-coated metal', color: '#333533',
    roughness: 0.67, metalness: 0.55, bumpScale: 0.0025, tileSize: [0.6, 0.6],
    direction: 'Fine nondirectional powder coat.',
    field(u, v) {
      const fine = powder(u, v);
      return [250 + fine * 2, 128 + fine * 5, 246 + fine * 4];
    },
  });

  const hide = noise(601, 18);
  const hideFine = noise(602, 95);
  const leather = surface({
    name: 'Architectural / charcoal brown leather', color: '#3c302c',
    roughness: 0.72, bumpScale: 0.004, tileSize: [0.24, 0.24],
    direction: 'Small irregular pebbles; nondirectional, without oversized wrinkles.',
    field(u, v) {
      const fine = hideFine(u, v);
      const crease = Math.pow(1 - Math.abs(fine), 12);
      const soft = hide(u, v);
      return [249 + soft * 2 + fine * 1.5 - crease * 3,
        139 + soft * 4 + fine * 8 - crease * 16, 244 + crease * 6 - soft * 3];
    },
    details: (contexts) => pores(contexts, 603, 750, 0.65, 1, 0.1),
  });

  const limestone = noise(701, 14, 24);
  const travertine = surface({
    name: 'Architectural / pale filled travertine', color: '#d5cbb6',
    roughness: 0.81, bumpScale: 0.009, tileSize: [1.2, 1.2],
    direction: 'Quiet mineral bedding along U; turn UVs for vertical vein-cut stone.',
    field(u, v) {
      const cloud = limestone(u, v);
      const bed = Math.sin(TAU * (v * 21 + 0.13 * Math.sin(TAU * u))) * 0.6
        + Math.sin(TAU * (v * 47 + 0.08 * Math.sin(TAU * u * 3))) * 0.4;
      return [247 + cloud * 3 + bed * 2.2, 132 + cloud * 6 + bed * 3, 246 + cloud * 4];
    },
    details: (contexts) => pores(contexts, 702, 420, 1.15, 2.5, 0.18),
  });

  const yarn = noise(801, 64);
  const rug = surface({
    name: 'Architectural / warm charcoal woven rug', color: '#777367',
    roughness: 0.98, bumpScale: 0.006, tileSize: [0.32, 0.32],
    direction: 'Orthogonal basket weave, 5 mm yarn cells; align U/V to rug edges.',
    field(u, v) {
      const x = u * 64;
      const y = v * 64;
      const over = (Math.floor(x) + Math.floor(y)) % 2 === 0;
      const across = over ? x : y;
      const along = over ? y : x;
      const thread = Math.pow(Math.max(0, Math.sin(Math.PI * (across % 1))), 0.65);
      const crossing = 0.82 + 0.18 * Math.sin(Math.PI * (along % 1));
      const fiber = yarn(u, v);
      return [235 + thread * crossing * 14 + fiber * 2,
        92 + thread * crossing * 67 + fiber * 3, 249 + fiber * 3];
    },
  });

  return { concrete, floor, walnut, steel, darkMetal, leather, travertine, rug };
}
