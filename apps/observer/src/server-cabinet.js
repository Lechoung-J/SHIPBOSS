export function createServerCabinet(THREE) {
  const root = new THREE.Group();
  root.name = 'collection-server-cabinet';
  root.userData.kind = 'collection-cabinet';

  const materials = {
    shell: new THREE.MeshStandardMaterial({ color: '#505a50', roughness: .72, metalness: .18 }),
    edge: new THREE.MeshStandardMaterial({ color: '#303b37', roughness: .52, metalness: .28 }),
    door: new THREE.MeshStandardMaterial({ color: '#252f2e', roughness: .48, metalness: .24 }),
    rail: new THREE.MeshStandardMaterial({ color: '#778075', roughness: .4, metalness: .48 }),
    dark: new THREE.MeshStandardMaterial({ color: '#171e1d', roughness: .65, metalness: .12 }),
    green: new THREE.MeshStandardMaterial({ color: '#8fc68c', emissive: '#376b40', emissiveIntensity: .72, roughness: .3 }),
    amber: new THREE.MeshStandardMaterial({ color: '#e4ae64', emissive: '#7c431e', emissiveIntensity: .64, roughness: .3 }),
    label: new THREE.MeshStandardMaterial({ color: '#d8d0b9', roughness: .75 }),
  };
  const box = (name, size, position, material, kind = 'collection-cabinet') => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name; mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.kind = kind; root.add(mesh); return mesh;
  };

  box('cabinet-plinth', [3.25, .36, 2.45], [0, .18, 0], materials.edge);
  box('cabinet-shell', [3, 3.96, 2.25], [0, 2.28, 0], materials.shell);
  box('cabinet-front-door', [2.48, 3.48, .12], [0, 2.3, 1.18], materials.door);
  box('cabinet-left-rail', [.12, 3.45, .12], [-1.12, 2.3, 1.27], materials.rail);
  box('cabinet-right-rail', [.12, 3.45, .12], [1.12, 2.3, 1.27], materials.rail);
  box('cabinet-nameplate', [1.55, .28, .045], [0, 3.75, 1.265], materials.label);
  box('cabinet-handle', [.12, .64, .1], [.88, 2.2, 1.3], materials.rail);
  for (let row = 0; row < 5; row++) {
    const y = 3.38 - row * .56;
    box(`server-unit-${row}`, [1.84, .42, .24], [0, y, 1.31], materials.dark);
    box(`server-slot-${row}`, [1.23, .035, .035], [-.16, y + .03, 1.455], materials.rail);
    box(`server-light-green-${row}`, [.095, .095, .045], [.73, y, 1.455], materials.green);
    box(`server-light-amber-${row}`, [.075, .075, .045], [.52, y, 1.455], materials.amber);
  }
  // A small roof overhang makes the cabinet read independently from the rooms.
  box('cabinet-cap', [3.35, .22, 2.55], [0, 4.34, 0], materials.edge);
  root.traverse(object => { object.userData.collectionProp = true; });
  return root;
}
