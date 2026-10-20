'use strict';
const ApiError = require('./ApiError');

const MAX_BODY = 6 * 1024 * 1024;

function parseBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  return (m[1] || m[2] || '').trim();
}

function parsePart(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const header = raw.slice(0, headerEnd).toString('utf8');
  let body = raw.slice(headerEnd + 4);
  if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
    body = body.slice(0, -2);
  }
  const nameM = /name="([^"]+)"/i.exec(header);
  if (!nameM) return null;
  const fileM = /filename="([^"]*)"/i.exec(header);
  const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(header);
  if (fileM) {
    return {
      kind: 'file',
      field: nameM[1],
      filename: fileM[1],
      mime: typeM ? typeM[1].trim() : 'application/octet-stream',
      buffer: body,
    };
  }
  return { kind: 'field', field: nameM[1], value: body.toString('utf8') };
}

function split(buffer, boundary) {
  const token = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(token);
  if (start < 0) return parts;
  start += token.length;
  if (buffer.slice(start, start + 2).equals(Buffer.from('\r\n'))) start += 2;
  while (start < buffer.length) {
    const next = buffer.indexOf(token, start);
    if (next < 0) break;
    let part = buffer.slice(start, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }
    const parsed = parsePart(part);
    if (parsed) parts.push(parsed);
    start = next + token.length;
    if (buffer.slice(start, start + 2).equals(Buffer.from('--'))) break;
    if (buffer.slice(start, start + 2).equals(Buffer.from('\r\n'))) start += 2;
  }
  return parts;
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const boundary = parseBoundary(req.headers['content-type']);
    if (!boundary) {
      reject(new ApiError(400, 'Send the file as multipart form data.', null, 'MULTIPART_REQUIRED'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        req.destroy();
        reject(new ApiError(413, 'File is too large (maximum 5 MB).', { file: 'File is too large (maximum 5 MB).' }, 'FILE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      const parts = split(Buffer.concat(chunks), boundary);
      const fields = {};
      let file = null;
      for (const p of parts) {
        if (p.kind === 'file' && p.field === 'file' && p.filename) file = p;
        else if (p.kind === 'field') fields[p.field] = p.value;
      }
      resolve({ fields, file });
    });
    req.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}

module.exports = { readRequest };
