import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasUnsavedWorkspaceChanges, workspaceInitials, workspaceSwitchHref } from '@/lib/workspace/navigation';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('workspace navigation', () => {
  it('supports Chinese initials and drops resource IDs when switching spaces', () => {
    expect(workspaceInitials('研发团队')).toBe('研发');
    expect(workspaceInitials('Acme Studio')).toBe('AS');
    expect(workspaceSwitchHref('one', 'two', '/app/one/mcp/private-server')).toBe('/app/two/mcp');
    expect(workspaceSwitchHref('one', 'one', '/app/one/mcp/private-server')).toBe('/app/one/mcp/private-server');
    expect(workspaceSwitchHref('one', 'two', '/app/one/unknown')).toBe('/app/two/chat');
  });

  it('detects unsaved native fields and auto-saving editors without treating a submitted create form as dirty', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    document.body.innerHTML = '<form><input value="saved"><input type="hidden" value="workspace"><textarea>saved</textarea></form>';
    const form = document.querySelector('form')!;
    const input = form.querySelector('input')!;
    expect(hasUnsavedWorkspaceChanges()).toBe(false);
    input.value = 'edited';
    expect(hasUnsavedWorkspaceChanges()).toBe(true);
    expect(hasUnsavedWorkspaceChanges(document, form)).toBe(false);
    input.defaultValue = 'edited';
    expect(hasUnsavedWorkspaceChanges()).toBe(false);
    form.dataset.unsavedChanges = 'true';
    expect(hasUnsavedWorkspaceChanges()).toBe(true);
    form.dataset.unsavedChanges = 'false';
    input.value = 'controlled editor value';
    expect(hasUnsavedWorkspaceChanges()).toBe(false);
  });
});
