// Self-contained Node program for clients without ToolPlane dependencies.
// Regression tests execute this exact source in a temporary directory.
export const SYNC_CLIENT_SOURCE = String.raw`// Embedded in generated sync.sh. No dependency on ToolPlane's node_modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [configFile, responseFile, skillsRoot, prefix = ''] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
if (!/^toolplane-[a-f0-9]{24}$/.test(cfg.installation) || (prefix && prefix !== cfg.installation + '-')) fail('invalid_installation');
const root = path.resolve(skillsRoot);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (fs.lstatSync(root).isSymbolicLink()) fail('symlink_skills_root');
const stateParent = path.join(root, '.toolplane-state');
fs.mkdirSync(stateParent, { recursive: true, mode: 0o700 });
if (fs.lstatSync(stateParent).isSymbolicLink()) fail('symlink_state_root');
const state = path.join(stateParent, cfg.installation);
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
if (fs.lstatSync(state).isSymbolicLink()) fail('symlink_state');
const lock = path.join(state, 'lock');
const manifestFile = path.join(state, 'manifest.json');
const journalFile = path.join(state, 'journal.json');
const stage = path.join(state, 'stage');
const backup = path.join(state, 'backup');
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function atomicJSON(file, value) {
  const tmp = file + '.tmp-' + crypto.randomUUID();
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function safeDirectory(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.length > 220 || (prefix && !name.startsWith(prefix))) fail('invalid_owned_directory');
  return path.join(root, name);
}
function loadManifest() {
  if (!exists(manifestFile)) return { schemaVersion: 1, installation: cfg.installation, skills: {} };
  const manifest = readJSON(manifestFile);
  if (manifest.schemaVersion !== 1 || manifest.installation !== cfg.installation || !manifest.skills || typeof manifest.skills !== 'object' || Array.isArray(manifest.skills)) fail('invalid_manifest');
  Object.keys(manifest.skills).forEach(safeDirectory);
  return manifest;
}
function recover() {
  if (!exists(journalFile)) return;
  const j = readJSON(journalFile);
  if (j.schemaVersion !== 1 || j.installation !== cfg.installation || !Array.isArray(j.targets) || typeof j.nextGeneration !== 'string') fail('invalid_journal');
  for (const item of j.targets) {
    safeDirectory(item.name);
    if (typeof item.hadOld !== 'boolean') fail('invalid_journal');
  }
  const committed = loadManifest().generation === j.nextGeneration;
  if (!committed) {
    for (const item of j.targets) {
      const target = safeDirectory(item.name);
      const old = path.join(backup, item.name);
      if (exists(old)) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(old, target);
      } else if (!item.hadOld) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  }
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  fs.rmSync(journalFile);
}
function acquire() {
  try { fs.mkdirSync(lock); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Serialize stale-lock recovery and re-read its owner under that guard.
    const recoveryLock = path.join(state, 'recover-lock');
    try { fs.mkdirSync(recoveryLock); } catch { fail('sync_busy'); }
    try {
      let owner;
      try { owner = readJSON(path.join(lock, 'owner.json')); } catch { fail('sync_busy'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail('sync_busy');
      try { process.kill(owner.pid, 0); fail('sync_busy'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.rmSync(lock, { recursive: true });
      try { fs.mkdirSync(lock); } catch { fail('sync_busy'); }
    } finally { fs.rmSync(recoveryLock, { recursive: true, force: true }); }

  }
  atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid });
}
function safeFile(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\\:\x00-\x1f]/.test(raw) || raw.startsWith('/')) fail('invalid_bundle_path');
  const segments = raw.split('/');
  if (segments.some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p) || ['.git', 'node_modules'].includes(p.toLowerCase()) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('invalid_bundle_path');
  if (raw.toLowerCase() === 'skill.md') fail('duplicate_skill_markdown');
  return raw;
}
function validateSnapshot() {
  if (fs.statSync(responseFile).size > 32 * 1024 * 1024) fail('snapshot_too_large');
  const snapshot = readJSON(responseFile);
  const data = snapshot && snapshot.data;
  if (!data || data.schemaVersion !== 1 || data.snapshotComplete !== true || !Array.isArray(data.skills)
    || data.workspaceSlug !== cfg.workspaceSlug || data.toolkitSlug !== cfg.toolkitSlug
    || (cfg.workspaceId && data.workspaceId !== cfg.workspaceId) || (cfg.toolkitId && data.toolkitId !== cfg.toolkitId)) fail('invalid_snapshot');
  if (data.skills.length > 1000) fail('too_many_skills');
  const names = new Set();
  const slugs = new Set();
  let totalBytes = 0;
  let fileCount = 0;
  return data.skills.map((s) => {
    if (!s || typeof s.slug !== 'string' || !NAME.test(s.slug) || s.slug.length > 160 || slugs.has(s.slug) || typeof s.content !== 'string' || !Array.isArray(s.files)) fail('invalid_skill');
    slugs.add(s.slug);
    if (typeof s.version !== 'string' || !/^[a-f0-9]{12}$/.test(s.version)) fail('invalid_skill_version');
    const digest = crypto.createHash('sha256').update(JSON.stringify({ content: s.content, files: s.files })).digest('hex');
    if (digest.slice(0, 12) !== s.version) fail('skill_hash_mismatch');
    let directory = s.slug;
    if (cfg.client === 'hermes') {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(s.content);
      const name = frontmatter && /^name\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(frontmatter[1]);
      if (name && NAME.test(name[1].trim())) directory = name[1].trim();
    }
    directory = prefix + directory;
    safeDirectory(directory);
    if (names.has(directory)) fail('duplicate_skill_directory');
    names.add(directory);
    const files = [{ path: 'SKILL.md', bytes: Buffer.from(s.content, 'utf8') }];
    const paths = new Set(['skill.md']);
    for (const f of s.files) {
      if (!f || typeof f.content !== 'string' || (f.encoding !== undefined && f.encoding !== 'base64')) fail('invalid_bundle_file');
      const rel = safeFile(f.path);
      const key = rel.normalize('NFC').toLowerCase();
      if (paths.has(key)) fail('duplicate_bundle_path');
      paths.add(key);
      let bytes;
      if (f.encoding === 'base64') {
        bytes = Buffer.from(f.content, 'base64');
        if (bytes.toString('base64') !== f.content) fail('invalid_base64');
      } else { bytes = Buffer.from(f.content, 'utf8'); }
      files.push({ path: rel, bytes });
    }
    for (const f of files) {
      totalBytes += f.bytes.length;
      fileCount += 1;
      if (f.bytes.length > 8 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024 || fileCount > 20000) fail('bundle_limit_exceeded');
    }
    return { directory, slug: s.slug, version: s.version, digest, files };
  });
}
let locked = false;
try {
  acquire(); locked = true;
  recover();
  const snapshot = validateSnapshot(); // Nothing may be deleted before this succeeds.
  const before = loadManifest();
  const next = { schemaVersion: 1, installation: cfg.installation, generation: crypto.randomUUID(), lastSuccessAt: new Date().toISOString(), skills: {} };
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage);
  const targets = [];
  let added = 0, updated = 0, removed = 0;
  for (const skill of snapshot) {
    const target = safeDirectory(skill.directory);
    const present = exists(target);
    if (present && (!before.skills[skill.directory] || fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isDirectory())) fail('unowned_skill_path');
    next.skills[skill.directory] = { slug: skill.slug, version: skill.version, digest: skill.digest };
    if (present && before.skills[skill.directory].digest === skill.digest) continue;
    const dir = path.join(stage, skill.directory);
    fs.mkdirSync(dir);
    for (const file of skill.files) {
      const dest = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const fd = fs.openSync(dest, 'wx', 0o600);
      try { fs.writeFileSync(fd, file.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    targets.push({ name: skill.directory, hadOld: present, replace: true });
    if (present) updated++; else added++;
  }
  for (const name of Object.keys(before.skills)) {
    if (!next.skills[name]) {
      const target = safeDirectory(name);
      if (exists(target) && fs.lstatSync(target).isSymbolicLink()) fail('symlink_owned_path');
      targets.push({ name, hadOld: exists(target), replace: false }); removed++;
    }
  }
  fs.mkdirSync(backup, { recursive: true });
  atomicJSON(journalFile, { schemaVersion: 1, installation: cfg.installation, nextGeneration: next.generation, targets });
  for (const item of targets) {
    const target = safeDirectory(item.name);
    if (item.hadOld) fs.renameSync(target, path.join(backup, item.name));
    if (item.replace) fs.renameSync(path.join(stage, item.name), target);
  }
  atomicJSON(manifestFile, next); // Commit point; recovery distinguishes before/after this rename.
  recover();
  fs.rmSync(stage, { recursive: true, force: true });
  atomicJSON(path.join(state, 'last-attempt.json'), { ok: true, at: next.lastSuccessAt, generation: next.generation });
  process.stdout.write(JSON.stringify({ added, updated, removed, total: snapshot.length }) + '\n');
} catch (error) {
  if (locked) {
    try { recover(); } catch { /* Leave journal and backups intact for explicit recovery. */ }
    try { atomicJSON(path.join(state, 'last-attempt.json'), { ok: false, at: new Date().toISOString(), code: String(error.code || 'sync_failed') }); } catch { /* Keep original failure. */ }
  }
  console.error('ToolPlane sync failed: ' + String(error.code || 'invalid_snapshot'));
  process.exitCode = 1;
} finally {
  if (locked) fs.rmSync(lock, { recursive: true, force: true });
}
`;
