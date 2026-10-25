import { z } from "zod";
import { A2A_LIMITS } from "./model";

const Id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const Target = z.string().regex(/^(agent|remote):[A-Za-z0-9_-]{1,200}$/);
export const PiCommunicationInputs = {
  peers: z.object({}).strict(),
  submit: z
    .object({
      target: Target,
      message: z.string().min(1).max(A2A_LIMITS.inputCharacters),
      messageId: Id,
    })
    .strict(),
  child: z.object({ target: Target, taskId: Id }).strict(),
};

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
      "Submit one idempotent delegation and return its public platform task ID.",
    schema: PiCommunicationInputs.submit,
  },
  {
    name: "pi_a2a_status",
    description: "Read a direct child task belonging to the specified target.",
    schema: PiCommunicationInputs.child,
  },
  {
    name: "pi_a2a_cancel",
    description:
      "Request child cancellation; stopping must still be confirmed.",
    schema: PiCommunicationInputs.child,
  },
] as const;
