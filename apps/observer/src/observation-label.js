// Read-only status text. A fresh snapshot does not certify every worker role.
export function observationLabel({ count = 0, bridge = true, status = 'waiting', hour = 0, phase = '', preview = false } = {}) {
  const minutes = ((Math.floor((Number.isFinite(hour) ? hour : 0) * 60 + 1e-6) % 1440) + 1440) % 1440;
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const sync = !bridge ? '演示' : status === 'stale' ? '同步中断' : status === 'live' ? '实时同步' : '等待状态';
  return `${count} 个项目 · ${sync} · ${preview ? '预览 ' : ''}${phase} ${clock}`;
}
