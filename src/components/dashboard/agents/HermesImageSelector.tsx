'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DEFAULT_HERMES_IMAGE,
  HERMES_IMAGE_OPTIONS,
} from '@/lib/agents/hermes/constants';
import { NativeSelect } from '@/components/ui/NativeSelect';

const CUSTOM_IMAGE_OPTION = '__custom__';

function uniqueImages(images: readonly string[] | undefined) {
  const candidates = images?.length ? images : HERMES_IMAGE_OPTIONS;
  const normalized = candidates
    .map((image) => image.trim())
    .filter(Boolean);
  // Server-rendered callers may put an instance-level configured default
  // first. Preserve it while retaining the public latest image as a fallback
  // for standalone client uses.
  return [...new Set([...normalized, DEFAULT_HERMES_IMAGE])];
}

export function HermesImageSelector({
  id,
  images,
  value,
  name = 'hermesImage',
  disabled = false,
  onValueChange,
}: {
  id: string;
  images?: readonly string[];
  value?: string;
  name?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
}) {
  const t = useTranslations('console.agents');
  const availableImages = uniqueImages(images);
  const initialImage = value?.trim() || availableImages[0] || DEFAULT_HERMES_IMAGE;
  const isPreset = availableImages.includes(initialImage);
  const [selectedOption, setSelectedOption] = useState(
    isPreset ? initialImage : CUSTOM_IMAGE_OPTION,
  );
  const [customImage, setCustomImage] = useState(isPreset ? '' : initialImage);
  const selectedImage = selectedOption === CUSTOM_IMAGE_OPTION ? customImage : selectedOption;

  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={selectedImage} />
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('hermesVersion')}</span>
        <NativeSelect
          id={id}
          value={selectedOption}
          disabled={disabled}
          onChange={(event) => {
            event.stopPropagation();
            const next = event.target.value;
            setSelectedOption(next);
            if (next !== CUSTOM_IMAGE_OPTION) onValueChange?.(next);
          }}
          className="ui-input h-10 w-full font-mono text-sm disabled:opacity-60"
        >
          {availableImages.map((image) => (
            <option key={image} value={image}>
              {image === DEFAULT_HERMES_IMAGE ? `${t('hermesLatestStable')} — ${image}` : image}
            </option>
          ))}
          <option value={CUSTOM_IMAGE_OPTION}>{t('hermesCustomImage')}</option>
        </NativeSelect>
      </label>

      {selectedOption === CUSTOM_IMAGE_OPTION ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('hermesCustomImage')}</span>
          <input
            id={`${id}-custom`}
            value={customImage}
            onChange={(event) => {
              event.stopPropagation();
              const next = event.target.value;
              setCustomImage(next);
              onValueChange?.(next);
            }}
            disabled={disabled}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,254}"
            placeholder={t('hermesCustomImagePlaceholder')}
            className="ui-input h-10 w-full font-mono text-sm disabled:opacity-60"
          />
        </label>
      ) : null}

      <p className="text-xs leading-5 text-muted-foreground">{t('hermesImageHelp')}</p>
    </div>
  );
}
