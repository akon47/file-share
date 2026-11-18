const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond < 1) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return '곧';
  if (seconds < 60) return `${Math.ceil(seconds)}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${Math.round(seconds % 60)}초`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}

export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function formatFileCount(count: number): string {
  return `파일 ${count.toLocaleString('ko-KR')}개`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return done > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

/** Smoothed transfer rate: call update() with the running byte count, read bytesPerSecond. */
export class RateMeter {
  private lastBytes = 0;
  private lastTime = 0;
  bytesPerSecond = 0;

  update(bytes: number, now = performance.now()): number {
    if (!this.lastTime) {
      this.lastTime = now;
      this.lastBytes = bytes;
      return 0;
    }
    const elapsed = (now - this.lastTime) / 1000;
    if (elapsed < 0.25) return this.bytesPerSecond;
    const instant = (bytes - this.lastBytes) / elapsed;
    this.bytesPerSecond = this.bytesPerSecond ? this.bytesPerSecond * 0.7 + instant * 0.3 : instant;
    this.lastTime = now;
    this.lastBytes = bytes;
    return this.bytesPerSecond;
  }

  eta(remaining: number): number {
    return this.bytesPerSecond > 0 ? remaining / this.bytesPerSecond : Number.POSITIVE_INFINITY;
  }
}

export type FileKind = 'image' | 'video' | 'audio' | 'archive' | 'pdf' | 'doc' | 'code' | 'file';

export function fileKind(name: string, type: string): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext)) return 'archive';
  if (
    ['doc', 'docx', 'hwp', 'hwpx', 'txt', 'md', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'key', 'pages'].includes(
      ext,
    )
  )
    return 'doc';
  if (
    [
      'js',
      'ts',
      'py',
      'java',
      'c',
      'cpp',
      'cs',
      'go',
      'rs',
      'json',
      'html',
      'css',
      'xml',
      'yml',
      'yaml',
      'sh',
    ].includes(ext)
  )
    return 'code';
  return 'file';
}
