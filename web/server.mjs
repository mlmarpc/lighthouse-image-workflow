import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { encodeBuffer, validateEncodingSettings } from '../shared/image-processing.mjs';

const WEB_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(WEB_ROOT, 'dist');
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MIME_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXTENSIONS = { png: '.png', jpeg: '.jpg', webp: '.webp' };

export async function startWebServer({ port = Number(process.env.PORT) || 4178, openBrowser = false } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true });
      if (request.method === 'POST' && ['/api/preview', '/api/export'].includes(url.pathname)) {
        const settings = readSettings(url.searchParams);
        const input = await readBody(request);
        const { data, info } = await encodeBuffer({ input, ...settings });
        const headers = { 'content-type': MIME_TYPES[settings.format], 'content-length': data.length, 'cache-control': 'no-store' };
        headers['x-image-width'] = String(info.width);
        headers['x-image-height'] = String(info.height);
        if (url.pathname === '/api/export') {
          const name = outputName(url.searchParams.get('name') || 'image', url.searchParams.get('viewport'), settings.format);
          headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
        }
        response.writeHead(200, headers);
        return response.end(data);
      }
      if (request.method === 'GET') return serveStatic(response, url.pathname);
      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  if (openBrowser) open(url);
  return { server, url };
}

function readSettings(params) {
  const viewport = params.get('viewport');
  if (!['desktop', 'mobile'].includes(viewport)) throw new Error('Viewport must be desktop or mobile');
  const settings = {
    format: params.get('format') || 'png',
    quality: Number(params.get('quality') || 82),
    dimensions: { width: Number(params.get('width')), height: Number(params.get('height')) },
    palette: params.get('palette') === 'true',
    colors: Number(params.get('colors') || 64),
  };
  validateEncodingSettings(settings.format, settings.quality, settings.dimensions, settings.palette, settings.colors);
  return settings;
}

function outputName(name, viewport, format) {
  const base = path.posix.basename(name.replaceAll('\\', '/'));
  const withoutExtension = base.replace(/\.[^.]*$/, '') || 'image';
  return `${withoutExtension}-${viewport}${EXTENSIONS[format]}`;
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 128 MB upload limit');
    chunks.push(chunk);
  }
  if (!size) throw new Error('No image data received');
  return Buffer.concat(chunks, size);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.resolve(DIST, `.${requested}`);
  const relative = path.relative(DIST, file);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return sendJson(response, 404, { error: 'Not found' });
  try {
    const data = await readFile(file);
    const extension = path.extname(file).toLowerCase();
    const type = extension === '.html' ? 'text/html; charset=utf-8'
      : extension === '.js' ? 'text/javascript; charset=utf-8'
        : extension === '.css' ? 'text/css; charset=utf-8'
          : extension === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

function open(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { url } = await startWebServer({ openBrowser: process.env.OPEN_BROWSER !== '0' });
    console.log(`Image review is running at ${url}`);
    console.log('Press Ctrl+C to stop.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
