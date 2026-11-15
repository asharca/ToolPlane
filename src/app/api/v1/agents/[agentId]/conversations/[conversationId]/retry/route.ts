import { conversationTreePost } from "@/lib/agents/conversation-tree-http";

export const runtime = "nodejs";
export const maxDuration = 900;
export const POST = conversationTreePost("retry");
