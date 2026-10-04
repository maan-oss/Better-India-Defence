import { spawn, spawnSync } from 'node:child_process';
import { type RgbImage, fromRgb24 } from '@strata/domain/vision';

/** Video handling through the system ffmpeg/ffprobe (required for video; images work without it). */

export interface VideoInfo {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  frames: number | null;
  /** Container creation time if the recorder wrote one (ISO string) — not trusted as evidence on its own. */
  creationTime: string | null;
}

export function ffmpegAvailable(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export function probe(path: string): VideoInfo {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'v:0', path], { timeout: 30_000 });
  if (r.status !== 0) throw new Error(`not a readable video: ${r.stderr?.toString().slice(0, 200) ?? 'ffprobe failed'}`);
  const j = JSON.parse(r.stdout.toString()) as {
    streams?: { width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; codec_name?: string; nb_frames?: string; duration?: string; tags?: { rotate?: string } }[];
    format?: { duration?: string; tags?: { creation_time?: string } };
  };
  const s = j.streams?.[0];
  if (!s?.width || !s.height) throw new Error('no video stream');
  const rate = (s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : s.r_frame_rate) ?? '0/1';
  const [n, d] = rate.split('/').map(Number) as [number, number];
  const rot = Math.abs(Number(s.tags?.rotate ?? 0)) % 180 === 90;
  return {
    durationS: Number(s.duration ?? j.format?.duration ?? 0),
    width: rot ? s.height : s.width,
    height: rot ? s.width : s.height,
    fps: d ? n / d : 0,
    codec: s.codec_name ?? 'unknown',
    frames: s.nb_frames ? Number(s.nb_frames) : null,
    creationTime: j.format?.tags?.creation_time ?? null,
  };
}

/** Scaled output size (even dimensions, max width) for a source. */
export function outputSize(info: { width: number; height: number }, maxWidth: number): { w: number; h: number } {
  const k = Math.min(1, maxWidth / info.width);
  return { w: Math.max(2, Math.round((info.width * k) / 2) * 2), h: Math.max(2, Math.round((info.height * k) / 2) * 2) };
}

/** Exact single frame at time t (seconds), decoded at full resolution unless maxWidth is given. */
export function frameAt(path: string, tS: number, maxWidth = 100_000): RgbImage {
  const info = probe(path);
  const { w, h } = outputSize(info, maxWidth);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, tS)), '-i', path, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    maxBuffer: w * h * 3 + 1024,
    timeout: 60_000,
  });
  if (r.status !== 0 || r.stdout.length < w * h * 3) throw new Error(`frame extraction failed at ${tS}s`);
  return fromRgb24(new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, w * h * 3), w, h);
}

export interface FrameStreamOptions {
  /** Frames per second to sample. */
  fps: number;
  startS?: number;
  durationS?: number;
  maxWidth?: number;
  /** ffmpeg input options placed before -i (e.g. RTSP transport). */
  inputArgs?: string[];
}

/**
 * Stream decoded RGB frames from a file or network URL. Yields at most `fps` frames per second of media
 * time with their media timestamps. Works for RTSP/HTTP sources as well as files.
 */
export async function* frames(src: string, size: { w: number; h: number }, o: FrameStreamOptions, signal?: AbortSignal): AsyncGenerator<{ tS: number; image: RgbImage }> {
  const args = ['-v', 'error', ...(o.inputArgs ?? [])];
  if (o.startS) args.push('-ss', String(o.startS));
  args.push('-i', src);
  if (o.durationS) args.push('-t', String(o.durationS));
  args.push('-vf', `fps=${o.fps},scale=${size.w}:${size.h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const onAbort = () => p.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });
  let stderr = '';
  p.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString();
  });
  const frameBytes = size.w * size.h * 3;
  let buf: Buffer = Buffer.alloc(0);
  let k = 0;
  try {
    for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameBytes) {
        const f = new Uint8Array(buf.subarray(0, frameBytes));
        buf = buf.subarray(frameBytes);
        yield { tS: (o.startS ?? 0) + k / o.fps, image: fromRgb24(f, size.w, size.h) };
        k++;
      }
    }
    const code: number | null = p.exitCode ?? (await new Promise((r) => p.once('close', r)));
    if (code && code !== 0 && !signal?.aborted && k === 0) throw new Error(`ffmpeg failed: ${stderr.slice(0, 300)}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (p.exitCode === null) p.kill('SIGKILL');
  }
}
