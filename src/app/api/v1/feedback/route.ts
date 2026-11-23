import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import {
  FeedbackServiceError,
  listUserFeedback,
  submitUserFeedback,
} from "@/lib/feedback/service";
import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";

const headers = { "Cache-Control": "private, no-store" };

export const GET = withRequestLogging(
  "/api/v1/feedback",
  async (req: Request) => {
    const user = await resolveRequestUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers },
      );
    }

    const items = await listUserFeedback(user.id);
    return NextResponse.json({ items }, { status: 200, headers });
  },
);

export const POST = withRequestLogging(
  "/api/v1/feedback",
  async (req: Request) => {
    const user = await resolveRequestUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "INVALID_JSON" },
        { status: 400, headers },
      );
    }

    try {
      const item = await submitUserFeedback(user.id, body);
      return NextResponse.json({ item }, { status: 201, headers });
    } catch (error) {
      if (error instanceof FeedbackServiceError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: error.status, headers },
        );
      }
      if (error instanceof ZodError) {
        return NextResponse.json(
          { error: "INVALID_FEEDBACK_INPUT" },
          { status: 400, headers },
        );
      }
      return NextResponse.json(
        { error: "FEEDBACK_SUBMIT_FAILED" },
        { status: 500, headers },
      );
    }
  },
);
