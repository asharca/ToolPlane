import { useRef, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProviderModelAutofill } from "@/components/dashboard/agents/ProviderModelAutofill";
import {
  defaultProviderModel,
  type PiModelReference,
  type ProviderModelValues,
} from "@/lib/agents/model-catalog";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/model-reference-actions", () => ({
  lookupProviderModelReferencesAction: lookup,
}));
beforeEach(() => {
  lookup.mockReset();
});

const reference: PiModelReference = {
  providerId: "openai",
  providerName: "OpenAI",
  modelId: "gpt-5",
  name: "GPT-5",
  api: "openai-responses",
  input: ["text", "image"],
  reasoning: true,
  contextWindow: 400000,
  maxOutputTokens: 128000,
  cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

function Editor({
  open = true,
  initialModel = defaultProviderModel("gpt-5"),
}: {
  open?: boolean;
  initialModel?: ProviderModelValues;
}) {
  const [model, setModel] = useState(initialModel);
  const manualFields = useRef(new Set<keyof ProviderModelValues>());
  return (
    <>
      <input
        aria-label="Model ID"
        value={model.modelId}
        onChange={(event) => setModel(defaultProviderModel(event.target.value))}
      />
      <input
        aria-label="Context window"
        value={model.contextWindow ?? ""}
        onChange={(event) => {
          manualFields.current.add("contextWindow");
          setModel((current) => ({
            ...current,
            contextWindow: event.target.value
              ? Number(event.target.value)
              : null,
          }));
        }}
      />
      <input
        aria-label="Input price"
        readOnly
        value={model.cost?.input ?? ""}
      />
      <input
        aria-label="Output limit"
        readOnly
        value={model.maxOutputTokens ?? ""}
      />
      <ProviderModelAutofill
        slug="acme"
        providerId="provider-1"
        modelId={model.modelId}
        name={model.name}
        open={open}
        setModel={setModel}
        manualFields={manualFields}
      />
    </>
  );
}

it("ignores obsolete query responses and fills the current model only", async () => {
  const pending: Array<(result: { matches: PiModelReference[] }) => void> = [];
  lookup.mockImplementation(() => {
    const { promise, resolve } = Promise.withResolvers<{
      matches: PiModelReference[];
    }>();
    pending.push(resolve);
    return promise;
  });
  render(<Editor />);
  await waitFor(() => expect(pending).toHaveLength(1));
  fireEvent.change(screen.getByLabelText("Model ID"), {
    target: { value: "unknown-model" },
  });
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => {
    pending[1]({ matches: [] });
    pending[0]({ matches: [reference] });
  });
  expect(screen.getByLabelText("Input price")).toHaveValue("");
  expect(screen.getByLabelText("Context window")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Model ID"), {
    target: { value: "gpt-5" },
  });
  await waitFor(() => expect(pending).toHaveLength(3));
  await act(async () => {
    pending[2]({ matches: [reference] });
  });
  expect(screen.getByLabelText("Input price")).toHaveValue("1.25");
  expect(screen.getByLabelText("Context window")).toHaveValue("400000");
  fireEvent.change(screen.getByLabelText("Model ID"), {
    target: { value: "" },
  });
  expect(screen.getByLabelText("Input price")).toHaveValue("");
});

it("fills missing metadata without replacing saved prices or late manual edits, including cleared limits", async () => {
  const { promise, resolve } = Promise.withResolvers<{
    matches: PiModelReference[];
  }>();
  lookup.mockReturnValue(promise);
  render(
    <Editor
      initialModel={{
        ...defaultProviderModel("gpt-5"),
        cost: { ...reference.cost, input: 7 },
      }}
    />,
  );
  await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("Context window"), {
    target: { value: "99" },
  });
  fireEvent.change(screen.getByLabelText("Context window"), {
    target: { value: "" },
  });
  await act(async () => {
    resolve({ matches: [reference] });
  });
  expect(screen.getByLabelText("Context window")).toHaveValue("");
  expect(screen.getByLabelText("Input price")).toHaveValue("7");
  expect(screen.getByLabelText("Output limit")).toHaveValue("128000");
});

it("ignores a response after the editor closes", async () => {
  const { promise, resolve } = Promise.withResolvers<{
    matches: PiModelReference[];
  }>();
  lookup.mockReturnValue(promise);
  const { rerender } = render(<Editor />);
  await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
  rerender(<Editor open={false} />);
  await act(async () => {
    resolve({ matches: [reference] });
  });
  expect(screen.getByLabelText("Input price")).toHaveValue("");
});
