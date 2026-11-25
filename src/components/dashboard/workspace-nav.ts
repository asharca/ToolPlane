import {
  Bot,
  Boxes,
  Brain,
  Cpu,
  Flag,
  FolderOpen,
  LibraryBig,
  MessageSquare,
  Plug,
  ScrollText,
  Settings,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";

type WorkspaceNavItem = {
  labelKey: string;
  segment: string;
  icon: LucideIcon;
  badgeKey?: string;
};

type WorkspaceNavGroup = {
  id: string;
  labelKey: string;
  items: WorkspaceNavItem[];
};

export const FEEDBACK_NAV_ITEM = {
  labelKey: "feedback",
  segment: "feedback",
  icon: Flag,
} as const;

export const WORKSPACE_NAV_GROUPS: WorkspaceNavGroup[] = [
  {
    id: "workspace",
    labelKey: "run",
    items: [
      { labelKey: "chat", segment: "chat", icon: MessageSquare },
      { labelKey: "agents", segment: "agents", icon: Bot },
    ],
  },
  {
    id: "build",
    labelKey: "build",
    items: [
      { labelKey: "mcpServers", segment: "mcp", icon: Plug },
      { labelKey: "skills", segment: "skills", icon: Brain },
      { labelKey: "plugins", segment: "plugins", icon: Store },
      {
        labelKey: "knowledge",
        segment: "knowledge",
        icon: LibraryBig,
        badgeKey: "inDevelopment",
      },
    ],
  },
  {
    id: "manage",
    labelKey: "manage",
    items: [
      { labelKey: "modelProviders", segment: "providers", icon: Cpu },
      { labelKey: "sandboxes", segment: "sandboxes", icon: Boxes },
      { labelKey: "observability", segment: "observability", icon: ScrollText },
      { labelKey: "members", segment: "members", icon: Users },
      { labelKey: "files", segment: "files", icon: FolderOpen },
      { labelKey: "settings", segment: "settings", icon: Settings },
    ],
  },
];
