import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  revalidatePath: vi.fn(),
  updateListing: vi.fn(),
  updateToolkit: vi.fn(),
  createAssistant: vi.fn(),
  updateAssistant: vi.fn(),
  deleteAssistant: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/admin/market-catalog', () => ({
  ADMIN_MARKET_LISTING_STATUSES: ['draft', 'published', 'disabled'],
  AdminMarketCatalogError: class AdminMarketCatalogError extends Error {},
  createAdminAssistantTemplate: mocks.createAssistant,
  updateAdminAssistantTemplate: mocks.updateAssistant,
  deleteAdminAssistantTemplate: mocks.deleteAssistant,
  updateAdminMarketListing: mocks.updateListing,
  updateAdminPublicToolkit: mocks.updateToolkit,
}));

import {
  createAssistantTemplateAdminAction,
  deleteAssistantTemplateAdminAction,
  updateAssistantTemplateAdminAction,
  updateMarketListingAdminAction,
  updatePublicToolkitAdminAction,
} from '@/lib/admin/market-catalog-actions';

describe('admin marketplace catalog actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin-1' });
  });

  it('requires an admin and forwards validated listing fields', async () => {
    const formData = new FormData();
    formData.set('listingId', 'listing-1');
    formData.set('status', 'disabled');
    formData.set('curated', 'on');
    formData.set('isFeatured', 'on');
    formData.append('categoryIds', 'category-1');

    await expect(updateMarketListingAdminAction({}, formData)).resolves.toEqual({ ok: true });
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.updateListing).toHaveBeenCalledWith({
      id: 'listing-1',
      status: 'disabled',
      curated: true,
      isFeatured: true,
      categoryIds: ['category-1'],
    });
  });

  it('requires an admin before updating a public toolkit', async () => {
    const formData = new FormData();
    formData.set('toolkitId', 'toolkit-1');
    formData.set('enabled', 'on');
    formData.append('categoryIds', 'category-2');

    await expect(updatePublicToolkitAdminAction({}, formData)).resolves.toEqual({ ok: true });
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.updateToolkit).toHaveBeenCalledWith({
      id: 'toolkit-1',
      enabled: true,
      categoryIds: ['category-2'],
    });
  });

  it('creates a reviewed assistant template from validated form fields', async () => {
    const formData = new FormData();
    formData.set('directorySlug', 'research-helper');
    formData.set('name', 'Research helper');
    formData.set('author', 'ToolPlane');
    formData.set('summary', 'Research carefully.');
    formData.set('tags', 'Research, writing');
    formData.set('status', 'published');
    formData.set('isFeatured', 'on');
    formData.set('systemPrompt', 'Cite sources.');
    formData.set('maxSteps', '1000');
    formData.set('modelFormat', 'openai-compatible');
    formData.set('model', 'gpt-test');
    formData.append('categoryIds', 'category-1');
    formData.append('serverIds', 'server-1');

    await createAssistantTemplateAdminAction({}, formData);

    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.createAssistant).toHaveBeenCalledWith({
      slug: 'research-helper',
      name: 'Research helper',
      author: 'ToolPlane',
      summary: 'Research carefully.',
      iconUrl: null,
      tags: ['Research', 'writing'],
      categoryIds: ['category-1'],
      status: 'published',
      isFeatured: true,
      systemPrompt: 'Cite sources.',
      maxSteps: 1000,
      modelFormat: 'openai-compatible',
      model: 'gpt-test',
      serverIds: ['server-1'],
    }, 'admin-1');
    expect(mocks.redirect).toHaveBeenCalledWith('/admin/assistants');
  });

  it('rejects assistant templates above the shared tool-loop ceiling', async () => {
    const formData = new FormData();
    formData.set('directorySlug', 'research-helper');
    formData.set('name', 'Research helper');
    formData.set('author', 'ToolPlane');
    formData.set('maxSteps', '1001');

    await expect(createAssistantTemplateAdminAction({}, formData)).resolves.toEqual({
      error: 'errorInvalidAssistantTemplateConfig',
    });
    expect(mocks.createAssistant).not.toHaveBeenCalled();
  });

  it('publishes a new assistant template version and deletes only by explicit action', async () => {
    const formData = new FormData();
    formData.set('id', 'assistant-listing-1');
    formData.set('directorySlug', 'research-helper');
    formData.set('name', 'Research helper v2');
    formData.set('author', 'ToolPlane');
    formData.set('status', 'published');
    formData.set('maxSteps', '10');
    formData.append('categoryIds', 'category-1');

    await updateAssistantTemplateAdminAction({}, formData);
    expect(mocks.updateAssistant).toHaveBeenCalledWith(
      'assistant-listing-1',
      expect.objectContaining({ name: 'Research helper v2', maxSteps: 10 }),
      'admin-1',
    );

    const deleteData = new FormData();
    deleteData.set('id', 'assistant-listing-1');
    await deleteAssistantTemplateAdminAction({}, deleteData);
    expect(mocks.deleteAssistant).toHaveBeenCalledWith('assistant-listing-1');
  });
});
