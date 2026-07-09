import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;

export const CONNECTOR_TARBALL_FILENAME = 'toolplane-connector-0.1.7.tgz';

type TarEntry = {
  name: string;
  body: Buffer;
  mode: number;
};

function writeOctal(buffer: Buffer, value: number, offset: number, length: number) {
  const text = value.toString(8).padStart(length - 1, '0').slice(-(length - 1));
  buffer.write(`${text}\0`, offset, length, 'ascii');
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(entry.name, 0, 100, 'utf8');
  writeOctal(header, entry.mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, entry.body.length, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('toolplane', 265, 32, 'ascii');
  header.write('toolplane', 297, 32, 'ascii');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const sum = checksum.toString(8).padStart(6, '0').slice(-6);
  header.write(`${sum}\0 `, 148, 8, 'ascii');
  return header;
}

function padBody(body: Buffer): Buffer {
  const remainder = body.length % BLOCK_SIZE;
  if (remainder === 0) return body;
  return Buffer.concat([body, Buffer.alloc(BLOCK_SIZE - remainder, 0)]);
}

function buildTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name) > 100) {
      throw new Error(`Connector package path is too long: ${entry.name}`);
    }
    chunks.push(tarHeader(entry), padBody(entry.body));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(chunks);
}

export async function buildConnectorPackageTarball(root = process.cwd()): Promise<Buffer> {
  const packageRoot = path.join(root, 'packages', 'connector');
  const packageJson = await readFile(path.join(packageRoot, 'package.json'));
  const cli = await readFile(path.join(packageRoot, 'bin', 'connector.mjs'));

  return gzipSync(buildTar([
    { name: 'package/package.json', body: packageJson, mode: 0o644 },
    { name: 'package/bin/connector.mjs', body: cli, mode: 0o755 },
  ]), { level: 9 });
}
