import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Called only by the guarded, isolated platform-ui browser harness. All writes
// go through the real UI/server actions; this module never intercepts requests.
export async function verifySkillForms({ page, origin, check }) {
  const listing = `${origin}/app/ui-browser/skills`;
  const name = 'Browser UI Skill';
  const description = 'Browser UTF-8 description: 中文 ✓';
  let detail;
  const fixtures = await mkdtemp(path.join(os.tmpdir(), 'toolplane-ui-skill-'));
  async function openSource(source) {
    await page.goto(listing);
    await page.getByRole('button', { name: 'Add skill', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a skill', exact: true });
    await dialog.getByText(source, { exact: true }).click();
    return dialog;
  }
  try {
    await check('skill create keeps required validation, native FormData and UTF-8 persistence', async () => {
      const dialog = await openSource('Create new');
      const input = dialog.getByRole('textbox', { name: 'Skill name', exact: true });
      assert.equal(await input.evaluate(el => el.checkValidity()), false);
      await dialog.getByRole('button', { name: 'Create skill', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/app/ui-browser/skills');
      assert.equal(await input.evaluate(el => document.activeElement === el && el.validity.valueMissing), true);
      await input.fill(name);
      const purpose = dialog.locator('input[name="description"]');
      assert.ok(await purpose.getAttribute('aria-label'));
      await purpose.fill(description);
      await Promise.all([
        page.waitForURL(url => /^\/app\/ui-browser\/skills\/[^/]+$/.test(url.pathname)),
        dialog.getByRole('button', { name: 'Create skill', exact: true }).click(),
      ]);
      detail = page.url();
      await page.reload();
      await page.getByRole('heading', { name, exact: true }).waitFor();
      await page.getByText(description, { exact: true }).first().waitFor();
    });
    await check('skill native checkboxes and select persist their submitted values', async () => {
      assert.ok(detail);
      const form = page.locator('form:has(select[name="effort"])');
      const user = form.locator('input[name="userInvocable"]');
      const agent = form.locator('input[name="agentInvocable"]');
      assert.equal(await user.getAttribute('data-ui-engine'), 'beui');
      await user.setChecked(false);
      await agent.setChecked(true);
      await form.locator('select[name="effort"]').selectOption('high');
      const [response] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === new URL(detail).pathname),
        form.getByRole('button', { name: 'Save', exact: true }).click(),
      ]);
      assert.ok(response.ok());
      await response.finished();
      await page.reload();
      assert.equal(await user.isChecked(), false);
      assert.equal(await agent.isChecked(), true);
      assert.equal(await form.locator('select[name="effort"]').inputValue(), 'high');
    });
    await check('skill download returns the saved Markdown through the real authorized route', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('link', { name: 'Download', exact: true }).first().click(),
      ]);
      assert.equal(await download.failure(), null);
      assert.match(download.suggestedFilename(), /\.SKILL\.md$/);
      const stream = await download.createReadStream();
      assert.ok(stream);
      let bytes = 0;
      const chunks = [];
      for await (const chunk of stream) {
        bytes += chunk.length;
        assert.ok(bytes <= 1024 * 1024, 'Fixture download must remain bounded.');
        chunks.push(chunk);
      }
      const markdown = Buffer.concat(chunks).toString('utf8');
      assert.ok(markdown.includes(description));
      assert.ok(markdown.includes('## What this skill does'));
    });
    await check('invalid GitHub skill input displays the real server error with an accessible relationship', async () => {
      const dialog = await openSource('Import from GitHub');
      const input = dialog.getByRole('textbox', { name: 'Import from GitHub', exact: true });
      // Rejected before any GitHub network request by the existing server action.
      await input.fill('not-a-repository');
      await dialog.getByRole('button', { name: 'Import', exact: true }).click();
      const error = dialog.getByRole('alert');
      await error.waitFor();
      assert.match(await error.innerText(), /valid github\.com repository or folder URL/);
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(await input.getAttribute('aria-describedby'), await error.getAttribute('id'));
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    });
    await check('directory picker rejects invalid files and resets selection when the dialog closes', async () => {
      const invalid = path.join(fixtures, 'invalid');
      await mkdir(invalid);
      await writeFile(path.join(invalid, 'README.md'), '# Not a skill');
      const dialog = await openSource('Upload a folder');
      const upload = dialog.getByRole('button', { name: 'Upload', exact: true });
      assert.equal(await upload.isDisabled(), true);
      const input = dialog.getByLabel('Upload a folder', { exact: true });
      await input.setInputFiles(invalid);
      await dialog.getByRole('alert').waitFor();
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(await upload.isDisabled(), true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      const fresh = await openSource('Upload a folder');
      assert.equal(await fresh.getByLabel('Upload a folder', { exact: true }).evaluate(el => el.files.length), 0);
      assert.equal(await fresh.getByRole('alert').count(), 0);
      assert.equal(await fresh.getByRole('button', { name: 'Upload', exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
      await fresh.waitFor({ state: 'hidden' });
    });
    await check('directory upload preserves browser relative paths and persists the imported skill', async () => {
      const valid = path.join(fixtures, 'browser-upload');
      await mkdir(valid);
      await writeFile(path.join(valid, 'SKILL.md'), '---\nname: browser-upload\ndescription: Real browser folder upload\n---\n\n# Browser folder fixture\n');
      const dialog = await openSource('Upload a folder');
      await dialog.getByLabel('Upload a folder', { exact: true }).setInputFiles(valid);
      await dialog.getByRole('textbox', { name: 'Skill name', exact: true }).fill('Browser Uploaded Skill');
      const paths = JSON.parse(await dialog.locator('input[name="filePaths"]').inputValue());
      assert.equal(paths.length, 1);
      assert.ok(paths[0].endsWith('browser-upload/SKILL.md'));
      await Promise.all([
        page.waitForURL(url => url.pathname === '/app/ui-browser/skills' && url.searchParams.has('imported')),
        dialog.getByRole('button', { name: 'Upload', exact: true }).click(),
      ]);
      const id = new URL(page.url()).searchParams.get('imported');
      assert.ok(id && !id.includes(','));
      await page.goto(`${listing}/${encodeURIComponent(id)}`);
      await page.reload();
      await page.getByRole('heading', { name: 'Browser Uploaded Skill', exact: true }).waitFor();
      await page.getByText('Real browser folder upload', { exact: true }).first().waitFor();
    });
  } finally {
    // This is a directory created by this process, never a user-provided path.
    await rm(fixtures, { recursive: true, force: true });
  }
}
