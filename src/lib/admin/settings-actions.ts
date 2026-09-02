'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import {
  MAX_ADMIN_ATTACHMENT_MEGABYTES,
  MIN_ADMIN_ATTACHMENT_MEGABYTES,
  resetAgentAttachmentLimit,
  setAgentAttachmentLimitBytes,
} from '@/lib/agents/attachment-limits';
import {
  isValidMcpStartupTimeouts,
  MAX_MCP_STARTUP_TIMEOUT_MS,
  MIN_MCP_STARTUP_TIMEOUT_MS,
  resetMcpStartupTimeoutSettings,
  resetRemoteMcpPrivateHostsSettings,
  updateHermesArchiveSettings,
  updateMcpStartupTimeoutSettings,
  updateRemoteMcpPrivateHostsSettings,
  updateSkillImportSettings,
} from '@/lib/admin/settings';
import { parseRemoteMcpPrivateHosts } from '../../../scripts/remote-mcp-private-hosts.mjs';
import {
  isValidHermesArchiveMaxUploadMiB,
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
} from '@/lib/agents/hermes/archive-limits';
import {
  isValidSkillImportMaxSkills,
  MAX_SKILL_IMPORT_SKILLS,
  MIN_SKILL_IMPORT_SKILLS,
} from '@/lib/skills/limits';

export type AdminSettingsActionState = { ok?: boolean; error?: string };

function parseWholeNumber(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function updateAgentAttachmentLimitAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');

  try {
    if (String(formData.get('intent') ?? '') === 'reset') {
      await resetAgentAttachmentLimit();
    } else {
      const megabytes = parseWholeNumber(formData, 'maxAttachmentSizeMb');
      if (
        megabytes === null
        || megabytes < MIN_ADMIN_ATTACHMENT_MEGABYTES
        || megabytes > MAX_ADMIN_ATTACHMENT_MEGABYTES
      ) {
        return { error: t('errorInvalidAttachmentLimit', {
          min: MIN_ADMIN_ATTACHMENT_MEGABYTES,
          max: MAX_ADMIN_ATTACHMENT_MEGABYTES,
        }) };
      }
      await setAgentAttachmentLimitBytes(megabytes * 1_000_000);
    }
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}

export async function updateHermesArchiveUploadLimitAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const hermesArchiveMaxUploadMiB = parseWholeNumber(formData, 'hermesArchiveMaxUploadMiB');
  if (!isValidHermesArchiveMaxUploadMiB(hermesArchiveMaxUploadMiB)) {
    return {
      error: t('errorHermesArchiveMaxUploadMiB', {
        min: MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
        max: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
      }),
    };
  }

  try {
    await updateHermesArchiveSettings(hermesArchiveMaxUploadMiB);
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}

export async function updateSkillImportLimitAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const maxSkills = parseWholeNumber(formData, 'skillImportMaxSkills');
  if (!isValidSkillImportMaxSkills(maxSkills)) {
    return {
      error: t('errorSkillImportMaxSkills', {
        min: MIN_SKILL_IMPORT_SKILLS,
        max: MAX_SKILL_IMPORT_SKILLS,
      }),
    };
  }

  try {
    await updateSkillImportSettings(maxSkills);
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}

export async function updateMcpStartupTimeoutSettingsAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');

  try {
    if (String(formData.get('intent') ?? '') === 'reset') {
      await resetMcpStartupTimeoutSettings();
    } else {
      const idleSeconds = parseWholeNumber(formData, 'mcpStartupIdleTimeoutSeconds');
      const maxSeconds = parseWholeNumber(formData, 'mcpStartupMaxTimeoutSeconds');
      const idleTimeoutMs = idleSeconds === null ? null : idleSeconds * 1_000;
      const maxTimeoutMs = maxSeconds === null ? null : maxSeconds * 1_000;
      if (
        idleTimeoutMs === null
        || maxTimeoutMs === null
        || !isValidMcpStartupTimeouts(idleTimeoutMs, maxTimeoutMs)
      ) {
        return {
          error: t('errorMcpStartupTimeouts', {
            min: MIN_MCP_STARTUP_TIMEOUT_MS / 1_000,
            max: MAX_MCP_STARTUP_TIMEOUT_MS / 1_000,
          }),
        };
      }
      await updateMcpStartupTimeoutSettings(idleTimeoutMs, maxTimeoutMs);
    }
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}

export async function updateRemoteMcpPrivateHostsSettingsAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');

  try {
    if (String(formData.get('intent') ?? '') === 'reset') {
      await resetRemoteMcpPrivateHostsSettings();
    } else {
      const value = formData.get('remoteMcpPrivateHosts');
      if (typeof value !== 'string' || !parseRemoteMcpPrivateHosts(value)) {
        return { error: t('errorRemoteMcpPrivateHosts') };
      }
      await updateRemoteMcpPrivateHostsSettings(value);
    }
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}
