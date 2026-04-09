import type { Issue } from "@paperclipai/shared";
import { Bot, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

type IssueCreatorBadgeProps = {
  issue: Pick<Issue, "createdByAgentId" | "createdByUserId">;
  agentName: (id: string | null) => string | null;
  className?: string;
};

export function IssueCreatorBadge({ issue, agentName, className }: IssueCreatorBadgeProps) {
  const creatorName = issue.createdByAgentId
    ? (agentName(issue.createdByAgentId) ?? "Agent")
    : issue.createdByUserId
      ? "Board"
      : null;

  if (!creatorName) return null;

  const Icon = issue.createdByAgentId ? Bot : UserRound;

  return (
    <span
      title={`Created by ${creatorName}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border/40 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      <span>{`By ${creatorName}`}</span>
    </span>
  );
}
