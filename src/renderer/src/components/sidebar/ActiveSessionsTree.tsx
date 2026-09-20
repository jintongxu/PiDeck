import { Ellipsis, Lightbulb } from "lucide-react";
import type { DragEvent } from "react";
import { useAtomValue } from "jotai";
import type { AgentTab, SessionRecord } from "../../../../shared/types";
import { sidebarSessionOrderIndex, type SidebarDropPosition } from "../../../../shared/sidebarSessionOrder";
import { sessionStatusDotClass } from "../../agentListDisplay";
import { sessionRecordToSummary } from "../../atoms";
import { sessionRuntimeUiByIdAtom } from "../../atoms/session-atoms";
import { hasPendingAskForSession } from "../../utils/askUi";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import type { SidebarController } from "../../hooks/useSidebarController";
import type { SidebarActions } from "./SidebarContent";
import { Button } from "../ui-shadcn/button";
import { PendingAskBadge } from "./PendingAskBadge";
import { SessionBackendMark } from "../session/SessionSourceBadge";
import { SessionHoverCard } from "./SessionHoverCard";
import { TitleScrollText } from "./TitleScrollText";
import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";
import { formatRelativeTime } from "../../utils/relativeTime";

/** 活动页行样式：与 SessionTree 会话行同尺寸同圆角，但选中底不需要（活动页行不持久）。 */
const activeRowClass =
	"group/resource conversation agent-row relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

/** 会话行右侧操作组：想法与更多操作共用一个悬浮容器，避免两个 absolute 按钮互相覆盖。 */
const rowActionsClass =
	"row-more-actions pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";
/** 项目想法按钮位于「更多」左侧，两个入口各自占一个固定槽位。 */
const rowIdeaActionClass = rowActionsClass.replace("right-1", "right-8");

/**
 * 活动 Agent 会话页：跨项目收集所有已绑定 runtime 的 Agent（live + 终态），按会话更新时间排序。
 * 活动行身份与 SessionTree 的 agent 行一致（状态点 + 标题 + 后端标记 + 相对时间），
 * 点击打开绑定会话（单击 preview / 双击 permanent），右键打开 Agent 菜单，支持拖拽分屏。
 * 这是「runtime 会话」的实时入口：live 状态（starting/idle/running）是进程仍在，
 * error/closed 是运行失败或已停止但 Tab 未关——保留它们才能从活动页直接重启/重载失败会话，
 * 而不是让失败会话在活动页消失、只能去 chats 历史页翻。
 */
export function ActiveSessionsTree(props: {
	controller: SidebarController;
	actions: SidebarActions;
	currentSessionId?: string;
}) {
	const { controller } = props;
	// 活动页以会话为粒度，待确认标记直接按本行 sessionId 判定，
	// 避免订阅项目级聚合值导致一个会话的 ask 点亮整页。
	const sessionRuntimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
	// 收集所有项目下已绑定 runtime 的 agent，并解析其绑定会话记录（sessionId → record）。
	// catalog.agents 只含 runtime 绑定（detached 已被 agentInventoryAtom 排除），
	// 因此不再按 isLiveRuntimeStatus 过滤——否则 error/closed 的失败会话会从活动页消失。
	const liveRows: {
		agent: AgentTab;
		projectId: string;
		record?: SessionRecord;
		sortAt: number;
	}[] = [];
	for (const project of controller.catalog.projects) {
		const sessions = controller.catalog.sessionsByProject[project.id] ?? [];
		for (const agent of controller.catalog.agents) {
			if (agent.projectId !== project.id) continue;
			// 绑定会话：runtimeBySessionId 反查（最可靠），否则按 sessionPath 匹配历史记录。
			const bound = sessions.find((session) =>
				controller.catalog.runtimeBySessionId[session.id]?.agentId === agent.id,
			) ?? sessions.find((session) => session.filePath === agent.sessionPath);
			liveRows.push({
				agent,
				projectId: project.id,
				record: bound,
				// 本次 Agent 启动时间优先于历史 catalog 时间，确保右键启动后立即置顶。
				sortAt: bound ? Math.max(bound.updatedAt, agent.createdAt) : agent.createdAt,
			});
		}
	}
	const activeSessionOrder = controller.sidebarSessionOrder("active");
	const activeSessionBaseOrder = controller.sidebarSessionBaseOrder("active");
	liveRows.sort((left, right) => {
		const leftOrder = sidebarSessionOrderIndex(activeSessionBaseOrder, left.record?.id);
		const rightOrder = sidebarSessionOrderIndex(activeSessionBaseOrder, right.record?.id);
		return leftOrder - rightOrder || right.sortAt - left.sortAt;
	});
	const activePreviewRank = new Map(activeSessionOrder.map((id, index) => [id, index]));

	if (liveRows.length === 0) {
		return (
			<div className="active-sessions-empty flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
				<div className="text-caption text-muted-foreground">{t("app.sidebarActiveEmpty")}</div>
			</div>
		);
	}

	const activeDragSourceProps = (sessionId: string | undefined) => {
		if (!sessionId) return {};
		return {
			draggable: true,
			onDragStart: (event: DragEvent<HTMLButtonElement>) => {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(SESSION_TAB_DRAG_MIME, sessionId);
				event.dataTransfer.setData("text/plain", sessionId);
				props.actions.sessions.beginDrag?.(sessionId);
				controller.startSessionDrag(
					"active",
					sessionId,
					liveRows.map((row) => row.record?.id).filter((id): id is string => Boolean(id)),
				);
			},
			onDragEnd: () => {
				props.actions.sessions.endDrag?.();
				controller.finishSessionDrag();
			},
		};
	};
	const activeDropProps = (sessionId: string | undefined) => {
		if (!sessionId) return {};
		return {
			onDragOver: (event: DragEvent<HTMLDivElement>) => {
				if (controller.sessionDrag.scope !== "active") return;
				event.preventDefault();
				if (controller.sessionDrag.sourceSessionId === sessionId) return;
				const rect = event.currentTarget.getBoundingClientRect();
				const position: SidebarDropPosition = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
				controller.setSessionDropTarget("active", sessionId, position);
			},
			onDrop: (event: DragEvent<HTMLDivElement>) => {
				event.preventDefault();
				const source = event.dataTransfer.getData(SESSION_TAB_DRAG_MIME) || event.dataTransfer.getData("text/plain");
				const position = controller.sessionDrag.position;
				if (source) {
					controller.dropSidebarSession("active", source, sessionId, position);
				} else {
					controller.finishSessionDrag();
				}
			},
		};
	};

	return (
		<div className="active-sessions-list flex flex-col gap-0">
			{liveRows.map(({ agent, projectId, record, sortAt }) => {
				const sessionId = record?.id;
				const selected = sessionId === props.currentSessionId;
				const summary = record ? sessionRecordToSummary(record) : undefined;
				const displayTitle = summary?.name || agent.title;
				const project = controller.catalog.projects.find((p) => p.id === projectId);
				const pendingAsk = hasPendingAskForSession(sessionId, sessionRuntimeUiById);
				// 单击默认 preview；双击显式常驻（与 SessionTree 同一入口语义）。
				const openSession = (tabMode?: "preview" | "permanent") => {
					if (sessionId) void props.actions.sessions.open(projectId, sessionId, tabMode);
				};
				return (
					<div
						key={agent.id}
						className="group/row relative mt-0.5 flex min-h-8 items-center"
						style={{ order: sessionId ? activePreviewRank.get(sessionId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER }}
						{...activeDropProps(sessionId)}
						onContextMenu={(event) => {
							event.preventDefault();
							void controller.openMenu({ kind: "agent", agentId: agent.id, x: event.clientX, y: event.clientY });
						}}
					>
						<SessionHoverCard
							session={record ?? summary}
							title={displayTitle}
							projectName={project?.name}
							status={agent.status}
							disabled={Boolean(controller.menu)}
						>
							<button
								type="button"
								className={cn(
									activeRowClass,
									selected && "bg-bg-active text-foreground",
									sessionId && controller.sessionDrag.sourceSessionId === sessionId && "opacity-60",
									sessionId && controller.sessionDrag.overSessionId === sessionId && "ring-1 ring-border",
									sessionId && controller.sessionDrag.overSessionId === sessionId && controller.sessionDrag.position === "before" && "ring-2 ring-inset ring-primary/70",
									sessionId && controller.sessionDrag.overSessionId === sessionId && controller.sessionDrag.position === "after" && "ring-2 ring-inset ring-primary/70",
								)}
								onClick={() => openSession()}
								onDoubleClick={() => openSession("permanent")}
								{...activeDragSourceProps(sessionId)}
							>
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										sessionStatusDotClass(agent.status),
									)}
									aria-hidden="true"
								/>
								<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
									<div className="conversation-title flex min-w-0 items-center gap-1.5">
										{/* 选中背景仍保留，聚焦行也允许 hover 查看完整标题 */}
										<TitleScrollText text={displayTitle} className="font-medium" />
										<SessionBackendMark backend={agent.backend} />
										{/* 待确认标记：该会话正在等用户回答 ask，与项目行徽章共用同一组件 */}
										{pendingAsk && <PendingAskBadge count={1} />}
										{/* 相对时间常显：hover 时被右侧「⋯」浮层盖住（与历史会话行同一策略） */}
										<span className="shrink-0 text-caption tabular-nums text-muted-foreground group-hover/row:hidden">
											{formatRelativeTime(sortAt)}
										</span>
									</div>
								</div>
							</button>
						</SessionHoverCard>
						{project && (
							<button
								type="button"
								className={cn(
									rowIdeaActionClass,
									"grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground",
								)}
								aria-label={t("projectIdeas.title")}
								title={t("projectIdeas.title")}
								onClick={(event) => {
									event.stopPropagation();
									props.actions.projects.manageIdeas(projectId);
								}}
							>
								<Lightbulb size={12} aria-hidden="true" />
							</button>
						)}
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className={cn(
								rowActionsClass,
								controller.menu?.kind === "agent" && controller.menu.agentId === agent.id && "pointer-events-auto opacity-100",
							)}
							aria-label={t("sidebar.moreActions")}
							title={t("sidebar.moreActions")}
							onClick={(event) => {
								event.stopPropagation();
								const rect = event.currentTarget.getBoundingClientRect();
								void controller.openMenu({ kind: "agent", agentId: agent.id, x: rect.right, y: rect.bottom });
							}}
						>
							<Ellipsis size={14} aria-hidden="true" />
						</Button>
					</div>
				);
			})}
		</div>
	);
}
