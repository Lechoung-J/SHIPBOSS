import * as THREE from 'three';

export function confirmedPresence(project) {
  return (project.actors || []).some(actor => actor.active === true && actor.uncertain !== true)
    || (project.recording === true && project.recordingUncertain !== true);
}
export function roomIsIdle(project) {
  return confirmedPresence(project) ? false : (project.isIdle ?? project.status === 'idle');
}

const THEMES = [
  { index: 0, name: 'Walnut atelier', floor: 'wood-planks', tops: ['travertine', 'walnut', 'travertine', 'walnut'], lounge: 'chairs', board: 'blackboard' },
  { index: 1, name: 'Concrete studio', floor: 'grey-concrete', tops: ['concrete', 'travertine', 'concrete', 'travertine'], lounge: 'sofa', board: 'whiteboard' },
  { index: 2, name: 'Terrazzo workshop', floor: 'pale-terrazzo', tops: ['walnut', 'concrete', 'walnut', 'travertine'], lounge: 'sofa', board: 'blackboard' },
];
const floorTemplates = new Map();

export function roomTheme(projectId, explicitIndex) {
  let hash = 2166136261;
  for (const char of String(projectId ?? 'office')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const index = Number.isFinite(explicitIndex) ? ((Math.trunc(explicitIndex) % 3) + 3) % 3 : hash % 3;
  return THEMES[index];
}

export function themedFloor(theme, architectural) {
  if (theme.floor === 'grey-concrete') return architectural.floor;
  if (floorTemplates.has(theme.floor)) return floorTemplates.get(theme.floor);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  let seed = 1979 + theme.index;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  if (theme.floor === 'wood-planks') {
    ctx.fillStyle = '#a68c6c'; ctx.fillRect(0, 0, 512, 512);
    for (let column = 0; column < 8; column++) {
      ctx.fillStyle = ['#b49a77', '#ac906f', '#b89f7d', '#a68c6c'][column % 4];
      ctx.fillRect(column * 64 + 1, 0, 62, 512);
      for (let grain = 0; grain < 42; grain++) {
        ctx.strokeStyle = `rgba(86,59,38,${.035 + random() * .07})`;
        ctx.lineWidth = .5 + random(); ctx.beginPath();
        const x = column * 64 + random() * 62;
        ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 2, 160, x - 2, 350, x, 512); ctx.stroke();
      }
      ctx.fillStyle = '#836f57'; ctx.fillRect(column * 64, 0, 1.2, 512);
      ctx.fillRect(column * 64, (column % 3) * 170, 64, 1.4);
    }
  } else {
    ctx.fillStyle = '#ddd9ce'; ctx.fillRect(0, 0, 512, 512);
    const colors = ['#aeb7ad', '#c3b09d', '#e9e6dd', '#999d98', '#b7afa7'];
    for (let i = 0; i < 1450; i++) {
      const x = random() * 512, y = random() * 512, radius = 1 + random() * 3.2;
      ctx.fillStyle = colors[i % colors.length]; ctx.beginPath();
      for (let j = 0; j < 5; j++) {
        const a = j / 5 * Math.PI * 2, r = radius * (.6 + random() * .4);
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (!j) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({ name: theme.floor, map, color: '#ffffff', roughness: theme.index === 0 ? .73 : .82 });
  material.userData.tileSize = [2.4, 2.4]; floorTemplates.set(theme.floor, material);
  return material;
}

// Clone once after construction. Texture maps stay shared; room colors never do.
export function isolateRoomMaterials(room) {
  const clones = new Map();
  room.traverse(object => {
    if (!object.isMesh) return;
    const clone = source => {
      if (!clones.has(source)) clones.set(source, source.clone());
      return clones.get(source);
    };
    object.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
  });
  const records = [...clones.values()].map(material => ({ material, color: material.color?.clone(), emissive: material.emissive?.clone(), intensity: material.emissiveIntensity }));
  return {
    restore() {
      records.forEach(({ material, color, emissive, intensity }) => {
        if (color) material.color.copy(color);
        if (emissive) material.emissive.copy(emissive);
        if (intensity !== undefined) material.emissiveIntensity = intensity;
      });
    },
    capture() {
      records.forEach(record => {
        if (record.color) record.color.copy(record.material.color);
        if (record.emissive) record.emissive.copy(record.material.emissive);
        record.intensity = record.material.emissiveIntensity;
      });
    },
    // Apply the room-local light level from the captured base colors. `waiting`
    // keeps the existing, much darker "needs attention" treatment; `lightScale`
    // is used for idle rooms and is animated by the caller over ~0.3s.
    apply(waiting = false, lightScale = 1) {
      const scale = Math.max(0, Math.min(1, Number(lightScale) || 0));
      records.forEach(({ material, color, emissive, intensity }) => {
        if (waiting && !material.userData.waitingExempt) {
          material.color?.copy(color).multiplyScalar(.075);
          material.emissive?.set(0x000000);
          if (material.emissiveIntensity !== undefined) material.emissiveIntensity = 0;
          return;
        }
        if (waiting && material.userData.waitingExempt) {
          material.color?.copy(color);
          material.emissive?.copy(emissive);
          if (intensity !== undefined) material.emissiveIntensity = intensity;
          return;
        }
        material.color?.copy(color).multiplyScalar(scale);
        material.emissive?.copy(emissive).multiplyScalar(scale);
        if (intensity !== undefined) material.emissiveIntensity = intensity * scale;
      });
    },
  };
}

function statusMaterial(color, emissive) {
  const material = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: .55, roughness: .36 });
  material.userData.waitingExempt = true;
  return material;
}

export function createStatusIndicators(room, desks, projectId) {
  const layer = new THREE.Group(); layer.name = 'Actor status indicators'; room.add(layer);
  const questionMaterial = statusMaterial('#ff9e20', '#ff7400');
  const rejectedMaterial = statusMaterial('#ff633d', '#ed350f');
  const sphere = new THREE.SphereGeometry(1, 20, 12);
  const mesh = (parent, geometry, material) => { const object = new THREE.Mesh(geometry, material.clone()); parent.add(object); return object; };
  const question = new THREE.Group(); question.name = 'PM awaiting your answer'; question.userData.kind = 'question'; question.userData.projectId = projectId;
  const curve = new THREE.CurvePath();
  curve.add(new THREE.CubicBezierCurve3(new THREE.Vector3(-.23, .23, 0), new THREE.Vector3(-.25, .64, 0), new THREE.Vector3(.4, .62, 0), new THREE.Vector3(.27, .25, 0)));
  curve.add(new THREE.CubicBezierCurve3(new THREE.Vector3(.27, .25, 0), new THREE.Vector3(.22, .1, 0), new THREE.Vector3(0, .13, 0), new THREE.Vector3(0, -.1, 0)));
  mesh(question, new THREE.TubeGeometry(curve, 36, .072, 10, false), questionMaterial);
  const questionDot = mesh(question, sphere, questionMaterial); questionDot.scale.setScalar(.086); questionDot.position.y = -.32;
  question.traverse(object => { object.userData.kind = 'question'; object.userData.projectId = projectId; });
  layer.add(question);
  // A screen-facing sprite keeps the thought bubble flat at the isometric angle.
  const thoughtCanvas = document.createElement('canvas'); thoughtCanvas.width = 256; thoughtCanvas.height = 160;
  const thoughtContext = thoughtCanvas.getContext('2d');
  thoughtContext.clearRect(0, 0, 256, 160);
  thoughtContext.shadowColor = 'rgba(49,43,31,.18)'; thoughtContext.shadowBlur = 10; thoughtContext.shadowOffsetY = 4;
  const bubbleGradient = thoughtContext.createLinearGradient(0, 18, 0, 122);
  bubbleGradient.addColorStop(0, '#fffdf5'); bubbleGradient.addColorStop(1, '#f1ead9');
  thoughtContext.fillStyle = bubbleGradient; thoughtContext.strokeStyle = '#cfc6b1'; thoughtContext.lineWidth = 3;
  thoughtContext.beginPath(); thoughtContext.roundRect(18, 16, 220, 104, 30); thoughtContext.fill(); thoughtContext.stroke();
  thoughtContext.beginPath(); thoughtContext.moveTo(57, 118); thoughtContext.lineTo(45, 145); thoughtContext.lineTo(79, 119); thoughtContext.closePath();
  thoughtContext.fill(); thoughtContext.stroke();
  thoughtContext.shadowColor = 'transparent';
  thoughtContext.fillStyle = '#756b55';
  for (let i = 0; i < 3; i++) { thoughtContext.beginPath(); thoughtContext.arc(82 + i * 46, 69, 9, 0, Math.PI * 2); thoughtContext.fill(); }
  const thoughtTexture = new THREE.CanvasTexture(thoughtCanvas); thoughtTexture.colorSpace = THREE.SRGBColorSpace; thoughtTexture.anisotropy = 4;
  const thoughtMaterial = new THREE.SpriteMaterial({ map: thoughtTexture, transparent: true, depthWrite: false, toneMapped: false });
  const thoughts = desks.map(() => {
    const bubble = new THREE.Sprite(thoughtMaterial); bubble.scale.set(.76, .475, 1); layer.add(bubble); return bubble;
  });
  const rejected = desks.map(() => {
    const icon = new THREE.Group(); layer.add(icon);
    for (const angle of [-Math.PI / 4, Math.PI / 4]) { const bar = mesh(icon, new THREE.BoxGeometry(.14, .79, .16), rejectedMaterial); bar.rotation.z = angle; }
    return icon;
  });
  const anchor = new THREE.Vector3();
  function getHeadAnchor(index) {
    const character = desks[index]?.character;
    if (!character) return null;
    character.head.updateWorldMatrix(true, false);
    anchor.set(0, .23, 0); character.head.localToWorld(anchor); room.worldToLocal(anchor);
    return anchor.clone();
  }
  function position(object, index, time) {
    object.position.copy(getHeadAnchor(index)); object.position.y += (object.isSprite ? .67 : .58) + (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : Math.sin(time * 2.4 + index) * .035);
    if (!object.isSprite) object.rotation.y = Math.PI / 4;
  }
  function update(bindings, waiting, time = 0) {
    question.visible = waiting && desks[0].character.root.visible;
    if (question.visible) position(question, 0, time);
    desks.forEach((desk, index) => {
      thoughts[index].visible = Boolean(!layer.userData.externalThoughts && desk.character.root.visible && bindings[index]?.motion === 'thinking' && !(index === 0 && waiting));
      rejected[index].visible = Boolean(desk.character.root.visible && bindings[index]?.motion === 'rejected' && !(index === 0 && waiting));
      if (thoughts[index].visible) position(thoughts[index], index, time);
      if (rejected[index].visible) position(rejected[index], index, time);
    });
  }
  update([], false);
  function snapshot() {
    return { questionVisible: question.visible, thinking: thoughts.map(object => object.visible), rejected: rejected.map(object => object.visible) };
  }
  return { layer, question, thoughts, rejected, update, snapshot, getHeadAnchor };
}

export function createWaitingLamp(room, desk) {
  const light = new THREE.SpotLight('#ffc77f', 140, 4, .66, .8, 2);
  light.position.set(desk.x + .82, 3.12, desk.z + .18); light.castShadow = false;
  light.target.position.set(desk.x - .18, .92, desk.z + .1);
  room.add(light, light.target);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d'); const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,201,115,.75)'); gradient.addColorStop(.45, 'rgba(255,180,75,.3)'); gradient.addColorStop(1, 'rgba(255,174,61,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  const poolMaterial = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, opacity: .55, toneMapped: false }); poolMaterial.userData.waitingExempt = true;
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(2.72, 1.25), poolMaterial);
  pool.rotation.x = -Math.PI / 2; pool.position.set(desk.x, 1.102, desk.z); room.add(pool);
  const lampMaterial = new THREE.MeshStandardMaterial({ color: '#ffe3ac', emissive: '#ffb84d', emissiveIntensity: .9, roughness: .6 }); lampMaterial.userData.waitingExempt = true;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(.075, 12, 8), lampMaterial); bulb.position.set(desk.x + .916, 1.69, desk.z - .43); room.add(bulb);
  function setWaiting(waiting) { light.visible = pool.visible = bulb.visible = waiting; }
  setWaiting(false);
  return { light, pool, setWaiting };
}


// Cardboard boxes show how many other skills a project used. Only the visual
// count is exact through 256; extreme counts have a visible renderer-protection notice.
export function createSkillPile(room, cap = 256) {
  const group = new THREE.Group(); group.name = 'Used-skill cardboard boxes'; group.userData.kind = 'skills'; group.position.set(.15, .045, 3.9); room.add(group);
  const cardboards = ['#b78a5d', '#aa7d53', '#c39a6b', '#b3855a', '#c7a077'];
  const materials = cardboards.map(color => new THREE.MeshStandardMaterial({ color, roughness: .96, metalness: 0 }));
  const tapeMaterial = new THREE.MeshStandardMaterial({ color: '#d9c9a6', roughness: .8 });
  const labelMaterial = new THREE.MeshStandardMaterial({ color: '#e7dfca', roughness: .9 });
  const boxes = [];
  const positions = [
    [-.56, .21, -.26], [0, .21, -.27], [.56, .21, -.25],
    [-.56, .21, .25], [0, .21, .26], [.56, .21, .24],
    [-.28, .66, -.26], [.28, .66, -.25], [.56, .66, .25],
    [-.56, .66, .25], [0, .66, .26], [-.28, .66, .25],
    [0, 1.11, 0], [.56, 1.11, .02],
  ];
  for (let i = 0; i < cap; i++) {
    const size = .48 + (i % 3) * .02;
    const box = new THREE.Group(); box.position.set(...(positions[i] || [(i % 4 - 1.5) * .53, .21 + Math.floor(i / 16) * .45, (Math.floor(i / 4) % 4 - 1.5) * .51]));
    box.rotation.y = ((i * 37) % 11 - 5) * .012;
    const body = new THREE.Mesh(new THREE.BoxGeometry(size, size * .82, size * .9), materials[i % materials.length]);
    body.castShadow = true; body.receiveShadow = true; box.add(body);
    const tape = new THREE.Mesh(new THREE.BoxGeometry(size * .16, .006, size * .9), tapeMaterial);
    tape.position.y = size * .41; tape.castShadow = true; box.add(tape);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(size * .42, size * .26), labelMaterial);
    label.position.set(-size * .16, .0, size * .46); box.add(label);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(size * .94, .014, size * .3), materials[i % materials.length]);
    flap.position.set(0, size * .4, -size * .22); flap.rotation.x = .08; box.add(flap);
    box.visible = false; group.add(box); boxes.push(box);
  }
  let count = 0;
  function setCount(value) {
    count = Math.max(0, Math.floor(Number(value) || 0));
    const shown = Math.min(count, cap);
    // Keep the original footprint and cardboard art; compact larger piles.
    const scale = count <= 14 ? 1 : Math.min(1, 2.2 / (.45 * Math.ceil(shown / 16)));
    group.scale.setScalar(scale);
    if (count > 14) boxes.forEach((box, i) => box.position.set((i % 4 - 1.5) * .53, .21 + Math.floor(i / 16) * .45, (Math.floor(i / 4) % 4 - 1.5) * .51));
    else boxes.slice(0, 14).forEach((box, i) => box.position.set(...positions[i]));
    boxes.forEach((box, index) => { box.visible = index < shown; });
    return shown;
  }
  return { group, cap, setCount, get count() { return count; }, get shown() { return Math.min(count, cap); } };
}
