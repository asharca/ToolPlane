"use client";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";

import { useTranslations } from "next-intl";
import {
  useActionState,
  useEffect,
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

function GithubImportForm({
  slug,
  onBack,
}: {
  slug: string;
  onBack: () => void;
}) {
  const t = useTranslations("console.skills");
  const [state, formAction, isPending] = useActionState(
    importSkillFromGithubAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
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
      className="space-y-3"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending || previewPending}
        onClick={onBack}
      >
        {t("backToSources")}
      </Button>
      <h3 className="font-medium">{t("importFromGithub")}</h3>
      <input type="hidden" name="workspace" value={slug} />
      <label className="block space-y-1 text-sm">
        <span>{t("importFromGithub")}</span>
        <input
          name="repo"
          required
          disabled={isPending || previewPending}
          placeholder="https://github.com/org/skills"
          onChange={() => {
            previewRevision.current += 1;
            setPreview(null);
            setSelectedRoots([]);
          }}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </label>
      <Button
        type="button"
        variant="secondary"
        size="sm"
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
        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="text-sm font-medium">
            {t("importSelectRoots")}
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
              <label key={rootPath} className="flex items-start gap-2 text-sm">
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
        className="w-full"
      >
        {isPending ? t("importing") : t("import")}
      </Button>
    </form>
  );
}

function CreateSkillForm({
  slug,
  onBack,
}: {
  slug: string;
  onBack: () => void;
}) {
  const t = useTranslations("console.skills");
  const [state, formAction, isPending] = useActionState(
    createCustomSkillAction,
    {},
  );
  return (
    <form
      action={formAction}
      onReset={(event) => event.preventDefault()}
      className="space-y-3"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={onBack}
      >
        {t("backToSources")}
      </Button>
      <h3 className="font-medium">{t("createNew")}</h3>
      <input type="hidden" name="workspace" value={slug} />
      <Input
        label={t("skillName")}
        name="name"
        required
        maxLength={80}
        placeholder={t("myAwesomeSkill")}
      />
      <Input
        label={t("summarizeThisSkillsPurpose")}
        name="description"
        maxLength={280}
        placeholder={t("summarizeThisSkillsPurpose")}
      />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={isPending}
        variant="primary"
        className="w-full"
      >
        {isPending ? t("saving") : t("createSkill")}
      </Button>
    </form>
  );
}

function UploadSkillForm({
  slug,
  maxSkillImportSkills,
  onBack,
}: {
  slug: string;
  maxSkillImportSkills: number;
  onBack: () => void;
}) {
  const t = useTranslations("console.skills");
  const [state, formAction, isPending] = useActionState(
    (previous: SkillActionState, data: FormData) =>
      uploadSkillFolderAction(previous, normalizeSkillUploadForm(data)),
    {},
  );
  const [folder, setFolder] = useState<FolderSelection>(emptySelection);
  const uploadForm = useRef<HTMLFormElement>(null);
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
      className="space-y-3"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={onBack}
      >
        {t("backToSources")}
      </Button>
      <h3 className="font-medium">{t("importFromFiles")}</h3>
      <input type="hidden" name="workspace" value={slug} />
      <label className="block space-y-1 text-sm">
        <span>{t("zipArchive")}</span>
        <input
          ref={archiveInput}
          name="archive"
          type="file"
          accept=".zip,application/zip"
          disabled={isPending || previewPending}
          onChange={onPickZip}
          className="block w-full text-sm"
        />
      </label>
      <Button
        type="button"
        variant="secondary"
        size="sm"
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
        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="text-sm font-medium">
            {t("importSelectRoots")}
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
              <label key={rootPath} className="flex items-start gap-2 text-sm">
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
      <Input
        name="name"
        label={t("skillName")}
        maxLength={80}
        disabled={multipleRoots}
        placeholder={
          multipleRoots ? t("namesComeFromEachSkillFolder") : t("skillName")
        }
      />
      <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 px-4 py-5 text-center transition-colors hover:bg-muted">
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
        className="w-full"
      >
        {isPending ? t("importing") : t("upload")}
      </Button>
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
  const content = (
    <>
      <div className="mb-4 flex items-center pr-10">
        <h2 className="text-lg font-semibold text-foreground">
          {t("addASkill")}
        </h2>
      </div>
      {mode === "menu" ? (
        <div className="space-y-2">
          <Button
            type="button"
            onClick={() => setMode("github")}
            variant="secondary"
            size="lg"
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
        </div>
      ) : null}
      {mode === "create" ? (
        <CreateSkillForm slug={slug} onBack={() => setMode("menu")} />
      ) : null}
      {mode === "github" ? (
        <GithubImportForm slug={slug} onBack={() => setMode("menu")} />
      ) : null}
      {mode === "upload" ? (
        <UploadSkillForm
          slug={slug}
          maxSkillImportSkills={maxSkillImportSkills}
          onBack={() => setMode("menu")}
        />
      ) : null}
    </>
  );
  if (inline)
    return (
      <section className="space-y-3 rounded-lg border border-border p-4">
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
        className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto p-6"
      >
        {content}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
