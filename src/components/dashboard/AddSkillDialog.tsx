"use client";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
  useDirtyFields,
} from "./dialog";

import { useTranslations } from "next-intl";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { Plus, FileText, GitBranch, Upload } from "lucide-react";
import {
  createCustomSkillAction,
  importSkillFromGithubAction,
  previewSkillUploadAction,
  uploadSkillFolderAction,
} from "@/lib/skills/actions";
import type { SkillActionState } from "@/lib/skills/actions";
import { normalizeSkillUploadForm } from "@/lib/skills/upload-form";
import {
  DEFAULT_SKILL_IMPORT_SKILLS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_IMPORT_BYTES,
  MAX_SKILL_IMPORT_FILES,
} from "@/lib/skills/limits";
import { FilePathTree } from "./FilePathTree";

type Mode = "menu" | "create" | "github" | "upload";
type FolderSelection = {
  paths: string[];
  skillRoots: string[];
  count: number;
  bytes: number;
  error: string | null;
};

const emptySelection: FolderSelection = {
  paths: [],
  skillRoots: [],
  count: 0,
  bytes: 0,
  error: null,
};
const directoryInputProps = {
  directory: "",
  webkitdirectory: "",
} as React.InputHTMLAttributes<HTMLInputElement> & {
  directory: string;
  webkitdirectory: string;
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function directoryName(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

function previewSkillRoots(paths: string[]): string[] {
  const roots = paths
    .filter((path) => /(^|\/)SKILL\.md$/i.test(path))
    .map(directoryName);
  return Array.from(new Set(roots)).sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}

function displaySkillRoots(roots: string[]): string[] {
  if (roots.length === 0) return [];
  if (roots.length === 1)
    return [roots[0].split("/").filter(Boolean).pop() || "SKILL.md"];
  const splitRoots = roots.map((root) => root.split("/").filter(Boolean));
  let common = 0;
  while (
    splitRoots.every(
      (parts) =>
        parts.length > common && parts[common] === splitRoots[0][common],
    )
  ) {
    common += 1;
  }
  return splitRoots.map(
    (parts) => parts.slice(common).join("/") || parts.at(-1) || "SKILL.md",
  );
}

type FormProps = {
  slug: string;
  cancel: React.ReactNode;
  onBack: () => void;
};

function BackButton({
  disabled,
  onBack,
}: {
  disabled: boolean;
  onBack: () => void;
}) {
  const t = useTranslations("console.skills");
  return (
    <Button
      type="button"
      variant="secondary"
      size="md"
      disabled={disabled}
      onClick={onBack}
    >
      {t("backToSources")}
    </Button>
  );
}

const rootsFieldsetClass =
  "space-y-2 rounded-lg border border-border p-3 data-[dirty=true]:border-primary/60 data-[dirty=true]:ring-1 data-[dirty=true]:ring-primary/50";

function ModifiedBadge() {
  const t = useTranslations("common");
  return (
    <span className="shrink-0 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
      {t("modified")}
    </span>
  );
}

function GithubImportForm({ slug, cancel, onBack }: FormProps) {
  const t = useTranslations("console.skills");
  const [state, formAction, isPending] = useActionState(
    importSkillFromGithubAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  useDirtyFields(formRef);
  const repoId = useId();
  const [preview, setPreview] = useState<SkillActionState | null>(null);
  const [selectedRoots, setSelectedRoots] = useState<string[]>([]);
  const [previewPending, startPreview] = useTransition();
  const previewRevision = useRef(0);
  const inspectSource = () => {
    const form = formRef.current;
    if (!form) return;
    const revision = ++previewRevision.current;
    const data = new FormData(form);
    startPreview(async () => {
      const result = await previewSkillUploadAction({}, data);
      if (revision !== previewRevision.current) return;
      setPreview(result);
      setSelectedRoots(
        result.preview?.map((entry) => entry.rootPath ?? "") ?? [],
      );
    });
  };
  useEffect(() => {
    if (state.error === t("importSourceChanged")) {
      previewRevision.current += 1;
      setPreview(null);
      setSelectedRoots([]);
    }
  }, [state, t]);
  return (
    <form
      ref={formRef}
      action={formAction}
      onReset={(event) => event.preventDefault()}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DialogBody>
        <input type="hidden" name="workspace" value={slug} />
        <DialogField label={t("importFromGithub")} htmlFor={repoId}>
          <input
            id={repoId}
            name="repo"
            required
            disabled={isPending || previewPending}
            placeholder="https://github.com/org/skills"
            onChange={() => {
              previewRevision.current += 1;
              setPreview(null);
              setSelectedRoots([]);
            }}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </DialogField>
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={isPending || previewPending}
          onClick={inspectSource}
        >
          {previewPending ? t("previewingGithub") : t("previewGithub")}
        </Button>
        {preview?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {preview.error}
          </p>
        ) : null}
        {preview?.preview ? (
          <fieldset
            data-dirty={
              selectedRoots.length !== preview.preview.length
                ? "true"
                : undefined
            }
            className={rootsFieldsetClass}
          >
            <legend className="flex items-center gap-2 text-sm font-medium">
              {t("importSelectRoots")}
              {selectedRoots.length !== preview.preview.length ? (
                <ModifiedBadge />
              ) : null}
            </legend>
            <input type="hidden" name="selectionMode" value="explicit" />
            <input
              type="hidden"
              name="sourceDigest"
              value={preview.sourceDigest ?? ""}
            />
            {preview.preview.map((entry) => {
              const rootPath = entry.rootPath ?? "";
              return (
                <label
                  key={rootPath}
                  className="flex items-start gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    name="roots"
                    value={rootPath}
                    checked={selectedRoots.includes(rootPath)}
                    onChange={(event) =>
                      setSelectedRoots((current) =>
                        event.target.checked
                          ? [...current, rootPath]
                          : current.filter((root) => root !== rootPath),
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">{entry.name}</span>
                    {entry.description ? (
                      <span className="block text-xs text-muted-foreground">
                        {entry.description}
                      </span>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">
                      {entry.fileCount} {t("filesSelected")}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter
        start={
          <BackButton disabled={isPending || previewPending} onBack={onBack} />
        }
        cancel={cancel}
      >
        <Button
          type="submit"
          disabled={
            isPending ||
            previewPending ||
            !preview?.preview ||
            selectedRoots.length === 0
          }
          variant="primary"
          size="md"
        >
          {isPending ? t("importing") : t("import")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CreateSkillForm({ slug, cancel, onBack }: FormProps) {
  const t = useTranslations("console.skills");
  const [state, formAction, isPending] = useActionState(
    createCustomSkillAction,
    {},
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameId = useId();
  const descriptionId = useId();
  return (
    <form
      action={formAction}
      onReset={(event) => event.preventDefault()}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DialogBody>
        <input type="hidden" name="workspace" value={slug} />
        <DialogField
          label={t("skillName")}
          htmlFor={nameId}
          dirty={name !== ""}
        >
          <Input
            id={nameId}
            name="name"
            required
            maxLength={80}
            placeholder={t("myAwesomeSkill")}
            onChange={setName}
            className="w-full"
          />
        </DialogField>
        <DialogField
          label={t("summarizeThisSkillsPurpose")}
          htmlFor={descriptionId}
          dirty={description !== ""}
        >
          <Input
            id={descriptionId}
            name="description"
            maxLength={280}
            placeholder={t("summarizeThisSkillsPurpose")}
            onChange={setDescription}
            className="w-full"
          />
        </DialogField>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter
        start={<BackButton disabled={isPending} onBack={onBack} />}
        cancel={cancel}
      >
        <Button type="submit" disabled={isPending} variant="primary" size="md">
          {isPending ? t("saving") : t("createSkill")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function UploadSkillForm({
  slug,
  maxSkillImportSkills,
  cancel,
  onBack,
}: FormProps & { maxSkillImportSkills: number }) {
  const t = useTranslations("console.skills");
  const [state, formAction, isPending] = useActionState(
    (previous: SkillActionState, data: FormData) =>
      uploadSkillFolderAction(previous, normalizeSkillUploadForm(data)),
    {},
  );
  const [folder, setFolder] = useState<FolderSelection>(emptySelection);
  const uploadForm = useRef<HTMLFormElement>(null);
  useDirtyFields(uploadForm);
  const archiveId = useId();
  const nameId = useId();
  const [name, setName] = useState("");
  const archiveInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const previewRevision = useRef(0);
  const [zipPreview, setZipPreview] = useState<SkillActionState | null>(null);
  const [selectedZipRoots, setSelectedZipRoots] = useState<string[]>([]);
  const [previewPending, startPreview] = useTransition();
  const previewZip = () => {
    const form = uploadForm.current;
    if (!form) return;
    const data = normalizeSkillUploadForm(new FormData(form));
    const archive = data.get("archive");
    if (!(archive instanceof File) || archive.size === 0) return;
    const revision = ++previewRevision.current;
    setZipPreview(null);
    setSelectedZipRoots([]);
    startPreview(async () => {
      const result = await previewSkillUploadAction({}, data);
      if (revision !== previewRevision.current) return;
      setZipPreview(result);
      setSelectedZipRoots(
        result.preview?.map((entry) => entry.rootPath ?? "") ?? [],
      );
    });
  };
  useEffect(() => {
    if (state.error === t("importSourceChanged")) {
      previewRevision.current += 1;
      setZipPreview(null);
      setSelectedZipRoots([]);
    }
  }, [state, t]);
  function onPickZip() {
    previewRevision.current += 1;
    if (folderInput.current) folderInput.current.value = "";
    setFolder(emptySelection);
    setZipPreview(null);
    setSelectedZipRoots([]);
  }
  function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    previewRevision.current += 1;
    if (archiveInput.current) archiveInput.current.value = "";
    setZipPreview(null);
    setSelectedZipRoots([]);
    const list = Array.from(e.target.files ?? []);
    const paths = list.map(
      (file) =>
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name,
    );
    const bytes = list.reduce((total, file) => total + file.size, 0);
    const skillRoots = previewSkillRoots(paths);
    let error: string | null = null;
    if (
      list.length > MAX_SKILL_IMPORT_FILES ||
      list.some((file) => file.size > MAX_SKILL_FILE_BYTES) ||
      bytes > MAX_SKILL_IMPORT_BYTES ||
      skillRoots.length > maxSkillImportSkills
    ) {
      error = t("selectedFolderTooLarge");
    } else if (list.length > 0 && skillRoots.length === 0) {
      error = t("folderMustContainSkillmd");
    }
    setFolder({ paths, skillRoots, count: list.length, bytes, error });
  }

  const displayedSkillRoots = displaySkillRoots(folder.skillRoots);
  const multipleRoots =
    folder.skillRoots.length > 1 || (zipPreview?.preview?.length ?? 0) > 1;
  return (
    <form
      ref={uploadForm}
      action={formAction}
      onReset={(event) => event.preventDefault()}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DialogBody>
        <input type="hidden" name="workspace" value={slug} />
        <DialogField label={t("zipArchive")} htmlFor={archiveId}>
          <input
            id={archiveId}
            ref={archiveInput}
            name="archive"
            type="file"
            accept=".zip,application/zip"
            disabled={isPending || previewPending}
            onChange={onPickZip}
            className="block w-full text-sm"
          />
        </DialogField>
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={isPending || previewPending}
          onClick={previewZip}
        >
          {previewPending ? t("previewingZip") : t("previewZip")}
        </Button>
        {zipPreview?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {zipPreview.error}
          </p>
        ) : null}
        {zipPreview?.preview ? (
          <fieldset
            data-dirty={
              selectedZipRoots.length !== zipPreview.preview.length
                ? "true"
                : undefined
            }
            className={rootsFieldsetClass}
          >
            <legend className="flex items-center gap-2 text-sm font-medium">
              {t("importSelectRoots")}
              {selectedZipRoots.length !== zipPreview.preview.length ? (
                <ModifiedBadge />
              ) : null}
            </legend>
            <input type="hidden" name="selectionMode" value="explicit" />
            <input
              type="hidden"
              name="sourceDigest"
              value={zipPreview.sourceDigest ?? ""}
            />
            {zipPreview.preview.map((entry) => {
              const rootPath = entry.rootPath ?? "";
              return (
                <label
                  key={rootPath}
                  className="flex items-start gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    name="roots"
                    value={rootPath}
                    checked={selectedZipRoots.includes(rootPath)}
                    onChange={(event) =>
                      setSelectedZipRoots((current) =>
                        event.target.checked
                          ? [...current, rootPath]
                          : current.filter((root) => root !== rootPath),
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">{entry.name}</span>
                    {entry.description ? (
                      <span className="block text-xs text-muted-foreground">
                        {entry.description}
                      </span>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">
                      {entry.fileCount} {t("filesSelected")}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
        <input
          type="hidden"
          name="filePaths"
          value={JSON.stringify(folder.paths)}
        />
        <DialogField
          label={t("skillName")}
          htmlFor={nameId}
          dirty={!multipleRoots && name !== ""}
        >
          <Input
            id={nameId}
            name="name"
            maxLength={80}
            disabled={multipleRoots}
            onChange={setName}
            placeholder={
              multipleRoots ? t("namesComeFromEachSkillFolder") : t("skillName")
            }
            className="w-full"
          />
        </DialogField>
        <label
          data-dirty={folder.count > 0 ? "true" : undefined}
          className="relative flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 px-4 py-5 text-center transition-colors hover:bg-muted data-[dirty=true]:border-primary/60 data-[dirty=true]:ring-1 data-[dirty=true]:ring-primary/50"
        >
          {folder.count > 0 ? (
            <span className="absolute right-2 top-2">
              <ModifiedBadge />
            </span>
          ) : null}
          <Upload className="size-5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            {t("uploadAFolder")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("dragInASkillFolder")}
          </span>
          <input
            {...directoryInputProps}
            ref={folderInput}
            name="folderFiles"
            type="file"
            disabled={isPending || previewPending}
            multiple
            onChange={onPickFolder}
            className="sr-only"
          />
        </label>
        <p
          className={`text-xs ${folder.error ? "text-destructive dark:text-destructive" : "text-muted-foreground"}`}
        >
          {folder.error ??
            `${folder.count} ${t("filesSelected")} · ${formatBytes(folder.bytes)}`}
        </p>
        {folder.paths.length ? (
          <div className="max-h-64 overflow-auto rounded-lg border border-border p-2">
            <FilePathTree
              files={folder.paths.map((path) => ({ path, value: path }))}
              ariaLabel={t("bundleFiles")}
              disabled={isPending}
            />
          </div>
        ) : null}
        {displayedSkillRoots.length > 0 ? (
          <div className="rounded-lg border border-border bg-muted/50 p-3">
            <p className="text-xs font-medium text-foreground">
              {t("willImportSkills", { count: displayedSkillRoots.length })}
            </p>
            <ul className="mt-2 max-h-36 space-y-1 overflow-auto">
              {displayedSkillRoots.slice(0, 8).map((root) => (
                <li
                  key={root}
                  className="truncate font-mono text-xs text-muted-foreground"
                >
                  {root}
                </li>
              ))}
            </ul>
            {displayedSkillRoots.length > 8 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("moreSkills", { count: displayedSkillRoots.length - 8 })}
              </p>
            ) : null}
          </div>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter
        start={<BackButton disabled={isPending} onBack={onBack} />}
        cancel={cancel}
      >
        <Button
          type="submit"
          disabled={
            isPending ||
            (folder.count === 0 &&
              (!zipPreview?.preview || selectedZipRoots.length === 0)) ||
            Boolean(folder.error)
          }
          variant="primary"
          size="md"
        >
          {isPending ? t("importing") : t("upload")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AddSkillDialog({
  slug,
  maxSkillImportSkills = DEFAULT_SKILL_IMPORT_SKILLS,
  defaultOpen = false,
  inline = false,
}: {
  slug: string;
  maxSkillImportSkills?: number;
  defaultOpen?: boolean;
  inline?: boolean;
}) {
  const t = useTranslations("console.skills");
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<Mode>("menu");
  const close = () => {
    setOpen(false);
    setMode("menu");
  };
  const cancel = inline ? undefined : <DialogCancel />;
  const modeTitle =
    mode === "create"
      ? t("createNew")
      : mode === "github"
        ? t("importFromGithub")
        : mode === "upload"
          ? t("importFromFiles")
          : undefined;
  const content = (
    <>
      <DialogHeader title={t("addASkill")} description={modeTitle} />
      {mode === "menu" ? (
        <>
          <DialogBody className="space-y-2">
            <Button
              type="button"
              onClick={() => setMode("github")}
              variant="secondary"
              size="md"
              className="h-auto w-full justify-start whitespace-normal py-3 text-left"
            >
              <GitBranch className="size-5 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {t("importFromGithub")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("pullASkillmdFromARepo")}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              onClick={() => setMode("upload")}
              variant="secondary"
              size="md"
              className="h-auto w-full justify-start whitespace-normal py-3 text-left"
            >
              <Upload className="size-5 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {t("uploadAFolder")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("dragInASkillFolder")}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              onClick={() => setMode("create")}
              variant="secondary"
              size="md"
              className="h-auto w-full justify-start whitespace-normal py-3 text-left"
            >
              <FileText className="size-5 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {t("createNew")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("startFromABlankSkillmd")}
                </span>
              </span>
            </Button>
          </DialogBody>
          {cancel ? <DialogFooter cancel={cancel} /> : null}
        </>
      ) : null}
      {mode === "create" ? (
        <CreateSkillForm
          slug={slug}
          cancel={cancel}
          onBack={() => setMode("menu")}
        />
      ) : null}
      {mode === "github" ? (
        <GithubImportForm
          slug={slug}
          cancel={cancel}
          onBack={() => setMode("menu")}
        />
      ) : null}
      {mode === "upload" ? (
        <UploadSkillForm
          slug={slug}
          cancel={cancel}
          maxSkillImportSkills={maxSkillImportSkills}
          onBack={() => setMode("menu")}
        />
      ) : null}
    </>
  );
  if (inline)
    return (
      <section className="flex flex-col rounded-lg border border-border">
        {content}
      </section>
    );
  return (
    <CenterMorphModal
      open={open}
      onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}
    >
      <CenterMorphModalTrigger>
        <Button type="button" variant="primary" size="md">
          <Plus className="size-4" /> {t("addSkill")}
        </Button>
      </CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={t("addASkill")}
        closeButtonLabel={t("close")}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col"
      >
        {content}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
