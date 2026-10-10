"use client";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  DEFAULT_HERMES_IMAGE,
  HERMES_IMAGE_OPTIONS,
} from "@/lib/agents/hermes/constants";

const CUSTOM_IMAGE_OPTION = "__custom__";

function uniqueImages(images: readonly string[] | undefined) {
  const candidates = images?.length ? images : HERMES_IMAGE_OPTIONS;
  const normalized = candidates.map((image) => image.trim()).filter(Boolean);
  // Server-rendered callers may put an instance-level configured default
  // first. Preserve it while retaining the public latest image as a fallback
  // for standalone client uses.
  return [...new Set([...normalized, DEFAULT_HERMES_IMAGE])];
}

export function HermesImageSelector({
  id,
  images,
  value,
  name = "hermesImage",
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
  const t = useTranslations("console.agents");
  const availableImages = uniqueImages(images);
  const initialImage =
    value?.trim() || availableImages[0] || DEFAULT_HERMES_IMAGE;
  const isPreset = availableImages.includes(initialImage);
  const [selectedOption, setSelectedOption] = useState(
    isPreset ? initialImage : CUSTOM_IMAGE_OPTION,
  );
  const [customImage, setCustomImage] = useState(isPreset ? "" : initialImage);
  const selectedImage =
    selectedOption === CUSTOM_IMAGE_OPTION ? customImage : selectedOption;

  return (
    <div className="space-y-2" onChange={(event) => event.stopPropagation()}>
      <input type="hidden" name={name} value={selectedImage} />
      <div className="block">
        <span className="mb-1.5 block text-xs font-semibold text-foreground">
          {t("hermesVersion")}
        </span>
        <FormSelect
          id={id}
          value={selectedOption}
          disabled={disabled}
          label={t("hermesVersion")}
          options={[
            availableImages.map((image) => ({
              value: image,
              label:
                image === DEFAULT_HERMES_IMAGE
                  ? `${t("hermesLatestStable")} — ${image}`
                  : image,
            })),
            { value: CUSTOM_IMAGE_OPTION, label: t("hermesCustomImage") },
          ]
            .flat()
            .filter((option) => option != null)}
          onValueChange={(value) => {
            const next = value;
            setSelectedOption(next);
            if (next !== CUSTOM_IMAGE_OPTION) onValueChange?.(next);
          }}
          className="w-full"
        />
      </div>

      {selectedOption === CUSTOM_IMAGE_OPTION ? (
        <div className="block">
          <Input
            label={t("hermesCustomImage")}
            id={`${id}-custom`}
            disabled={disabled}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,254}"
            placeholder={t("hermesCustomImagePlaceholder")}
            value={String(customImage)}
            className="w-full"
            onChange={(value) => {
              const next = value;
              setCustomImage(next);
              onValueChange?.(next);
            }}
          />
        </div>
      ) : null}

      <p className="text-xs leading-5 text-muted-foreground">
        {t("hermesImageHelp")}
      </p>
    </div>
  );
}
