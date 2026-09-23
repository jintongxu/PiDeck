import { LoaderCircle, Sparkles } from "lucide-react";
import type { ProjectIdeaKind, ProjectIdeaRefinement } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Textarea } from "../ui-shadcn/textarea";
import { Checkbox } from "../ui-shadcn/checkbox";

export type ProjectIdeaRefinementPanelProps = {
	value: ProjectIdeaRefinement | undefined;
	confirmed: boolean;
	running: boolean;
	disabled?: boolean;
	error: string | null;
	canUseContext: boolean;
	useContext: boolean;
	onUseContextChange: (value: boolean) => void;
	onChange: (value: ProjectIdeaRefinement) => void;
	onRefine: () => void;
	onAccept: () => void;
	kind?: ProjectIdeaKind;
};

function updateList(value: ProjectIdeaRefinement, key: "scope" | "acceptanceCriteria" | "openQuestions", text: string): ProjectIdeaRefinement {
	return { ...value, [key]: text.split("\n").map((item) => item.trim()).filter(Boolean) };
}

/** Editable preview of the AI clarification; raw idea text stays outside this panel. */
export function ProjectIdeaRefinementPanel(props: ProjectIdeaRefinementPanelProps) {
	const value = props.value;
	const brainstorm = props.kind === "brainstorm";
	return (
		<section className="rounded-lg border border-primary/30 bg-primary/5 p-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-primary" />{t(brainstorm ? "projectIdeas.brainstormRefinementTitle" : "projectIdeas.refinementTitle")}{props.confirmed && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">{t("projectIdeas.refinementConfirmed")}</span>}</div>
				<Button type="button" size="sm" variant="ghost" onClick={props.onRefine} disabled={props.running || props.disabled}>
					{props.running && <LoaderCircle className="size-3.5 animate-spin" />}{props.running ? t("projectIdeas.refining") : t("projectIdeas.refineAgain")}
				</Button>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">{t(brainstorm ? "projectIdeas.brainstormRefinementHint" : "projectIdeas.refinementHint")}</p>
			{props.canUseContext && (
				<label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
					<Checkbox checked={props.useContext} disabled={props.disabled} onCheckedChange={(checked) => props.onUseContextChange(checked === true)} />
					{t("projectIdeas.refinementUseContext")}
				</label>
			)}
			{props.error && <p className="mt-2 text-xs text-destructive">{props.error}</p>}
			{value ? (
				<div className="mt-3 grid gap-2">
					<label className="grid gap-1 text-xs font-medium">{t(brainstorm ? "projectIdeas.brainstormSummary" : "projectIdeas.refinementSummary")}<Textarea disabled={props.disabled} className="min-h-16 resize-y text-sm font-normal" value={value.summary} onChange={(event) => props.onChange({ ...value, summary: event.target.value })} /></label>
					<label className="grid gap-1 text-xs font-medium">{t(brainstorm ? "projectIdeas.brainstormBackground" : "projectIdeas.refinementProblem")}<Textarea disabled={props.disabled} className="min-h-16 resize-y text-sm font-normal" value={value.problem} onChange={(event) => props.onChange({ ...value, problem: event.target.value })} /></label>
					<label className="grid gap-1 text-xs font-medium">{t(brainstorm ? "projectIdeas.brainstormGoal" : "projectIdeas.refinementGoal")}<Textarea disabled={props.disabled} className="min-h-16 resize-y text-sm font-normal" value={value.goal} onChange={(event) => props.onChange({ ...value, goal: event.target.value })} /></label>
					<label className="grid gap-1 text-xs font-medium">{t(brainstorm ? "projectIdeas.brainstormOutcome" : "projectIdeas.refinementOutcome")}<Textarea disabled={props.disabled} className="min-h-16 resize-y text-sm font-normal" value={value.expectedOutcome} onChange={(event) => props.onChange({ ...value, expectedOutcome: event.target.value })} /></label>
					<label className="grid gap-1 text-xs font-medium">{t(brainstorm ? "projectIdeas.brainstormOptions" : "projectIdeas.refinementScope")}<Textarea disabled={props.disabled} className="min-h-16 resize-y text-sm font-normal" value={value.scope.join("\n")} onChange={(event) => props.onChange(updateList(value, "scope", event.target.value))} /></label>
					<label className="grid gap-1 text-xs font-medium">{t(brainstorm ? "projectIdeas.brainstormTradeoffs" : "projectIdeas.refinementAcceptance")}<Textarea disabled={props.disabled} className="min-h-16 resize-y text-sm font-normal" value={value.acceptanceCriteria.join("\n")} onChange={(event) => props.onChange(updateList(value, "acceptanceCriteria", event.target.value))} /></label>
					<label className="grid gap-1 text-xs font-medium">{t("projectIdeas.refinementQuestions")}<Textarea disabled={props.disabled} className="min-h-16 resize-y text-sm font-normal" value={value.openQuestions.join("\n")} onChange={(event) => props.onChange(updateList(value, "openQuestions", event.target.value))} /></label>
					<Button type="button" size="sm" className="justify-self-end" onClick={props.onAccept} disabled={!value.summary.trim() || props.running || props.disabled}>{props.confirmed ? t("projectIdeas.refinementConfirmed") : t("projectIdeas.acceptRefinement")}</Button>
				</div>
			) : !props.running ? <p className="mt-3 text-xs text-muted-foreground">{t("projectIdeas.refinementEmpty")}</p> : null}
		</section>
	);
}
