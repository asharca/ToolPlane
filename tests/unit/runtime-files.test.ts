// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_RUNTIME_TEXT_FILE_BYTES,
  MAX_RUNTIME_TEXT_FILES,
  RUNTIME_FILE_MOUNT_PATH,
  decodeRuntimeTextFile,
  parseRuntimeTextFiles,
  runtimeFileContainerPath,
  runtimeFilePathKey,
  safeRuntimeFilePath,
  validateRuntimeTextFiles,
} from '@/lib/workspace/runtime-files';

describe('deployment runtime text files', () => {
  it('accepts arbitrary file extensions, no extension, nested paths, and Unicode text', () => {
    const files = validateRuntimeTextFiles([
      { path: 'ssh-config.json', content: '{"host":"1.2.3.4"}\n' },
      { path: 'config', content: 'host = bastion\n' },
      { path: '.private.pem', content: '-----BEGIN PRIVATE KEY-----\n密钥\n' },
      { path: 'profiles/开发.any-format', content: 'enabled=true\n' },
    ]);

    expect(files.map((file) => file.path)).toEqual([
      'ssh-config.json',
      'config',
      '.private.pem',
      'profiles/开发.any-format',
    ]);
    expect(files[0]?.size).toBe(Buffer.byteLength('{"host":"1.2.3.4"}\n', 'utf8'));
    expect(runtimeFileContainerPath('profiles/开发.any-format')).toBe(
      `${RUNTIME_FILE_MOUNT_PATH}/profiles/开发.any-format`,
    );
  });

  it('normalizes paths and rejects traversal, absolute paths, control characters, and Windows separators', () => {
    expect(safeRuntimeFilePath('cafe\u0301.conf')).toBe('café.conf');
    expect(runtimeFilePathKey('SSH-Config.JSON')).toBe('ssh-config.json');

    for (const unsafe of [
      '',
      ' ssh-config.json',
      '/etc/passwd',
      '../ssh-config.json',
      'nested/../ssh-config.json',
      'nested//ssh-config.json',
      'nested\\ssh-config.json',
      'line\nbreak',
      'bad\0name',
      'surrogate-\uD800.txt',
      'a'.repeat(241),
    ]) {
      expect(safeRuntimeFilePath(unsafe)).toBeNull();
    }
  });

  it('rejects duplicate portable paths, NUL content, and unpaired UTF-16 surrogates', () => {
    expect(() => validateRuntimeTextFiles([
      { path: 'SSH-Config.JSON', content: 'one' },
      { path: 'ssh-config.json', content: 'two' },
    ])).toThrow(/Duplicate runtime file path/);

    expect(() => validateRuntimeTextFiles([
      { path: 'cafe\u0301.conf', content: 'one' },
      { path: 'café.conf', content: 'two' },
    ])).toThrow(/Duplicate runtime file path/);

    expect(() => validateRuntimeTextFiles([
      { path: 'nul.txt', content: 'before\0after' },
    ])).toThrow(/UTF-8 text content/);
    expect(() => validateRuntimeTextFiles([
      { path: 'surrogate.txt', content: '\uD800' },
    ])).toThrow(/UTF-8 text content/);
  });

  it('preserves valid UTF-8 bytes and rejects malformed or binary bytes before text conversion', () => {
    expect(decodeRuntimeTextFile(Buffer.from('密码\n', 'utf8'))).toBe('密码\n');
    expect(() => decodeRuntimeTextFile(new Uint8Array([0xc3, 0x28]))).toThrow(/valid UTF-8/);
    expect(() => decodeRuntimeTextFile(new Uint8Array([0x61, 0x00, 0x62]))).toThrow(/NUL/);
  });

  it('enforces individual, count, and aggregate byte limits', () => {
    expect(() => validateRuntimeTextFiles([
      { path: 'too-large.txt', content: 'x'.repeat(MAX_RUNTIME_TEXT_FILE_BYTES + 1) },
    ])).toThrow(/exceeds/);

    const atCountLimit = Array.from({ length: MAX_RUNTIME_TEXT_FILES }, (_, index) => ({
      path: `file-${index}.txt`,
      content: 'x',
    }));
    expect(validateRuntimeTextFiles(atCountLimit)).toHaveLength(MAX_RUNTIME_TEXT_FILES);
    expect(() => validateRuntimeTextFiles([
      ...atCountLimit,
      { path: 'one-too-many.txt', content: 'x' },
    ])).toThrow(/at most/);

    const aggregateTooLarge = Array.from({ length: 5 }, (_, index) => ({
      path: `large-${index}.txt`,
      content: 'x'.repeat(MAX_RUNTIME_TEXT_FILE_BYTES),
    }));
    expect(() => validateRuntimeTextFiles(aggregateTooLarge)).toThrow(/exceed/);
  });

  it('parses the creation form JSON only as a runtime file array', () => {
    expect(parseRuntimeTextFiles('')).toEqual([]);
    expect(parseRuntimeTextFiles(JSON.stringify([
      { path: 'ssh-config.json', content: '[]\n' },
    ]))).toEqual([
      {
        path: 'ssh-config.json',
        content: '[]\n',
        size: 3,
      },
    ]);
    expect(() => parseRuntimeTextFiles('{not json')).toThrow(/valid JSON/);
    expect(() => parseRuntimeTextFiles(JSON.stringify({ path: 'x', content: 'y' }))).toThrow(/array/);
  });
});
