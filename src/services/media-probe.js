import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export async function probeVideo(filePath) {
  try {
    const { stdout } = await execFileAsync(config.ffprobePath, [
      '-v','error','-select_streams','v:0',
      '-show_entries','stream=width,height,duration:format=duration',
      '-of','json', filePath
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0] || {};
    return {
      width: Number(stream.width || 0),
      height: Number(stream.height || 0),
      durationSeconds: Number(stream.duration || data.format?.duration || 0)
    };
  } catch (error) {
    throw new Error(`Video inspection failed: ${error.message}`);
  }
}

export function validateContentType(probe, contentType) {
  if (!probe.width || !probe.height || !probe.durationSeconds) {
    throw new Error('The video duration or dimensions could not be detected.');
  }
  if (contentType === 'SHORT') {
    if (probe.durationSeconds > 180.5) throw new Error('A Short must be three minutes or shorter.');
    if (probe.width > probe.height) throw new Error('A Short must use a vertical or square aspect ratio.');
  }
  return probe;
}
