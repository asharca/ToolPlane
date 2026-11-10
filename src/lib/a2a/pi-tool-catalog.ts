import { z } from "zod";
import { A2A_LIMITS } from "./model";
import { MAX_A2A_TASK_FILES } from "@/lib/transport-policy";

import { LocalFileInput } from "@/lib/agents/execution/tool-inputs";

const Id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const Target = z.string().regex(/^(agent|remote):[A-Za-z0-9_-]{1,200}$/);
const Child = z.object({ target: Target, taskId: Id }).strict();
export const PiCommunicationInputs = {
  peers: z.object({}).strict(),
  submit: z
    .object({
      target: Target,
      message: z.string().min(1).max(A2A_LIMITS.inputCharacters),
      messageId: Id,
      files: z.array(LocalFileInput).max(MAX_A2A_TASK_FILES).optional(),
      wait: z.boolean().optional(),
    })
    .strict(),
  child: Child,
  status: Child.extend({ retryFiles: z.boolean().optional() }).strict(),
};

/** pi_a2a_submit waits this long for the child before returning a pending receipt. */
export const PI_SUBMIT_WAIT_MS = 270_000;

/** Data-only catalogue: revision validation must not import executable dispatch. */
export const piCommunicationCatalog = [
  {
    name: "pi_a2a_peers",
    description:
      "List authorized internal and registered external Agent targets.",
    schema: PiCommunicationInputs.peers,
  },
  {
    name: "pi_a2a_submit",
    description:
      "Delegate one idempotent request and, by default, wait up to 4.5 minutes for the child's result; returns taskId with the child task and received files, or pending:true if it is still running (then use pi_a2a_status). Set wait:false to start several children before collecting their results with pi_a2a_status. Attach real sandbox files with files:[{path}] or task-owned files:[{fileId}] (administrator-configured per child task, default 20 files and 100 MiB of input); the receiver gets its own copy, never a shared path.",
    schema: PiCommunicationInputs.submit,
  },
  {
    name: "pi_a2a_status",
    description:
      "Read a direct child task and receive its ready files as task-owned handles and staged sandbox paths. retryFiles retries file reception only, never business execution.",
    schema: PiCommunicationInputs.status,
  },
  {
    name: "pi_a2a_cancel",
    description:
      "Request child cancellation; stopping must still be confirmed.",
    schema: PiCommunicationInputs.child,
  },
] as const;
