"use client";

import { AnimatedBadge } from "@/components/motion/animated-badge";

import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import { RadioGroup, RadioGroupItem } from "@/components/motion/radio";

import { useId, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useFormStatus } from "react-dom";
import {
  Cable,
  Check,
  Container,
  Plus,
  Server,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { createSandboxAction } from "@/lib/sandboxes/actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_IMAGE_OPTIONS,
  type SandboxImageOption,
} from "@/lib/sandboxes/images";

type Mode = "docker" | "connector";

const recommendedImages = SANDBOX_IMAGE_OPTIONS.filter(
  (option) => option.category === "recommended",
);
const generalImages = SANDBOX_IMAGE_OPTIONS.filter(
  (option) => option.category === "general",
);

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function Field({
  label,
  children,
  className,
  hint,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  hint?: string;
  htmlFor: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cx(
        "space-y-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {label}
      {children}
      {hint ? (
        <span className="block text-[11px] font-normal normal-case leading-4 tracking-normal text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function ModeButton({
  active,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <div className="space-y-2">
      <Button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        variant={active ? "primary" : "secondary"}
        className="w-full"
      >
        <Icon className="size-4" />
        {title}
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

function ImageCard({
  option,
  selected,
  onSelect,
}: {
  option: SandboxImageOption;
  selected: boolean;
  onSelect: (image: string) => void;
}) {
  return (
    <div className="relative flex items-start gap-3 rounded-lg border border-border p-3">
      <button
        type="button"
        tabIndex={-1}
        aria-label={option.name}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(option.image)}
        className="absolute inset-0 rounded-lg"
      />
      <RadioGroupItem
        value={option.image}
        label={option.name}
        className="relative z-10"
      />
      <span
        className={cx(
          "pointer-events-none relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border",
          selected
            ? "border-primary/30 bg-background text-primary"
            : "border-border bg-muted text-muted-foreground",
        )}
      >
        {selected ? (
          <Check className="size-3.5" />
        ) : (
          <Server className="size-3.5" />
        )}
      </span>
      <span className="pointer-events-none relative min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <AnimatedBadge status="neutral" size="sm">
            {option.badge}
          </AnimatedBadge>
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {option.summary}
        </span>
        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground/80">
          {option.image}
        </span>
        <span className="mt-2 block text-[11px] font-medium text-foreground">
          {option.bestFor}
        </span>
      </span>
    </div>
  );
}

function ImageGroup({
  title,
  description,
  options,
  selectedImage,
  onSelect,
}: {
  title: string;
  description: string;
  options: readonly SandboxImageOption[];
  selectedImage: string;
  onSelect: (image: string) => void;
}) {
  const t = useTranslations("console.sandboxes");
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {options.length} {t("images")}
        </span>
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        {options.map((option) => (
          <ImageCard
            key={option.id}
            option={option}
            selected={selectedImage === option.image}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function CreateSandboxFooter({ mode }: { mode: Mode }) {
  const t = useTranslations("console.sandboxes");
  const { pending } = useFormStatus();
  const isDocker = mode === "docker";
  return (
    <div className="sticky bottom-0 -mx-5 mt-5 border-t border-border bg-card/95 px-5 py-4 backdrop-blur">
      {pending ? (
        <p role="status" className="mb-3 text-sm">
          {t(
            isDocker
              ? "creatingSandboxRuntimeDescription"
              : "creatingConnectorSandboxDescription",
          )}
        </p>
      ) : null}
      <div className="flex justify-end">
        <SubmitButton
          flash={false}
          pendingLabel={t(isDocker ? "creatingContainer" : "creatingConnector")}
          variant="primary"
          size="sm"
          className="w-full sm:w-auto"
        >
          <Plus className="size-4" />
          {t(isDocker ? "createContainer" : "createConnector")}
        </SubmitButton>
      </div>
    </div>
  );
}

export function SandboxCreateForm({ workspace }: { workspace: string }) {
  const [mode, setMode] = useState<Mode>("docker");
  const [selectedImage, setSelectedImage] = useState(DEFAULT_SANDBOX_IMAGE);
  const [customImage, setCustomImage] = useState("");
  const [open, setOpen] = useState(false);
  const t = useTranslations("console.sandboxes");
  const fieldId = useId();
  const isDocker = mode === "docker";
  const customSelected = selectedImage === "custom";

  return (
    <CenterMorphModal open={open} onOpenChange={setOpen}>
      <CenterMorphModalTrigger>
        <Button type="button" variant="primary">
          <Plus className="size-4" />
          {t("newSandbox")}
        </Button>
      </CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={t("newSandbox")}
        closeButtonLabel={t("close")}
        className="max-w-6xl"
      >
        <div className="flex items-start gap-4 border-b border-border pl-5 pr-16 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {t("newSandbox")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("chooseASandboxSource")}
            </p>
          </div>
        </div>

        <form
          action={createSandboxAction}
          className="min-h-0 overflow-y-auto p-5"
        >
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="kind" value={mode} />
          <input type="hidden" name="imageChoice" value={selectedImage} />

          <div className="grid gap-5 xl:grid-cols-[19rem_minmax(0,1fr)]">
            <div className="space-y-4">
              <div className="space-y-2">
                <ModeButton
                  active={isDocker}
                  icon={Container}
                  title={t("dockerContainer")}
                  description={t(
                    "managedLinuxWorkspaceWithPersistentFilesAndPackageInstalls",
                  )}
                  onClick={() => setMode("docker")}
                />
                <ModeButton
                  active={mode === "connector"}
                  icon={Cable}
                  title={t("userConnector")}
                  description={t(
                    "aUserRunsOneNpxCommandAndConnectsALocalMachineOverWebsocket",
                  )}
                  onClick={() => setMode("connector")}
                />
              </div>

              <div className="rounded-md border border-border bg-muted/20 px-3 py-3">
                <Input
                  label={t("name")}
                  name="name"
                  placeholder={
                    isDocker ? t("researchContainer") : t("myLaptop")
                  }
                />

                {isDocker ? (
                  <Field
                    label={t("network")}
                    htmlFor={`${fieldId}-network`}
                    className="mt-3"
                    hint={t(
                      "isolatedKeepsItOffTheAppdatabaseNetworkWhileAllowingInternetEgress",
                    )}
                  >
                    <div className="relative">
                      <FormSelect
                        id={`${fieldId}-network`}
                        name="network"
                        defaultValue="isolated"
                        label={t("network")}
                        options={[
                          { value: "isolated", label: t("isolated") },
                          { value: "none", label: t("none") },
                        ]}
                        className="w-full"
                      />
                    </div>
                  </Field>
                ) : null}

                <Field
                  label={t("environment")}
                  htmlFor={`${fieldId}-environment`}
                  className="mt-3"
                  hint={t("environmentVariablesHint")}
                >
                  <textarea
                    id={`${fieldId}-environment`}
                    name="env"
                    rows={5}
                    spellCheck={false}
                    placeholder={t("envPlaceholder")}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-28 w-full resize-y font-mono text-xs leading-5"
                  />
                </Field>

                <div className="mt-4 rounded-md border border-border bg-background px-3 py-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Sparkles className="size-3.5 text-muted-foreground" />
                    {t("recommendedChoices")}
                  </div>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                    <li>{t("frontendJavascriptNodeOrTypescriptNode")}</li>
                    <li>
                      {t("lightweightDebianBaseThenInstallOnlyWhatYouNeed")}
                    </li>
                    <li>{t("everythingUniversalLargerButBroad")}</li>
                  </ul>
                </div>
              </div>
            </div>

            {isDocker ? (
              <RadioGroup
                value={selectedImage}
                onValueChange={setSelectedImage}
              >
                <div className="space-y-5">
                  <div className="rounded-md border border-border bg-muted/15 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h2 className="text-sm font-semibold text-foreground">
                          {t("chooseADevContainerImage")}
                        </h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t(
                            "officialImagesFromMcrmicrosoftcomdevcontainersYouCanInstallMorePackagesAfterTheSandboxStarts",
                          )}
                        </p>
                      </div>
                      <AnimatedBadge status="neutral" size="sm">
                        {customSelected
                          ? customImage || t("customImage")
                          : selectedImage}
                      </AnimatedBadge>
                    </div>
                  </div>

                  <ImageGroup
                    title={t("mostUsedLanguageStacks")}
                    description={t("recommendedFirstChoicesForAgentWorkspaces")}
                    options={recommendedImages}
                    selectedImage={selectedImage}
                    onSelect={setSelectedImage}
                  />

                  <ImageGroup
                    title={t("generalPurposeImages")}
                    description={t(
                      "useTheseWhenYouWantASmallerBaseOrAWiderToolset",
                    )}
                    options={generalImages}
                    selectedImage={selectedImage}
                    onSelect={setSelectedImage}
                  />

                  <div className="rounded-lg border border-border p-3">
                    <span className="flex items-center gap-2">
                      <RadioGroupItem
                        value="custom"
                        label={t("customImage1")}
                      />
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t("useAnotherDockerImageWhenTheOfficialPresetsDoNotFit")}
                    </span>
                    <div className="relative mt-3">
                      <Input
                        leftIcon={<Server />}
                        name="customImage"
                        value={customImage}
                        onChange={(value) => {
                          setCustomImage(value);
                          setSelectedImage("custom");
                        }}
                        placeholder={t("ghcrioorgimagetag")}
                        className="w-full"
                      />
                    </div>
                  </div>
                </div>
              </RadioGroup>
            ) : (
              <div className="space-y-4">
                <div className="rounded-md border border-border bg-muted/15 px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">
                    {t("connectAUserMachine")}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t(
                      "toolplaneGeneratesAOnetimeTokenTheUserRunsOneCommandAndTheConnectorCallsBackToThisServer",
                    )}
                  </p>
                </div>

                <div className="rounded-md border border-border bg-background px-4 py-3">
                  <ol className="space-y-2 text-xs text-muted-foreground">
                    <li>{t("1CreateTheConnectorSandbox")}</li>
                    <li>{t("2CopyTheGeneratedNpxCommandFromTheDetailPage")}</li>
                    <li>
                      {t("3RunItOnTheUserMachineThatShouldBecomeTheSandbox")}
                    </li>
                  </ol>
                </div>
              </div>
            )}
          </div>
          <CreateSandboxFooter mode={mode} />
        </form>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
