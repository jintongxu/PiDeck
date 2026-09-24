import type { ProjectIdeaPlan } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { LoaderCircle, Sparkles } from "lucide-react";

export function ProjectIdeaPlansPanel(props: {
	plans: readonly ProjectIdeaPlan[];
	running: boolean;
	error: string | null;
	disabled?: boolean;
	onExtract: () => void;
	onAdopt: (plan: ProjectIdeaPlan) => void;
}) {
	const errorMessage = props.error === "PROJECT_IDEA_PLANS_EMPTY"
		? t("projectIdeas.plansEmpty")
		: props.error === "PROJECT_IDEA_PLANS_RESPONSE_INVALID"
			? t("projectIdeas.plansInvalid")
			: props.error === "PROJECT_IDEA_PLANS_SOURCE_SESSION_EMPTY"
				? t("projectIdeas.plansSourceEmpty")
				: props.error === "PROJECT_IDEA_PLANS_SOURCE_SESSION_UNAVAILABLE"
					? t("projectIdeas.plansSourceUnavailable")
					: props.error === "PROJECT_IDEA_PLANS_TIMEOUT"
						? t("projectIdeas.plansTimeout")
						: props.error;
	return (
		<section className="rounded-lg border border-primary/30 bg-primary/5 p-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-primary" />{t("projectIdeas.plansTitle")}</div>
				<Button type="button" size="sm" variant="ghost" onClick={props.onExtract} disabled={props.disabled || props.running}>
					{props.running && <LoaderCircle className="size-3.5 animate-spin" />}{props.running ? t("projectIdeas.plansExtracting") : t("projectIdeas.plansExtract")}
				</Button>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">{t("projectIdeas.plansHint")}</p>
			{errorMessage && <p className="mt-2 text-xs text-destructive">{errorMessage}</p>}
			{props.plans.length > 0 && <div className="mt-3 grid gap-2">
				{props.plans.map((plan) => <article key={plan.id} className="rounded-md border border-border-subtle bg-background p-3">
					<div className="flex items-start justify-between gap-3"><div><h4 className="text-sm font-semibold">{plan.title}</h4><p className="mt-1 text-sm text-muted-foreground">{plan.summary}</p></div><Button type="button" size="sm" onClick={() => props.onAdopt(plan)} disabled={props.disabled}>{t("projectIdeas.adoptPlan")}</Button></div>
					<div className="mt-2 grid gap-1 text-xs text-muted-foreground">
						{plan.goal && <p><strong>{t("projectIdeas.planGoal")}：</strong>{plan.goal}</p>}
						{plan.scope.length > 0 && <p><strong>{t("projectIdeas.planScope")}：</strong>{plan.scope.join("；")}</p>}
						{plan.advantages.length > 0 && <p><strong>{t("projectIdeas.planAdvantages")}：</strong>{plan.advantages.join("；")}</p>}
						{plan.disadvantages.length > 0 && <p><strong>{t("projectIdeas.planDisadvantages")}：</strong>{plan.disadvantages.join("；")}</p>}
						{plan.risks.length > 0 && <p><strong>{t("projectIdeas.planRisks")}：</strong>{plan.risks.join("；")}</p>}
						{plan.openQuestions.length > 0 && <p><strong>{t("projectIdeas.planQuestions")}：</strong>{plan.openQuestions.join("；")}</p>}
					</div>
				</article>)}
			</div>}
		</section>
	);
}
