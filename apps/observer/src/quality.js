export const QUALITY_PROFILES = {
  high: { name: '高', pixelRatio: 1.75, shadows: 2048, ssao: true, bloom: true, msaa: 4, target: 30, idle: 12 },
  balanced: { name: '中', pixelRatio: 1.4, shadows: 1536, ssao: true, bloom: true, msaa: 2, target: 30, idle: 12 },
  low: { name: '低', pixelRatio: 1, shadows: 1024, ssao: false, bloom: false, msaa: 0, target: 30, idle: 10 },
};

// Pick a conservative starting tier, then let the frame loop downgrade if a
// machine cannot keep up. The query override exists for testing only.
export function detectQuality(renderer, override) {
  if (Object.hasOwn(QUALITY_PROFILES, override)) {
    return { tier: override, gpu: 'override', source: 'query', downgrades: 0 };
  }
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '');
  } catch { /* Restricted WebGL context: use the safe default. */ }
  const cores = navigator.hardwareConcurrency || 8;
  const memory = navigator.deviceMemory || 8;
  const apple = /Apple\s+M\d|Apple GPU/i.test(gpu);
  let tier = 'balanced';
  if (/SwiftShader|Software|llvmpipe|Intel|Radeon|AMD/i.test(gpu)) tier = 'low';
  else if (apple) tier = /\bM(?:3|4|5|6|7|8|9)\b|Max|Ultra/i.test(gpu) ? 'high' : 'balanced';
  if (memory <= 4 || cores <= 4) tier = 'low';
  return { tier, gpu: gpu || 'unknown', source: 'detected', downgrades: 0 };
}
