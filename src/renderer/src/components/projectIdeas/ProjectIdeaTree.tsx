import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectIdea, ProjectIdeaStatus } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";
import type { ProjectIdeaTreeNode } from "../../utils/projectIdeaHierarchy";

const STATUS_LABEL_KEYS: Record<ProjectIdeaStatus, TranslationKey> = {
 inbox: "projectIdeas.status.inbox", planned: "projectIdeas.status.planned", doing: "projectIdeas.status.doing", done: "projectIdeas.status.done",
};

export function ProjectIdeaTree({ roots, selectedId, disabled, kindLabel, onSelect, onAddChild }: {
 roots: readonly ProjectIdeaTreeNode[];
 selectedId: string | null;
 disabled?: boolean;
 kindLabel: (kind: ProjectIdea["kind"]) => string;
 onSelect: (idea: ProjectIdea) => void;
 onAddChild?: (idea: ProjectIdea) => void;
}) {
 const renderNode = (node: ProjectIdeaTreeNode): ReactNode => (
  <div key={node.idea.id}>
   <div className="mb-1 flex items-start gap-1">
    <button type="button" disabled={disabled} className={cn("min-w-0 flex-1 rounded-md border border-transparent p-3 text-left hover:bg-muted", selectedId === node.idea.id && "border-border bg-muted", node.contextOnly && "opacity-75")} onClick={() => onSelect(node.idea)}>
     <span className="block truncate text-sm font-medium">{node.idea.title}</span>
     <span className="mt-1 block truncate text-xs text-muted-foreground">{kindLabel(node.idea.kind)} · {t(STATUS_LABEL_KEYS[node.idea.status])} · {node.idea.body || t("projectIdeas.noBody")}</span>
    </button>
    {onAddChild && <Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={t("projectIdeas.addFollowUpAria", { title: node.idea.title })} title={t("projectIdeas.addFollowUp")} onClick={() => onAddChild(node.idea)}><Plus className="size-4" /></Button>}
   </div>
   {node.children.length > 0 && <div className="ml-3 border-l border-border-subtle pl-2">{node.children.map((child) => renderNode(child))}</div>}
  </div>
 );
 return <>{roots.map((node) => renderNode(node))}</>;
}
