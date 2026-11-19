"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { generateId, type FileUIPart } from "ai";
import { DisplayError } from "@/components/dashboard/display-error";
import { apiRequest } from "@/lib/client/api";

const MAX_ATTACHMENTS = 5;

export type DraftAttachment = {
  id: string;
  file: File;
};

/** Draft attachments, uploaded only when the message is sent. */
export function useAgentAttachments(attachmentUploadUrl?: string) {
  const t = useTranslations("console.agents");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const attachmentsRef = useRef(attachments);
  const updateAttachments = useCallback((next: DraftAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);
  const addAttachment = useCallback(
    (file: File) => {
      if (!attachmentUploadUrl)
        throw new DisplayError(t("attachmentRuntimeRequired"));
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS)
        throw new DisplayError(
          t("attachmentLimitReached", { count: MAX_ATTACHMENTS }),
        );
      updateAttachments([
        ...attachmentsRef.current,
        { id: generateId(), file },
      ]);
    },
    [attachmentUploadUrl, t, updateAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      updateAttachments(
        attachmentsRef.current.filter((item) => item.id !== id),
      );
    },
    [updateAttachments],
  );
  const takeAttachments = useCallback(() => {
    const snapshot = attachmentsRef.current;
    updateAttachments([]);
    return snapshot;
  }, [updateAttachments]);
  const restoreAttachments = useCallback(
    (snapshot: DraftAttachment[]) => {
      const fileKey = ({ file }: DraftAttachment) =>
        `${file.name}:${file.size}:${file.lastModified}`;
      const existingFiles = new Set(attachmentsRef.current.map(fileKey));
      const restored = snapshot.filter((attachment) => {
        const key = fileKey(attachment);
        if (existingFiles.has(key)) return false;
        existingFiles.add(key);
        return true;
      });
      updateAttachments([...restored, ...attachmentsRef.current]);
    },
    [updateAttachments],
  );
  const uploadAttachments = useCallback(
    async (snapshot: DraftAttachment[]): Promise<FileUIPart[]> => {
      if (!snapshot.length) return [];
      setUploading(true);
      try {
        if (!attachmentUploadUrl)
          throw new DisplayError(t("attachmentRuntimeRequired"));
        const parts: FileUIPart[] = [];
        for (const { file } of snapshot) {
          const url = new URL(attachmentUploadUrl, window.location.origin);
          url.searchParams.set("filename", file.name);
          const result = await apiRequest<{
            name?: string;
            mimeType?: string;
            url?: string;
          }>(`${url.pathname}${url.search}`, {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
            body: file,
          });
          const uploaded = result.ok ? result.data : undefined;
          if (!uploaded?.url)
            throw new DisplayError(
              (!result.ok && result.message) || t("attachmentUploadFailed"),
            );
          parts.push({
            type: "file",
            url: uploaded.url,
            filename: uploaded.name || file.name,
            mediaType:
              uploaded.mimeType || file.type || "application/octet-stream",
          });
        }
        return parts;
      } finally {
        setUploading(false);
      }
    },
    [attachmentUploadUrl, t],
  );
  return {
    attachments,
    addAttachment,
    removeAttachment,
    takeAttachments,
    restoreAttachments,
    uploadAttachments,
    uploading,
  };
}
