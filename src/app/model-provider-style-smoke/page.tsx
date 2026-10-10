"use client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";
import { ModelPicker } from "@/components/dashboard/models/ModelPicker";
export default function Smoke() {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <main className="flex justify-end p-4">
        <ModelPicker
          value={null}
          onSelect={() => {}}
          trigger={<button type="button">Choose model</button>}
          providers={[
            {
              id: "openai",
              name: "OpenAI",
              models: ["gpt-4.1", "gpt-4.1-mini"],
              modelRecords: [
                {
                  modelId: "gpt-4.1",
                  primaryType: "text",
                  cost: { input: 2, output: 8 },
                },
              ],
            },
            { id: "anthropic", name: "Anthropic", models: ["claude-sonnet"] },
          ]}
        />
      </main>
    </NextIntlClientProvider>
  );
}
