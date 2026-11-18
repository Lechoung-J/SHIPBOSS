const MAX_COLLECTED_IDS = 256;
const MAX_PROJECT_ID_LENGTH = 160;

export function validProjectId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROJECT_ID_LENGTH
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeCollectedIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [], seen = new Set();
  for (const id of value) {
    if (!validProjectId(id) || seen.has(id)) continue;
    seen.add(id); ids.push(id);
    if (ids.length >= MAX_COLLECTED_IDS) break;
  }
  return ids;
}

export class CollectionState {
  #ids;
  constructor(initial = []) { this.#ids = new Set(normalizeCollectedIds(initial)); }
  has(projectId) { return this.#ids.has(projectId); }
  ids() { return [...this.#ids]; }
  visibleIds(discoveryOrder) { return discoveryOrder.filter(id => !this.#ids.has(id)); }
  set(projectId, collected) {
    if (!validProjectId(projectId)) return false;
    if (collected) {
      if (!this.#ids.has(projectId) && this.#ids.size >= MAX_COLLECTED_IDS) return false;
      this.#ids.add(projectId);
    } else this.#ids.delete(projectId);
    return true;
  }
  restoreAll() { this.#ids.clear(); }
}

export { MAX_COLLECTED_IDS };
