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

import { useId, useRef, useState } from "react";
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
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
  useDirtyFields,
} from "@/components/dashboard/dialog";
import { SshSandboxCreate } from "./SshSandboxCreate";

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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 xl:grid-cols-2">
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
    <DialogFooter
      start={
        pending ? (
          <p role="status" className="text-sm">
            {t(
              isDocker
                ? "creatingSandboxRuntimeDescription"
                : "creatingConnectorSandboxDescription",
            )}
          </p>
        ) : null
      }
      cancel={<DialogCancel disabled={pending} />}
    >
      <SubmitButton
        flash={false}
        pendingLabel={t(isDocker ? "creatingContainer" : "creatingConnector")}
        variant="primary"
        size="md"
      >
        <Plus className="size-4" />
        {t(isDocker ? "createContainer" : "createConnector")}
      </SubmitButton>
    </DialogFooter>
  );
}

export function SandboxCreateForm({
  workspace,
  workspaceId,
}: {
  workspace: string;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode | "ssh">("docker");
  const [selectedImage, setSelectedImage] = useState(DEFAULT_SANDBOX_IMAGE);
  const [customImage, setCustomImage] = useState("");
  const t = useTranslations("console.sandboxes");

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
        className="flex max-h-[calc(100dvh-4rem)] max-w-6xl flex-col"
      >
        <DialogHeader
          title={t("newSandbox")}
          description={t("chooseASandboxSource")}
          className="border-b border-border"
        />
        <div className="grid gap-3 border-b border-border px-6 py-4 sm:grid-cols-3">
          <ModeButton
            active={mode === "docker"}
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
          <ModeButton
            active={mode === "ssh"}
            icon={Server}
            title={t("sshMode")}
            description={t("sshConnectionHint")}
            onClick={() => setMode("ssh")}
          />
        </div>
        {mode === "ssh" ? (
          <DialogBody>
            <SshSandboxCreate workspaceId={workspaceId} />
          </DialogBody>
        ) : (
          <SandboxCreateFields
            workspace={workspace}
            mode={mode}
            selectedImage={selectedImage}
            setSelectedImage={setSelectedImage}
            customImage={customImage}
            setCustomImage={setCustomImage}
          />
        )}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

function SandboxCreateFields({
  workspace,
  mode,
  selectedImage,
  setSelectedImage,
  customImage,
  setCustomImage,
}: {
  workspace: string;
  mode: Mode;
  selectedImage: string;
  setSelectedImage: (image: string) => void;
  customImage: string;
  setCustomImage: (image: string) => void;
}) {
  const [name, setName] = useState("");
  const [network, setNetwork] = useState("isolated");
  const t = useTranslations("console.sandboxes");
  const tCommon = useTranslations("common");
  const fieldId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useDirtyFields(formRef);
  const isDocker = mode === "docker";
  const customSelected = selectedImage === "custom";
  const imageDirty = selectedImage !== DEFAULT_SANDBOX_IMAGE;

  return (
    <form
      ref={formRef}
      action={createSandboxAction}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DialogBody>
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="kind" value={mode} />
        <input type="hidden" name="imageChoice" value={selectedImage} />

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[19rem_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="space-y-4 rounded-xl border border-border bg-muted/20 px-4 py-4">
              <DialogField
                label={t("name")}
                htmlFor={`${fieldId}-name`}
                dirty={name !== ""}
              >
                <Input
                  id={`${fieldId}-name`}
                  name="name"
                  onChange={setName}
                  placeholder={
                    isDocker ? t("researchContainer") : t("myLaptop")
                  }
                  className="w-full"
                />
              </DialogField>

              {isDocker ? (
                <DialogField
                  label={t("network")}
                  htmlFor={`${fieldId}-network`}
                  dirty={network !== "isolated"}
                  description={t(
                    "isolatedKeepsItOffTheAppdatabaseNetworkWhileAllowingInternetEgress",
                  )}
                >
                  <FormSelect
                    id={`${fieldId}-network`}
                    name="network"
                    defaultValue={network}
                    onValueChange={setNetwork}
                    label={t("network")}
                    options={[
                      { value: "isolated", label: t("isolated") },
                      { value: "none", label: t("none") },
                    ]}
                    className="w-full"
                  />
                </DialogField>
              ) : null}

              <DialogField
                label={t("environment")}
                htmlFor={`${fieldId}-environment`}
                description={t("environmentVariablesHint")}
              >
                <textarea
                  id={`${fieldId}-environment`}
                  name="env"
                  rows={5}
                  spellCheck={false}
                  placeholder={t("envPlaceholder")}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-28 w-full resize-y font-mono text-xs leading-5"
                />
              </DialogField>

              <div className="rounded-xl border border-border bg-background px-3 py-2">
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
            <RadioGroup value={selectedImage} onValueChange={setSelectedImage}>
              <div className="space-y-5">
                <div
                  data-dirty={imageDirty ? "true" : undefined}
                  className="rounded-xl border border-border bg-muted/15 px-4 py-3 data-[dirty=true]:border-primary/60 data-[dirty=true]:ring-1 data-[dirty=true]:ring-primary/50"
                >
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
                    <span className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
                      {imageDirty ? (
                        <span className="shrink-0 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {tCommon("modified")}
                        </span>
                      ) : null}
                      <AnimatedBadge status="neutral" size="sm">
                        {customSelected
                          ? customImage || t("customImage")
                          : selectedImage}
                      </AnimatedBadge>
                    </span>
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
                    <RadioGroupItem value="custom" label={t("customImage1")} />
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
              <div className="rounded-xl border border-border bg-muted/15 px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {t("connectAUserMachine")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(
                    "toolplaneGeneratesAOnetimeTokenTheUserRunsOneCommandAndTheConnectorCallsBackToThisServer",
                  )}
                </p>
              </div>

              <div className="rounded-xl border border-border bg-background px-4 py-3">
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
      </DialogBody>
      <CreateSandboxFooter mode={mode} />
    </form>
  );
}
