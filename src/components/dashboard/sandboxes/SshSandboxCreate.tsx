"use client";

import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { FormSelect } from "@/components/ui/FormSelect";

const SSH_ERROR_MESSAGES = {
  SSH_INVALID_INPUT: "sshErrorInvalidInput",
  SSH_HOST_UNRESOLVED: "sshErrorHostUnresolved",
  SSH_HOST_FORBIDDEN: "sshErrorHostForbidden",
  SSH_HOST_PRIVATE_NOT_ALLOWED: "sshErrorPrivateNotAllowed",
  SSH_HOST_UNREACHABLE: "sshErrorHostUnreachable",
  SSH_HOST_KEY_MISMATCH: "sshErrorHostKeyMismatch",
  SSH_AUTH_FAILED: "sshErrorAuthFailed",
  SSH_CREDENTIAL_INVALID: "sshErrorCredentialInvalid",
  SSH_REMOTE_NOT_READY: "sshErrorRemoteNotReady",
  SSH_CONNECT_FAILED: "sshErrorConnectFailed",
  SSH_RATE_LIMITED: "sshErrorRateLimited",
  SSH_UNAVAILABLE: "sshErrorUnavailable",
} as const;

type HostKeyScan = {
  address: string;
  hostKeys: { type: string; key: string; fingerprint: string }[];
};

export function SshSandboxCreate({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("console.sandboxes");
  const router = useRouter();
  const fieldId = useId();
  const hostInput = useRef<HTMLInputElement>(null);
  const portInput = useRef<HTMLInputElement>(null);
  const keyFileInput = useRef<HTMLInputElement>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [authType, setAuthType] = useState<"key" | "password">("key");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [scan, setScan] = useState<HostKeyScan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"scan" | "create" | "file" | null>(null);
  const [error, setError] = useState("");

  function errorMessage(code?: string) {
    return code && Object.hasOwn(SSH_ERROR_MESSAGES, code)
      ? t(SSH_ERROR_MESSAGES[code as keyof typeof SSH_ERROR_MESSAGES])
      : t("sshOperationFailed");
  }

  function clearScan() {
    setScan(null);
    setConfirmed(false);
    setError("");
  }

  function loadPrivateKey(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    setError("");
    setBusy("file");
    reader.onload = () => {
      setPrivateKey(typeof reader.result === "string" ? reader.result : "");
      setBusy(null);
    };
    reader.onerror = () => {
      setError(t("sshFileReadFailed"));
      setBusy(null);
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  async function detectHost() {
    if (
      busy ||
      !hostInput.current?.reportValidity() ||
      !portInput.current?.reportValidity()
    )
      return;
    clearScan();
    setBusy("scan");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/sandboxes/ssh/host-keys`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ host: host.trim(), port: Number(port) }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setError(errorMessage(result.code));
        return;
      }
      setScan(result as HostKeyScan);
    } catch {
      setError(t("sshOperationFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !scan || !confirmed) return;
    const data = new FormData(event.currentTarget);
    setBusy("create");
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/sandboxes/ssh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: data.get("name"),
            host: host.trim(),
            port: Number(port),
            username: data.get("username"),
            root: data.get("root"),
            auth:
              authType === "key"
                ? {
                    type: "key",
                    privateKey,
                    ...(passphrase ? { passphrase } : {}),
                  }
                : { type: "password", password },
            hostKeys: scan.hostKeys.map(({ type, key }) => ({ type, key })),
            acknowledgeHostAccess: data.get("ack") === "on",
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setError(errorMessage(result.code));
        setBusy(null);
        return;
      }
      router.push(result.consolePath);
      router.refresh();
    } catch {
      setError(t("sshOperationFailed"));
      setBusy(null);
    }
  }

  return (
    <form
      onSubmit={create}
      autoComplete="off"
      aria-busy={busy !== null}
      className="w-full max-w-lg space-y-4"
    >
      <fieldset
        disabled={busy !== null}
        className="space-y-4 disabled:opacity-60"
      >
        <Input label={t("sandboxName")} name="name" required maxLength={80} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <Input
            ref={hostInput}
            label={t("sshHost")}
            name="host"
            value={host}
            onChange={(value) => {
              setHost(value);
              clearScan();
            }}
            required
            autoCapitalize="none"
            spellCheck={false}
          />
          <Input
            ref={portInput}
            label={t("sshPort")}
            name="port"
            type="number"
            min={1}
            max={65535}
            step={1}
            required
            value={port}
            onChange={(value) => {
              setPort(value);
              clearScan();
            }}
          />
        </div>
        <Button
          type="button"
          onClick={detectHost}
          variant="secondary"
          size="sm"
        >
          {t(busy === "scan" ? "sshDetectingHost" : "sshDetectHost")}
        </Button>
        {scan ? (
          <div className="space-y-3 rounded-lg border border-border bg-muted/25 p-3">
            <p className="break-all text-sm">
              {t("sshResolvedAddress", { address: scan.address })}
            </p>
            <ul className="space-y-2">
              {scan.hostKeys.map((hostKey) => (
                <li
                  key={`${hostKey.type}:${hostKey.key}`}
                  className="space-y-1 text-xs"
                >
                  <span className="font-medium">{hostKey.type}</span>
                  <code className="block break-all font-mono">
                    {hostKey.fingerprint}
                  </code>
                </li>
              ))}
            </ul>
            <FormCheckbox
              name="confirmFingerprint"
              required
              checked={confirmed}
              onCheckedChange={setConfirmed}
              label={t("sshConfirmFingerprint")}
            />
          </div>
        ) : null}
        <Input
          label={t("sshUsername")}
          name="username"
          required
          autoCapitalize="none"
          spellCheck={false}
        />
        <Input
          label={t("sshRoot")}
          name="root"
          required
          pattern="/.*"
          placeholder={t("sshRootPlaceholder")}
          spellCheck={false}
        />
        <div className="space-y-1.5">
          <label
            htmlFor={`${fieldId}-auth`}
            className="block text-sm font-medium"
          >
            {t("sshAuthType")}
          </label>
          <FormSelect
            id={`${fieldId}-auth`}
            label={t("sshAuthType")}
            value={authType}
            onValueChange={(value) =>
              setAuthType(value === "password" ? "password" : "key")
            }
            options={[
              { value: "key", label: t("sshAuthKey") },
              { value: "password", label: t("sshAuthPassword") },
            ]}
          />
        </div>
        {authType === "key" ? (
          <>
            <div className="space-y-1.5">
              <label
                htmlFor={`${fieldId}-key`}
                className="block text-sm font-medium"
              >
                {t("sshPrivateKey")}
              </label>
              <textarea
                id={`${fieldId}-key`}
                name="privateKey"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                required
                rows={6}
                placeholder={t("sshPrivateKeyPlaceholder")}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full resize-y rounded-lg border border-border bg-muted/35 p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => keyFileInput.current?.click()}
              >
                {t("sshLoadPrivateKey")}
              </Button>
              <input
                ref={keyFileInput}
                type="file"
                hidden
                onChange={loadPrivateKey}
              />
            </div>
            <Input
              label={t("sshPassphrase")}
              name="passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={setPassphrase}
            />
          </>
        ) : (
          <Input
            label={t("sshPassword")}
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={setPassword}
          />
        )}
        <FormCheckbox name="ack" required label={t("sshHostAccessWarning")} />
        <Button
          type="submit"
          disabled={!scan || !confirmed}
          variant="primary"
          size="sm"
        >
          {t(busy === "create" ? "sshCreating" : "sshCreate")}
        </Button>
      </fieldset>
      {busy ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            busy === "create"
              ? "sshCreatingHint"
              : busy === "scan"
                ? "sshDetectingHost"
                : "sshReadingPrivateKey",
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
