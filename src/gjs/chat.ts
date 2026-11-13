import { LiveSpokenReceipts, SpokenReceiptView, spokenReceiptIdentity } from "./spoken-receipt.js";
import { DispatchFactsView, readDispatchFacts } from "./dispatch-facts.js";
import { skillProgressRow, skillProgressIdentity, SkillProgressView } from "./skill-progress.js";
import { nativeClientSurface, nativeSenderSessionId } from "./client-surface.js";
import { contactSource } from "./contact-source.js";
import { chatSender } from "./chat-sender.js";
import { relayContext } from "./chat-relay.js";
import { replyQuote } from "./chat-reply-quote.js";
import { diagramImageLoader } from "./diagram-images.js";
import { chatTextView } from "./chat-text-view.js";
import { ChatWelcome } from "./chat-welcome.js";
import { NestedTasks } from "./nested-tasks.js";
import { chatDownloadRoute } from "./chat-text.js";
import { Gio, GLib, Gtk, Pango } from "./gi.js";
import { ChatSocket, type GatewayFrame, type Gateway, HttpError, query, uploadProgressText } from "./gateway.js";
import { Questions, type Quiz } from "./questions.js";
import { type OwnerQuestions, OwnerQuestionsPanel } from "./owner-questions.js";
import { type OwnerAttention } from "./owner-attention.js";
import { OwnerAttentionView } from "./owner-attention-view.js";
import { Cards, type CardIdentity } from "./cards.js";
import { type RuntimeCommands, runtimeCommand } from "./commands.js";
import { CallPanel } from "./call-panel.js";
import { type CallView } from "./call-session.js";
import { Dictation, type DictationDraft } from "./dictation.js";
import { ReadAloud } from "./read-aloud.js";
import { ContributionActions, type ActionDraft } from "./contribution-actions.js";
import { HostModules, stopHostModules } from "./host-modules.js";
import { UiContributions } from "./ui-contributions.js";
import { type ReadRow, RoomReadView } from "./room-read-view.js";
import { type RoomReads } from "./room-reads.js";
import { RoomCognitionControls } from "./room-cognition-controls.js";
import { cognitionScope, type RoomCognition } from "./room-cognition.js";
import { WorkPanel } from "./work-panel.js";
import { type WorkState } from "./work-state.js";
import { type WidgetTab } from "./widget-contract.js";
import { TaskReviews, type SkillReviewGroup, type TaskReviewData, reviewReference } from "./task-reviews.js";
import { exactWorkTarget } from "./work-actions.js";
import { type EpisodeFacts, episodeLayout, episodeTask, episodeTitle, noteEpisode } from "./task-episodes.js";
import { Routing, type RoutingRow } from "./routing.js";
import { projectBinding, projectMarker, type ProjectTarget } from "./project-handoff.js";
import { isProjectCompletion, projectCompletion, projectTaskPhase, projectTerminalTime, renderProjectCompletion,
  type CompletionFields } from "./project-completion.js";
import { readProject } from "./project-directory.js";
import { originAddressed, submissionNotice, taskReferencePending } from "./submission-notices.js";
import { isRetainedWork, savedWorkTitle } from "./task-wrap-up.js";
import { ChatMedia, LiveChatMedia, mediaCaption, type MediaRow } from "./chat-media.js";
import { ChatIngress, type ChatSend, type IngressState, ingressState, messageId } from "./chat-ingress.js";
import { removePendingUpload, type UploadRemoval } from "./chat-upload-removal.js";
import { type ChatUpload, verifyChatUpload } from "./chat-upload-receipt.js";
import { type ActivityView, type DelegatedActivity, delegatedActivity, delegatedKey, projectDelegated,
  renderDelegated, renderExecutor } from "./delegated-activity.js";
import { button, chooseFile, clear, column, errorText, label, row } from "./ui.js";
import { object } from "./settings-write.js";
import { chatFrameAccepts, frameChatId } from "./chat-room.js";
import { chrome } from "./native-i18n.js";

export interface Room {
  name: string;
  chatId: number;
  projectId?: string;
}

export interface ChatPageOptions {
  ingress?: ChatIngress;
  ownsSharedControllers?: boolean;
  managesConnection?: boolean;
  hostRoom?: (room: Room, source: ChatPage) => ChatPage;
  beginNavigation?: () => () => boolean;
}

interface ChatRow extends Partial<Quiz>, RoutingRow, TaskReviewData, MediaRow, CompletionFields {
  markdown?: boolean;
  narration?: boolean;
  room_revisions?: Record<string, number>;
  row_client_message_id?: string;
  delivery_id?: string;
  card_row_id?: string;
  system_type?: string;
  task_id_pending?: boolean;
  parent_task_id?: string;
  is_progress?: boolean;
  spoken?: unknown;
  lifecycle_virtual?: boolean;
  lifecycle?: unknown;
  lifecycle_pointer?: unknown;
  progress_meta?: unknown;
  historical_terminal?: unknown;
  summary_kind?: string;
  reply_to?: unknown;
  quiz?: Quiz;
  quiz_state?: string;
  card?: CardIdentity;
  review_group?: SkillReviewGroup;
  late_evidence?: unknown;
  delegated_activity?: unknown;
  subagents_mode?: string;
  ingress_accepted?: boolean;
  ingress_dispatched?: boolean;
  ingress_pending?: boolean;
  origin_projected?: boolean;
}

interface History {
  messages?: ChatRow[];
  rows?: ChatRow[];
  has_more?: boolean;
  next_cursor?: string | null;
  page_cursor?: string | null;
  after_cursor?: string;
  anchor?: { state?: string; chat_id?: number; history_id?: string; row_address?: string; task_id?: string };
  window?: { complete?: boolean; truncated_by?: string[]; latest_message?: { history_id?: string } | null;
    latest_before?: number; latest_absent?: boolean };
  coverage?: { view?: string; upper?: { chat?: number }; spans?: { chat?: { chain?: string } | null } };
}

interface Draft {
  text: string;
  reply?: string;
  attachments: ChatUpload[];
  pending?: ChatSend;
  recovering?: boolean;
  receipt?: string;
  receiptRevision?: number;
  sendTimer?: number;
  upload?: { cancel: any; name?: string; status?: string };
  uploadNotice?: string;
  removals?: UploadRemoval[];
  commandPending?: number;
  settingsWaiting?: boolean;
}

const historySignals = new Set([
  "chat", "photo", "video", "document", "links", "quiz", "card", "quiz_state", "card_state",
  "message_annotation", "task_named", "extension_lifecycle", "conversation_finished",
]);
const evidence = new Set(["quiz_answer", "quiz_closed", "task_evidence", "task_model_wait"]);

function visibleRow(message: ChatRow): boolean {
  return !evidence.has(message.system_type ?? "") && !(message.summary_kind && message.historical_terminal);
}

function historyKey(message: ChatRow): string {
  if (isRetainedWork(message) && message.card_row_id) return `retained-work:${message.card_row_id}`;
  const id = message.row_client_message_id ?? (message.role === "user" ? message.client_message_id : undefined);
  return id ? `owner:${id}` : message.history_id ?? message.row_address
    ?? JSON.stringify([message.ts, message.role, message.task_id, message.system_type, message.is_progress, message.text]);
}

function dispatchMessageKey(message: ChatRow): string {
  return message.ts ? JSON.stringify([message.ts, message.task_id, message.system_type ?? "", message.text ?? ""]) : historyKey(message);
}

function sameHostNotice(a: ChatRow, b: ChatRow): boolean {
  if (a.system_type !== b.system_type) return false;
  if (isRetainedWork(a) && isRetainedWork(b) && a.card_row_id && b.card_row_id) return a.card_row_id === b.card_row_id;
  for (const field of ["delivery_id", "row_address", "history_id", "row_client_message_id"] as const) {
    if (a[field] && b[field]) return a[field] === b[field];
  }
  return Boolean(a.ts && a.ts === b.ts && a.task_id === b.task_id && a.text === b.text);
}

function hostNotice(row: ChatRow): boolean {
  return row.system_type === "reminder" || skillProgressRow(row) || readDispatchFacts(row).present || Boolean(submissionNotice(row.system_type)) || isProjectCompletion(row) || isRetainedWork(row);
}

function messageQuiz(message: ChatRow): Quiz | undefined {
  if (message.quiz?.quiz_id) return { question: message.text, ...message.quiz, presence_contact: message.quiz.presence_contact ?? message.presence_contact };
  if (message.system_type === "project_question_pointer" && message.quiz_id) {
    return { ...message, quiz_id: message.quiz_id, state: message.quiz_state };
  }
  return undefined;
}

function actionText(text: string): string {
  let fence = "";
  return text.split(/\r?\n/u).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (!marker || marker[1][0] !== fence[0] || marker[1].length < fence.length || marker[2].trim()) return line;
      fence = "";
      return "";
    }
    if (marker) { fence = marker[1]; return ""; }
    return line.replace(/^ {0,3}(?:#{1,6}\s+|(?:>\s*)+|[-*+]\s+|\d+[.)]\s+)/u, "")
      .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/gu, "$1")
      .replace(/(`+|\*{1,3}|_{1,3}|~~)([^\n]+?)\1/gu, "$2");
  }).join("\n").trim();
}

export class ChatPage {
  readonly widget = column();
  private readonly list = column(0);
  private readonly welcome: ChatWelcome;
  private nestedExpanded = false;
  private readonly nestedChoices = new Map<string, boolean>();
  private readonly nestedPreference = new Gtk.CheckButton({ label: "Разворачивать субагентов по умолчанию", sensitive: false });
  private readonly nestedFeedback = label("", "dim-label");
  private readonly nestedCancel = new Gio.Cancellable();
  private nestedSync = false;
  private nestedSaving = false;
  private nestedReady = false;
  private readonly viewport = new Gtk.Viewport({ child: this.list });
  private readonly scroll = new Gtk.ScrolledWindow({ child: this.viewport, vexpand: true, hexpand: true });
  private readonly status = label("", "dim-label");
  private readonly sendStatus = label("", "dim-label");
  private readonly uploadStatus = label("", "dim-label");
  private readonly uploadBar = row(5);
  private readonly cancelUpload = button("Отменить загрузку", () => {
    this.draft.upload?.cancel.cancel();
    this.syncUpload();
  });
  private readonly roomLabel = label("", "title-2");
  private readonly draftInfo = column();
  private readonly uploadRemovals = column(4);
  private readonly removalPane = new Gtk.ScrolledWindow({ child: this.uploadRemovals, max_content_height: 138,
    propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER, visible: false });
  private readonly composer = new Gtk.Entry({ placeholder_text: "Сообщение…", hexpand: true });
  private readonly older = button("Предыдущие сообщения", () => void this.loadOlder());
  private readonly latest = button("К последним сообщениям", () => this.showLatest());
  private readonly historyNotice = label("", "dim-label");
  private readonly send = button("Отправить", () => this.submit());
  private readonly attach = button("Прикрепить файл", () => void this.attachFile());
  private readonly discard = button("Оставить без повтора", () => this.discardPending());
  private readonly drafts = new Map<number, Draft>();
  private readonly socket: ChatSocket;
  private readonly panicButton?: any;
  private readonly routing: Routing;
  private readonly media: ChatMedia;
  private readonly liveMedia = new LiveChatMedia();
  private readonly liveDelegated = new Map<string, ChatRow>();
  private readonly ingress: ChatIngress;
  private readonly liveIngress = new Map<string, { message: ChatRow; at: number }>();
  private readonly relayExpansion = new Set<string>();
  private readonly liveSpoken = new LiveSpokenReceipts();
  private readonly spokenViews: { key: string; view: SpokenReceiptView }[] = [];
  private readonly spokenExpanded = new Set<string>();
  private readonly dispatchFactsViews: DispatchFactsView[] = [];
  private readonly dispatchFactsExpanded = new Set<string>();
  private readonly skillProgressViews = new Map<string, SkillProgressView>();
  private readonly skillProgressExpanded = new Set<string>();
  private readonly liveNotices = new Map<string, ChatRow>();
  private readonly ingressRetries = new Map<string, number>();
  private bindings = new Map<string, ProjectTarget>();
  private bindingsAt = 0;
  private projectRoomsAt = 0;
  private projectRooms = new Set<number>();
  private episodes = new Map<string, EpisodeFacts>();
  private readonly episodeDetails = new Map<string, Record<string, unknown>>();
  private readonly episodeReads = new Map<string, any>();
  private readonly episodeExpanded = new Set<string>();
  private readonly episodePending = new Map<string, symbol>();
  private readonly episodeFeedback = new Map<string, string>();
  private readonly episodeCensus = new Map<string, string>();
  private readonly episodePortals = new Set<string>();
  private readonly questions: Questions;
  private readonly cards: Cards;
  private readonly reviews: TaskReviews;
  private readonly call: CallPanel;
  private readonly dictation: Dictation;
  private readonly readAloud: ReadAloud;
  private readonly contributions: UiContributions;
  private readonly hostModules: HostModules;
  private readonly contributionActions: ContributionActions;
  private readonly readView?: RoomReadView;
  private readonly cognitionControls?: RoomCognitionControls;
  private readonly workPanel?: WorkPanel;
  private readonly ownerQuestionsPanel?: OwnerQuestionsPanel;
  private readonly ownerAttentionView?: OwnerAttentionView;
  private readonly poll: number;
  private room: Room;
  private readonly commandCancel = new Gio.Cancellable();
  private disposed = false;
  private closeDrain?: Promise<void>;
  private view = 0;
  private timer = 0;
  private reading = false;
  private dirty = false;
  private fullSpeechHistory = false;
  private loadingOlder = false;
  private cursor?: string;
  private after?: string;
  private anchored = false;
  private incomplete = false;
  private olderRead = false;
  private olderVersion = 0;
  private resetLatest = false;
  private invalidHistoryChain = false;
  private jump?: any;
  private historyError = "";
  private archived: ChatRow[] = [];
  private current: ChatRow[] = [];
  private rendered = "";
  private typing = false;
  private readonly typingRooms = new Set<string>();
  private readonly typingTimers = new Map<string, number>();
  private draftRevision = 0;
  private readRevision?: number;
  private readLatest: string | null | undefined = null;
  private readSearch?: History["coverage"];
  private opening = false;
  private seeking = false;
  private readingGesture = 0;

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    room: Room,
    private readonly signal: (frame: GatewayFrame) => void,
    private readonly openTask?: (id: string) => void,
    private readonly commands?: RuntimeCommands,
    private readonly reconnected?: () => void,
    callActive?: (active: boolean, view: CallView) => void,
    openSkills?: (name: string) => void,
    openWidgets?: (skill: string) => void,
    private readonly historyRoom?: (room: Room) => void,
    private readonly roomReads?: RoomReads,
    private readonly roomCognition?: RoomCognition,
    private readonly workState?: WorkState,
    private readonly ownerQuestions?: OwnerQuestions,
    private readonly ownerAttention?: OwnerAttention,
    openSettings?: () => void,
    private readonly options: ChatPageOptions = {},
  ) {
    this.room = room;
    this.composer.set_name("chat-composer");
    chrome(this.composer, "placeholder-text", "Message…");
    chrome(this.send, "label", "Send");
    chrome(this.older, "label", "Previous messages");
    chrome(this.latest, "label", "Latest messages");
    chrome(this.discard, "label", "Leave without retry");
    chrome(this.nestedPreference, "label", "Expand subagents by default");
    this.welcome = new ChatWelcome(gateway, prefs => {
      if (this.nestedSaving) return;
      const expanded = prefs.nested_subagents_expanded === true;
      this.applyNestedPreference(expanded);
      if (this.nestedExpanded === expanded) return;
      this.nestedExpanded = expanded;
      this.renderHistory();
    });
    this.ingress = options.ingress ?? new ChatIngress(gateway.base);
    this.media = new ChatMedia(gateway);
    this.routing = new Routing(parent, gateway, () => this.refresh(), (id, chatId) => void this.openProject(id, chatId), openTask);
    if (ownerAttention) this.ownerAttentionView = new OwnerAttentionView(parent, gateway, ownerAttention, openTask, openSettings, true);
    if (workState) this.workPanel = new WorkPanel(parent, workState, openTask, true, ownerQuestions,
      ownerAttention ? (taskId, waitId) => this.ownerAttentionView?.showWait(taskId, waitId) === true : undefined);
    if (ownerQuestions) this.ownerQuestionsPanel = new OwnerQuestionsPanel(ownerQuestions, true);
    if (roomReads) this.readView = new RoomReadView(parent, this.viewport, this.scroll, roomReads, room);
    if (roomCognition) this.cognitionControls = new RoomCognitionControls(roomCognition, () => {
      if (!this.disposed) this.syncComposer();
    });
    this.questions = ownerQuestions?.forms ?? new Questions(parent, gateway, () => this.refresh());
    this.cards = new Cards(parent, gateway);
    this.reviews = new TaskReviews(gateway);
    this.call = new CallPanel(parent, gateway, room, () => this.refresh(), (view) => callActive?.(view.active, view));
    this.contributions = new UiContributions(gateway, () => {
      this.hostModules.reconcile();
      this.dictation.updated();
      this.readAloud.updated();
      this.contributionActions.updated();
    });
    this.hostModules = new HostModules(gateway, this.contributions, {
      changed: () => { this.dictation.updated(); this.readAloud.updated(); },
      notice: text => { if (!this.disposed && this.widget.get_mapped()) this.status.set_label(text); },
      insert: text => !this.disposed && this.widget.get_mapped() && this.actionDraft().insert(text),
    });
    this.widget.append(this.hostModules.widget);
    this.dictation = new Dictation(parent, gateway, this.contributions, () => this.dictationDraft(),
      (text, draft) => this.insertDictation(text, draft), openSkills, this.hostModules);
    this.readAloud = new ReadAloud(parent, this.contributions, this.hostModules);
    this.contributionActions = new ContributionActions(parent, gateway, this.contributions,
      () => this.actionDraft(), this.attach, openWidgets);
    this.widget.append(this.roomLabel);
    this.widget.append(this.status);
    this.widget.append(this.historyNotice);
    if (this.workPanel) this.widget.append(this.workPanel.widget);
    if (this.ownerQuestionsPanel) this.widget.append(this.ownerQuestionsPanel.widget);
    if (this.ownerAttentionView) this.widget.append(this.ownerAttentionView.widget);
    const historyActions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE,
      min_children_per_line: 1, max_children_per_line: 5, column_spacing: 6, row_spacing: 4 });
    historyActions.append(this.older);
    historyActions.append(this.latest);
    this.latest.set_visible(false);
    historyActions.append(chrome(button("Закреплённые карточки", () => this.cards.showPinned()), "label", "Pinned cards"));
    const nestedMenu = new Gtk.MenuButton({ label: "Подзадачи" });
    chrome(nestedMenu, "label", "Subtasks");
    const nestedPopover = new Gtk.Popover();
    const nestedOptions = column(6);
    nestedOptions.set_margin_top(10);
    nestedOptions.set_margin_bottom(10);
    nestedOptions.set_margin_start(10);
    nestedOptions.set_margin_end(10);
    nestedOptions.append(this.nestedPreference);
    nestedOptions.append(this.nestedFeedback);
    nestedPopover.set_child(nestedOptions);
    nestedMenu.set_popover(nestedPopover);
    historyActions.append(nestedMenu);
    this.nestedPreference.connect("toggled", () => {
      if (!this.nestedSync) void this.saveNestedPreference();
    });
    if (this.commands) {
      this.panicButton = button("Аварийная остановка", () => void this.stopGateway());
      chrome(this.panicButton, "label", "Emergency stop");
      this.panicButton.add_css_class("destructive-action");
      historyActions.append(this.panicButton);
    }
    this.widget.append(historyActions);
    this.widget.append(this.welcome.widget);
    this.widget.append(this.scroll);
    const scrolling = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
      propagation_phase: Gtk.PropagationPhase.CAPTURE });
    scrolling.connect("scroll", () => { this.cancelJump(); this.endReadOpening(); return false; });
    this.scroll.add_controller(scrolling);
    const historyPress = new Gtk.GestureClick({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
    historyPress.connect("pressed", () => { this.cancelJump(); this.endReadOpening(); });
    this.scroll.add_controller(historyPress);
    this.widget.append(this.draftInfo);
    this.uploadBar.append(this.uploadStatus);
    this.uploadBar.append(this.cancelUpload);
    this.widget.append(this.uploadBar);
    this.widget.append(this.removalPane);
    this.widget.append(this.sendStatus);
    this.widget.append(this.call.widget);
    this.widget.append(this.dictation.widget);
    if (this.cognitionControls) this.widget.append(this.cognitionControls.widget);
    this.widget.append(this.contributionActions.chips.widget);
    this.widget.append(this.contributionActions.status);
    this.widget.connect("unmap", () => {
      this.cancelJump();
      this.endReadOpening();
      this.dictation.leave();
      this.readAloud.stop();
      if (this.anchored && !this.disposed) this.showLatest(false);
    });
    this.widget.connect("map", () => {
      this.opening = true;
      this.cognitionControls?.refresh();
      this.refresh();
    });
    const actions = row();
    actions.append(this.contributionActions.plus);
    actions.append(this.composer);
    actions.append(this.send);
    actions.append(this.discard);
    this.widget.append(actions);
    this.send.add_css_class("suggested-action");
    this.composer.connect("activate", () => this.submit());
    this.composer.connect("changed", () => {
      this.draftRevision++;
      this.draft.text = this.composer.get_text();
      this.syncComposer();
    });
    this.socket = new ChatSocket(gateway, (frame) => this.onFrame(frame), (online) => {
      if (this.disposed) return;
      if (this.options.managesConnection !== false) {
        if (online) this.commands?.panicSocketOpened();
        this.workState?.setConnected(online);
        this.ownerQuestions?.setConnected(online);
        this.ownerAttention?.setConnected(online);
      }
      this.routing.setConnected(online);
      this.clearTyping();
      if (!online) {
        this.ingress.disconnected();
        for (const timer of this.ingressRetries.values()) GLib.Source.remove(timer);
        this.ingressRetries.clear();
        this.allowRetry("Связь прервалась. Ответ шлюза неизвестен.");
      }
      this.renderHistory();
      this.syncComposer();
      this.refresh();
      if (online) {
        this.episodeCensus.clear();
        this.episodePortals.clear();
        this.cards.widgetFrame({ type: "extension_lifecycle" });
        void this.call.refresh();
        void this.contributions.refresh();
        this.cognitionControls?.refresh();
        this.reconnected?.();
      }
    });
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
      if (!this.socket.online || this.ingress.waiting(this.room.chatId)) this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
    this.setRoom(room);
    void this.contributions.refresh();
  }

  showPinnedWidget(tab: WidgetTab): void { this.cards.showSnapshot(tab); }

  showCallSettings(parent: any): void { this.call.showSettings(parent); }

  endCall(): void { if (!this.disposed) this.call.endCall(); }

  leaveQuestions(): void {
    this.ownerQuestionsPanel?.invalidate();
    this.workPanel?.invalidateQuestions();
    this.ownerAttentionView?.leave();
    this.routing.leave();
    this.media.close();
  }

  requestPanic(): Promise<boolean> | undefined {
    if (this.disposed) return;
    this.stopPageModules();
    const receipt = this.socket.requestPanic();
    this.dictation.cancel();
    this.readAloud.stop();
    return receipt;
  }

  close(): Promise<void> | undefined {
    if (this.disposed) return this.closeDrain;
    this.disposed = true;
    this.clearTyping();
    this.commandCancel.cancel();
    this.welcome.close();
    this.nestedCancel.cancel();
    this.cancelJump();
    this.clearEpisodeView();
    this.readView?.close();
    this.cognitionControls?.close();
    this.workPanel?.close();
    this.ownerQuestionsPanel?.close();
    this.ownerAttentionView?.close();
    if (this.options.ownsSharedControllers !== false) this.ownerAttention?.close();
    this.routing.close();
    for (const view of this.skillProgressViews.values()) view.close();
    this.skillProgressViews.clear();
    this.skillProgressExpanded.clear();
    for (const view of this.dispatchFactsViews.splice(0)) view.close();
    this.dispatchFactsExpanded.clear();
    for (const { view } of this.spokenViews.splice(0)) view.close();
    this.spokenExpanded.clear();this.liveSpoken.clear();
    this.media.close();
    this.liveMedia.clear();
    if (this.ownerQuestions) {
      if (this.options.ownsSharedControllers !== false) this.ownerQuestions.close();
    }
    else this.questions.close();
    this.cards.close();
    this.reviews.close();
    this.contributions.close();
    this.contributionActions.close();
    this.dictation.close();
    this.readAloud.close();
    const moduleDrain = this.hostModules.close();
    const callDrain = this.call.close();
    this.socket.close();
    GLib.Source.remove(this.poll);
    if (this.timer) GLib.Source.remove(this.timer);
    for (const draft of this.drafts.values()) {
      this.clearSendTimer(draft);
      draft.upload?.cancel.cancel();
    }
    for (const timer of this.ingressRetries.values()) GLib.Source.remove(timer);
    this.ingressRetries.clear();
    return this.closeDrain = Promise.all([callDrain, moduleDrain]).then(() => {});
  }

  setRoom(room: Room): void {
    if (this.view && this.room.chatId === room.chatId && this.room.projectId === room.projectId) {
      this.room = room;
      this.roomLabel.set_label(room.name);
      return;
    }
    this.enterRoom(room);
    this.refresh();
  }

  get currentRoom(): Room { return this.room; }

  cancelNavigation(): void { this.cancelJump(); this.endReadOpening(); }

  private applyNestedPreference(expanded: boolean): void {
    this.nestedSync = true;
    this.nestedPreference.set_active(expanded);
    this.nestedSync = false;
    this.nestedReady = true;
    this.nestedPreference.set_sensitive(!this.nestedSaving);
  }

  private async saveNestedPreference(): Promise<void> {
    if (this.disposed || this.nestedSaving || !this.nestedReady) return;
    this.nestedSaving = true;
    this.nestedReady = false;
    this.nestedPreference.set_sensitive(false);
    this.nestedFeedback.set_label("Сохраняю настройку…");
    try {
      const result = await this.gateway.json<{ ok?: boolean; nested_subagents_expanded?: boolean }>(
        "POST", "/api/ui/preferences", { nested_subagents_expanded: this.nestedPreference.get_active() },
        undefined, false, this.nestedCancel);
      if (this.disposed) return;
      if (result.ok !== true || typeof result.nested_subagents_expanded !== "boolean") {
        throw new Error("Шлюз не подтвердил настройку подзадач.");
      }
      this.nestedExpanded = result.nested_subagents_expanded;
      this.applyNestedPreference(this.nestedExpanded);
      this.renderHistory();
      this.nestedFeedback.set_label("Настройка сохранена. Ручной выбор раскрытия отдельных подзадач сохраняется в этом окне.");
    } catch (error) {
      if (!this.disposed) this.nestedFeedback.set_label(`Сохранение не подтверждено. ${errorText(error)}`);
    } finally {
      this.nestedSaving = false;
      if (!this.disposed) {
        this.nestedPreference.set_sensitive(this.nestedReady);
        void this.welcome.refresh();
      }
    }
  }

  private enterRoom(room: Room): void {
    this.welcome.setMain(room.chatId === 1);
    this.cancelJump();
    this.endReadOpening();
    this.opening = true;
    this.readView?.setRoom(room);
    this.readRevision = undefined;
    this.readLatest = null;
    this.readSearch = undefined;
    if (this.room.chatId !== room.chatId) {
      this.dictation.leave();
      this.readAloud.stop();
      this.draftRevision++;
      this.contributionActions.resetStatus();
    }
    if (this.room.chatId !== room.chatId || this.room.projectId !== room.projectId) {
      this.liveMedia.clear();
      this.liveDelegated.clear();
      this.liveIngress.clear();
      this.liveNotices.clear();
      this.clearEpisodeView();
    }
    this.room = room;
    this.routing.setRoom(room.chatId);
    this.media.close();
    this.workPanel?.setRoom(room.chatId, room.projectId);
    this.ownerQuestionsPanel?.setRoom(room);
    this.ownerAttentionView?.setRoom(room.chatId);
    this.call.setRoom(room);
    this.cognitionControls?.setRoom(room);
    this.view++;
    this.clearTyping();
    this.loadingOlder = false;
    this.reading = false;
    this.dirty = false;
    this.fullSpeechHistory = false;
    this.archived = [];
    this.current = [];
    this.cursor = undefined;
    this.after = undefined;
    this.anchored = false;
    this.incomplete = false;
    this.olderRead = false;
    this.resetLatest = false;
    this.invalidHistoryChain = false;
    this.historyError = "";
    this.historyNotice.set_label("");
    this.older.set_sensitive(true);
    this.latest.set_visible(false);
    this.rendered = "";
    this.readAloud.clearRows();
    this.contributionActions.resetRows();
    clear(this.list);
    this.roomLabel.set_label(room.name);
    this.status.set_label("Загрузка истории…");
    this.sendStatus.set_label(this.draft.recovering ? "Проверяю сохранённую отправку…" : this.ingress.issue);
    this.composer.set_text(this.draft.text);
    this.renderDraft();
  }

  refresh(): void {
    if (this.disposed || this.anchored || this.timer || (this.resetLatest && !this.widget.get_mapped())) return;
    this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
      this.timer = 0;
      void this.readHistory();
      return GLib.SOURCE_REMOVE;
    });
  }

  readAvailabilityChanged(): void {
    const revision = this.roomReads?.revision(this.room);
    if (revision !== undefined && revision !== this.readRevision && !this.anchored) {
      if (this.readLatest === null && !this.readSearch) this.after = undefined;
      this.refresh();
    }
  }

  observeProjectBindings(raw: { task_bindings?: Record<string, unknown>; task_bindings_revision?: string; project_chat_ids?: unknown }, readAt: number): void {
    if (!this.disposed && readAt >= this.projectRoomsAt && Array.isArray(raw.project_chat_ids)
      && raw.project_chat_ids.every(id => Number.isSafeInteger(id) && id > 1)) {
      this.projectRoomsAt = readAt;
      this.projectRooms = new Set(raw.project_chat_ids);
    }
    if (this.disposed || readAt < this.bindingsAt || !raw.task_bindings) return;
    this.bindingsAt = readAt;
    const next = raw.task_bindings_revision ? new Map<string, ProjectTarget>() : new Map(this.bindings);
    for (const [task, value] of Object.entries(raw.task_bindings)) {
      const target = projectBinding(value);
      if (exactWorkTarget(task) && target?.chatId) {
        next.set(task, target);
        if (target.chatId > 1) this.projectRooms.add(target.chatId);
      }
    }
    this.bindings = next;
    if (this.room.chatId === 1) this.renderHistory();
  }

  projectBound(task: string, target: ProjectTarget): void {
    if (this.disposed) return;
    this.bindingsAt = GLib.get_monotonic_time();
    this.bindings.set(task, target);
    if (typeof target.chatId === "number" && target.chatId > 1) {
      this.projectRooms.add(target.chatId);
      this.projectRoomsAt = this.bindingsAt;
    }
    if (this.room.chatId === 1) this.renderHistory();
  }

  projectForTask(task: string): ProjectTarget | undefined { return this.bindings.get(task); }

  observeContinuations(raw: unknown): void {
    const state = object(raw);
    if (state.supervisor_ready !== true || !Array.isArray(state.works)) return;
    for (const candidate of state.works) {
      const work = object(candidate);
      const root = work.work_id;
      const current = object(work.episode).task_id;
      if (!exactWorkTarget(root) || !exactWorkTarget(current) || !this.episodes.has(root)
        || root === current || this.episodeCensus.get(root) === current || this.episodeReads.has(root)) continue;
      this.episodeCensus.set(root, current);
      void this.readEpisode(root, current);
    }
  }

  private readPortalEpisodes(): void {
    if (this.room.chatId !== 1) return;
    for (const message of [...this.current].reverse()) {
      if (this.episodeReads.size >= 2) break;
      const task = episodeTask(message);
      if (!task || !projectMarker(message) || message.system_type === "project_completion_summary"
        || this.episodeDetails.has(task) || this.episodePortals.has(task)) continue;
      this.episodePortals.add(task);
      void this.readEpisode(task);
    }
  }

  continuationChanged(predecessor: unknown): void {
    if (!exactWorkTarget(predecessor) || (!this.episodes.has(predecessor)
      && ![...this.episodes.values()].some(({ offer }) => offer.successor === predecessor))) return;
    void this.readEpisode(predecessor);
    this.after = undefined;
    this.refresh();
  }

  private clearEpisodeView(): void {
    for (const cancel of this.episodeReads.values()) cancel.cancel();
    this.episodeReads.clear();
    this.episodeDetails.clear();
    this.episodeExpanded.clear();
    this.episodePending.clear();
    this.episodeFeedback.clear();
    this.episodeCensus.clear();
    this.episodePortals.clear();
    this.episodes.clear();
  }

  private async readEpisode(start: string, through?: string): Promise<void> {
    if (this.disposed || this.episodeReads.has(start)) return;
    const cancel = new Gio.Cancellable();
    this.episodeReads.set(start, cancel);
    const active = () => !this.disposed && this.episodeReads.get(start) === cancel;
    const seen = new Set<string>();
    let task: string | undefined = start;
    try {
      while (task && !seen.has(task)) {
        seen.add(task);
        const detail = await this.gateway.json<Record<string, unknown>>("GET", `/api/tasks/${encodeURIComponent(task)}`,
          undefined, undefined, false, cancel);
        if (!active()) return;
        const record = { ...detail, task_id: detail?.task_id || detail?.id };
        if (episodeTask(record) !== task) return;
        this.episodeDetails.set(task, record);
        if (task === through) return;
        const observed = new Map<string, EpisodeFacts>();
        noteEpisode(observed, record, true);
        task = observed.get(task)?.offer.successor;
      }
    } catch {
      if (active()) this.episodeCensus.delete(start);
    } finally {
      if (active()) {
        this.episodeReads.delete(start);
        this.renderHistory();
      }
    }
  }

  private async continueTask(task: string): Promise<void> {
    const actions = this.workState?.actions;
    if (!actions || this.episodePending.has(task) || this.disposed) return;
    const token = Symbol(task);
    const active = () => !this.disposed && this.episodePending.get(task) === token;
    this.episodePending.set(task, token);
    this.episodeFeedback.set(task, "Проверяю возможность продолжения…");
    this.renderHistory();
    const result = await actions.continueTask(task, active);
    if (!active()) return;
    this.episodePending.delete(task);
    this.episodeFeedback.set(task, result.text);
    this.continuationChanged(task);
    this.renderHistory();
  }

  setReadingBlocked(blocked: boolean): void { this.readView?.setBlocked(blocked); }

  private endReadOpening(): void {
    this.opening = false;
    this.readingGesture++;
    this.readView?.cancelLanding();
  }

  private readWindow(history: History, revision: number | undefined, delta: boolean): void {
    if (!this.readView) return;
    const named = history.window?.latest_message;
    if (!delta || named !== undefined) {
      const unknown = named === null || !history.window
        || (named === undefined && this.historyGap(history) && !history.window.latest_absent);
      this.readLatest = unknown ? null
        : typeof named?.history_id === "string" && named.history_id ? named.history_id : undefined;
      this.readSearch = named === null && Number.isSafeInteger(history.window?.latest_before) ? history.coverage : undefined;
    }
    this.readRevision = revision;
    this.readView.setReceipt(this.readLatest === null ? undefined : revision, this.readLatest ?? undefined);
    void this.landUnread();
  }

  private readOlderWindow(history: History): void {
    const head = this.readSearch;
    const page = history.coverage;
    if (this.anchored || !head?.view || !head.spans?.chat?.chain || !Number.isSafeInteger(head.upper?.chat)
      || page?.view !== head.view || page.spans?.chat?.chain !== head.spans.chat.chain || page.upper?.chat !== head.upper?.chat) return;
    const named = history.window?.latest_message;
    if (named?.history_id || history.window?.latest_absent === true) {
      this.readLatest = named?.history_id;
      this.readSearch = undefined;
      this.readView?.setReceipt(this.readRevision, this.readLatest);
    } else if (named === null) this.readSearch = undefined;
  }

  private async landUnread(): Promise<void> {
    const view = this.readView;
    if (!view || !this.opening || this.seeking || this.anchored || !this.widget.get_mapped() || this.readRevision === undefined) return;
    if (!this.roomReads?.unread(this.room)) { this.opening = false; return; }
    const gesture = this.readingGesture;
    this.seeking = true;
    try {
      const wanted = () => !this.disposed && this.opening && gesture === this.readingGesture && this.widget.get_mapped();
      while (wanted() && this.cursor && (this.readLatest ? !view.hasRow(this.readLatest) : Boolean(this.readSearch))) {
        if (!await this.loadOlder(true)) break;
      }
      if (wanted()) {
        this.opening = false;
        if (this.readLatest && view.hasRow(this.readLatest)) view.land(this.readLatest);
      }
    } finally {
      this.seeking = false;
      if (this.opening && gesture !== this.readingGesture) void this.landUnread();
    }
  }

  private get draft(): Draft {
    return this.draftFor(this.room.chatId);
  }

  private dictationDraft(): DictationDraft {
    const [selected, start, end] = this.composer.get_selection_bounds();
    const position = this.composer.get_position();
    return { room: this.room.chatId, revision: this.draftRevision, text: this.draft.text,
      start: selected ? start : position, end: selected ? end : position,
      editable: !this.disposed && !this.draft.pending && !this.draft.commandPending };
  }

  private insertDictation(text: string, draft: DictationDraft): void {
    const chars = Array.from(draft.text);
    const before = chars.slice(0, draft.start).join("");
    const after = chars.slice(draft.end).join("");
    const leading = before && !/\s$/u.test(before) ? " " : "";
    const trailing = after && !/^[\s.,!?;:…)]/u.test(after) ? " " : "";
    this.replaceDraftSelection(leading + text + trailing, draft);
  }

  private replaceDraftSelection(text: string, draft: DictationDraft): void {
    const chars = Array.from(draft.text);
    this.composer.set_text(chars.slice(0, draft.start).join("") + text + chars.slice(draft.end).join(""));
    this.composer.grab_focus();
    this.composer.set_position(draft.start + Array.from(text).length);
  }

  private actionDraft(): ActionDraft {
    const snapshot = this.dictationDraft();
    const unchanged = () => {
      const latest = this.dictationDraft();
      return latest.editable && latest.room === snapshot.room && latest.revision === snapshot.revision && latest.text === snapshot.text;
    };
    return { room: snapshot.room, text: snapshot.text,
      insert: (text) => {
        if (!unchanged()) return false;
        this.replaceDraftSelection(text, snapshot);
        return true;
      },
      clear: () => { if (unchanged()) this.composer.set_text(""); },
    };
  }

  private draftFor(chatId: number): Draft {
    let draft = this.drafts.get(chatId);
    if (!draft) {
      const kept = this.ingress.draft(chatId);
      draft = kept ? { text: kept.content, attachments: kept.attachments, reply: kept.reply_to, pending: kept, recovering: true }
        : { text: "", attachments: [] };
      this.drafts.set(chatId, draft);
    }
    return draft;
  }

  private appendCardDraft(chatId: number, line: string): boolean {
    if (this.disposed) return false;
    const draft = this.draftFor(chatId);
    if (draft.pending || draft.commandPending) return false;
    draft.text = draft.text ? draft.text + (draft.text.endsWith("\n") ? "" : "\n") + line : line;
    if (this.room.chatId === chatId) {
      this.composer.set_text(draft.text);
      this.composer.set_position(-1);
    }
    return true;
  }

  private ingressFrame(frame: GatewayFrame): void {
    const chat = frame.chat_id;
    if (typeof chat !== "number" || !Number.isSafeInteger(chat) || chat <= 0) return;
    const id = frame.client_message_id;
    const state = ingressState(frame);
    if (state && messageId(id)) {
      this.acceptIngress(chat, id, state, true);
      if (chat !== this.room.chatId || this.anchored) return;
      const message: ChatRow = {
        ...frame,
        role: "user", client_message_id: id, text: typeof frame.content === "string" ? frame.content : "",
        ts: typeof frame.ts === "string" ? frame.ts : "", ingress_accepted: true,
        ingress_pending: state === "pending", ingress_dispatched: state === "dispatched",
        attachments: Array.isArray(frame.attachments) ? frame.attachments : [],
      };
      this.liveIngress.delete(id);
      this.liveIngress.set(id, { message, at: GLib.get_monotonic_time() });
      if (this.liveIngress.size > 64) this.liveIngress.delete(this.liveIngress.keys().next().value!);
      this.renderHistory();
      return;
    }
    if (frame.role !== "system" || frame.system_type !== "initialization_notice" || !messageId(id)) return;
    const draft = this.drafts.get(chat);
    if (draft?.pending?.client_message_id === id) {
      draft.recovering = false;
      this.allowRetry(typeof frame.content === "string" && frame.content ? frame.content : "Шлюз отклонил сообщение.", draft);
    }
    if (chat === this.room.chatId && this.ingress.retryable(chat, id)) {
      this.clearIngressRetry(chat, id);
      this.sendStatus.set_label(typeof frame.content === "string" ? frame.content : "Шлюз отклонил повтор.");
      this.renderHistory();
    }
  }

  private acceptIngress(chat: number, id: string, state: IngressState, live: boolean): void {
    this.ingress.adopt(chat, id, state, live);
    if (live || state !== "pending") this.clearIngressRetry(chat, id);
    const draft = this.drafts.get(chat);
    if (draft?.pending?.client_message_id === id) {
      this.clearDraft(draft);
      draft.receipt = id;
      draft.receiptRevision = draft === this.draft ? this.draftRevision : undefined;
    }
    // History/reconnect can replay this receipt after a new draft was edited.
    // Its sending status belongs only to the revision cleared by this receipt.
    if (draft?.receipt === id && draft === this.draft && draft.receiptRevision === this.draftRevision) this.sendStatus.set_label(this.ingress.issue || (state === "pending"
      ? "Сообщение сохранено. Ожидает передачи."
      : state === "saved" ? "Сообщение сохранено. Передача не подтверждена." : "Сообщение сохранено. Передача в обработку началась."));
  }

  private historyIngress(messages: ChatRow[], readAt: number): void {
    for (const message of messages) {
      const id = message.client_message_id;
      const state = ingressState(message);
      if (!state || !messageId(id)) continue;
      const live = this.liveIngress.get(id);
      if (live && live.at > readAt && state !== ingressState(live.message)) continue;
      this.liveIngress.delete(id);
      this.acceptIngress(this.room.chatId, id, state, false);
    }
  }

  private finishIngressRecovery(): void {
    if (!this.draft.recovering) return;
    this.draft.recovering = false;
    this.sendStatus.set_label("Сохранение отправки пока не подтверждено. Можно повторить тот же запрос.");
    this.syncComposer();
  }

  private clearIngressRetry(chat: number, id: string): void {
    const key = JSON.stringify([chat, id]);
    const timer = this.ingressRetries.get(key);
    if (timer) GLib.Source.remove(timer);
    this.ingressRetries.delete(key);
  }

  private retryIngress(id: string): void {
    const chat = this.room.chatId;
    const frame = this.ingress.retryable(chat, id);
    const key = JSON.stringify([chat, id]);
    if (!frame || this.ingressRetries.has(key) || !this.socket.send(frame)) return;
    this.ingressRetries.set(key, GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
      this.ingressRetries.delete(key);
      if (this.room.chatId === chat) {
        this.renderHistory();
        this.refresh();
      }
      return GLib.SOURCE_REMOVE;
    }));
    this.renderHistory();
  }

  private clearTyping(): void {
    for (const timer of this.typingTimers.values()) GLib.Source.remove(timer);
    this.typingTimers.clear();this.typingRooms.clear();this.typing = false;
  }

  private stopTyping(key: string): void {
    const timer = this.typingTimers.get(key);
    if (timer) GLib.Source.remove(timer);
    this.typingTimers.delete(key);this.typingRooms.delete(key);
  }

  private onFrame(frame: GatewayFrame): void {
    this.signal(frame);
    const continuation = frame.type === "log" ? object(frame.data) : frame;
    if (continuation.type === "owner_continue_admitted" && continuation._historical !== true) {
      this.continuationChanged(continuation.predecessor_task_id);
    }
    this.call.frame(frame);
    this.contributions.frame(frame);
    this.cards.widgetFrame(frame);
    const belongs = chatFrameAccepts(frame, this.room.chatId, this.projectRooms);
    if (belongs) this.routing.frame(frame);
    const reviewEvent = frame.type === "log" ? frame.data : frame;
    if (belongs && reviewEvent && typeof reviewEvent === "object"
      && (!("_historical" in reviewEvent) || reviewEvent._historical !== true)) {
      const reference = reviewReference(reviewEvent);
      if (reference) {
        this.reviews.reference(reference);
        this.refresh();
        return;
      }
    }
    if ((frame.type === "quiz_state" || frame.type === "quiz")
      && typeof frame.task_id === "string" && typeof frame.quiz_id === "string") {
      if (this.ownerQuestions) {
        if (this.options.managesConnection !== false) this.ownerQuestions.update(frame.task_id, frame.quiz_id, frame);
      }
      else this.questions.update(frame.task_id, frame.quiz_id, frame);
    }
    if (frame.type === "card_state" && frame.card && typeof frame.card === "object" && "card_id" in frame.card
      && typeof frame.card.card_id === "string") this.cards.update(frame.card.card_id);
    if (frame.type === "extension_lifecycle" && frame.skill === "_cards") this.cards.updatePins();
    if (frame.type === "chat" && frame._historical !== true && (belongs || frame.chat_id !== this.room.chatId)) this.ingressFrame(frame);
    if (!belongs
      && !["card_state", "quiz_state", "task_named", "extension_lifecycle"].includes(frame.type)) return;
    this.liveSpoken.frame(frame);
    if (frame.type === "chat" && Object.hasOwn(frame, "spoken") && frame._historical !== true) this.fullSpeechHistory = true;
    if (this.liveMedia.frame(frame)) this.renderHistory();
    const dispatchProgress = frame.type === "chat" && frame.is_progress === true && readDispatchFacts(frame).present;
    if (frame.type === "chat" && (frame.role === "system" || dispatchProgress) && belongs && frame._historical !== true
      && typeof frame.ts === "string" && (dispatchProgress || typeof frame.system_type === "string"
        && (frame.system_type === "reminder" || skillProgressRow(frame) || submissionNotice(frame.system_type) || isRetainedWork(frame)
          || (this.room.chatId === 1 && frame.system_type === "project_completion_summary")))) {
      const message: ChatRow = { ...frame, role: typeof frame.role === "string" ? frame.role : "system",
        system_type: typeof frame.system_type === "string" ? frame.system_type : undefined, ts: frame.ts,
        text: typeof frame.content === "string" ? frame.content : "" };
      const key = isProjectCompletion(message) && typeof message.delivery_id === "string" && message.delivery_id
        ? `completion:${message.delivery_id}` : historyKey(message);
      this.liveNotices.delete(key);
      this.liveNotices.set(key, message);
      if (this.liveNotices.size > 32) this.liveNotices.delete(this.liveNotices.keys().next().value!);
      if (!this.anchored && !this.resetLatest) this.renderHistory();
    }
    const activity = frame.type === "chat" ? delegatedActivity(frame) : undefined;
    if (activity && frame._historical !== true) {
      const key = delegatedKey(activity);
      this.liveDelegated.delete(key);
      this.liveDelegated.set(key, {
        ...frame, delegated_activity: activity, task_id: activity.task_id, is_progress: true,
        role: typeof frame.role === "string" ? frame.role : "assistant",
        text: typeof frame.content === "string" ? frame.content : typeof frame.text === "string" ? frame.text : "",
      });
      if (this.liveDelegated.size > 64) this.liveDelegated.delete(this.liveDelegated.keys().next().value!);
      if (!this.anchored && !this.resetLatest) this.renderHistory();
    }
    if (frame.type === "typing") {
      const chat = frameChatId(frame);
      if (chat === undefined) return;
      const activity = typeof frame.activity_id === "string" ? frame.activity_id : "";
      const key = JSON.stringify([chat, activity]);
      if (frame.action === "start" || frame.action === "typing") {
        this.stopTyping(key);this.typingRooms.add(key);
        // A canonical bridge typing announcement has no paired stop. It is a
        // short presentation hint; only the state census declares live work.
        if (frame.action === "typing") this.typingTimers.set(key, GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
          this.typingTimers.delete(key);this.typingRooms.delete(key);
          this.typing = this.typingRooms.size > 0;
          if (!this.disposed) this.renderStatus();return GLib.SOURCE_REMOVE;
        }));
      }
      else if (frame.action === "stop") {
        if (activity) this.stopTyping(key);
        else for (const pending of this.typingRooms) if (JSON.parse(pending)[0] === chat) this.stopTyping(pending);
      }
      this.typing = this.typingRooms.size > 0;
      this.renderStatus();
    } else if (historySignals.has(frame.type)) {
      this.refresh();
    }
  }

  private async history(chatId: number, cursor?: string, around?: string, cancel?: any): Promise<History> {
    const readAt = GLib.get_monotonic_time();
    const history = await this.gateway.json<History>("GET", "/api/chat/history" + query({
      chat_id: chatId, n_human: 50, n_progress: 35, cursor, around,
    }), undefined, undefined, false, cancel);
    this.routing.remember(history.messages ?? history.rows, readAt);
    return history;
  }

  private cancelJump(): void {
    if (!this.jump) return;
    const cancel = this.jump;
    this.jump = undefined;
    cancel.cancel();
    this.historyNotice.set_label("");
  }

  private showLatest(fetch = true): void {
    this.cancelJump();
    this.endReadOpening();
    this.opening = fetch;
    this.readView?.setReceipt();
    this.readRevision = undefined;
    this.readLatest = null;
    this.readSearch = undefined;
    this.view++;
    this.reading = this.dirty = this.loadingOlder = false;
    this.older.set_sensitive(false);
    this.anchored = false;
    this.resetLatest = true;
    this.after = undefined;
    this.historyNotice.set_label("");
    if (fetch) this.refresh();
  }

  private async historyProject(values: { id: string } | { chat_id: number }, cancel: any): Promise<Room> {
    const project = await readProject(this.gateway, values, cancel);
    if (!project || project.lifecycle === "deleting") {
      throw new Error("Шлюз не подтвердил комнату, в которой находится запись.");
    }
    return { chatId: project.chat_id, projectId: project.id, name: project.name || project.id };
  }

  async openProject(id: string, chatId?: number): Promise<void> {
    if (this.disposed) return;
    const current = this.options.beginNavigation?.() ?? (() => true);
    this.cancelJump();
    const cancel = new Gio.Cancellable();
    this.jump = cancel;
    const wanted = () => this.jump === cancel && !this.disposed && current();
    try {
      const room = await this.historyProject({ id }, cancel);
      if (!wanted()) return;
      if (chatId && room.chatId !== chatId) throw new Error("Шлюз не подтвердил комнату назначения.");
      if (this.options.hostRoom) this.options.hostRoom(room, this);
      else {
        this.setRoom(room);
        this.historyRoom?.(room);
      }
    } catch (error) {
      if (wanted()) this.historyNotice.set_label(errorText(error));
    } finally {
      if (wanted()) this.jump = undefined;
    }
  }

  openTaskHistory(taskId: string, projectId?: string, chatId?: number): void {
    void this.jumpToHistory(`task:${taskId}`, true, projectId, chatId);
  }

  private async jumpToHistory(address: string, task = false, projectId?: string, chatId?: number): Promise<void> {
    if (this.disposed || !address) return;
    const current = this.options.beginNavigation?.() ?? (() => true);
    this.welcome.historyPending();
    this.cancelJump();
    this.endReadOpening();
    const cancel = new Gio.Cancellable();
    this.jump = cancel;
    this.historyNotice.set_label(task ? "Ищу начало задачи…" : "Ищу исходное сообщение…");
    const wanted = () => this.jump === cancel && !this.disposed && current();
    try {
      let room = this.room;
      if (projectId && projectId !== room.projectId) room = await this.historyProject({ id: projectId }, cancel);
      else if (!projectId && chatId && chatId !== room.chatId) {
        room = chatId === 1 ? { chatId: 1, name: "Main" } : await this.historyProject({ chat_id: chatId }, cancel);
      }
      const visited = new Set<number>();
      while (wanted()) {
        if (visited.has(room.chatId) || visited.size >= 5) throw new Error("Шлюз вернул противоречивое расположение записи.");
        visited.add(room.chatId);
        const readAt = GLib.get_monotonic_time();
        const result = await this.history(room.chatId, undefined, address, cancel);
        if (!wanted()) return;
        const anchor = result.anchor;
        if (anchor?.state === "moved") {
          let destination = anchor.chat_id;
          if (task && !destination) {
            const state = await this.gateway.json<{ task_bindings?: Record<string, unknown> }>(
              "GET", "/api/state", undefined, undefined, false, cancel);
            const bound = projectBinding(state.task_bindings?.[address.slice(5)]);
            if (bound && bound.id !== room.projectId) {
              room = await this.historyProject({ id: bound.id }, cancel);
              if (bound.chatId !== undefined && bound.chatId !== room.chatId) throw new Error("Шлюз вернул противоречивое расположение записи.");
              continue;
            }
          }
          if (!destination || !Number.isSafeInteger(destination)) throw new Error("Шлюз не сообщил, куда перенесена запись.");
          room = destination === 1 ? { chatId: 1, name: "Main" } : await this.historyProject({ chat_id: destination }, cancel);
          continue;
        }
        if (anchor?.state === "absent") throw new Error(task ? "В сохранённой истории нет записи об этой задаче."
          : "Исходное сообщение отсутствует в сохранённой истории.");
        if (anchor?.state === "ambiguous") throw new Error("Шлюз не смог однозначно определить исходное сообщение.");
        if (anchor?.state === "unavailable") throw new Error("Шлюз не может открыть исходную запись.");
        const messages = result.messages;
        const identity = task ? anchor?.task_id === address.slice(5) : anchor?.row_address === address;
        const target = anchor?.state === "found" && identity && Array.isArray(messages) && messages.find((message) => visibleRow(message)
          && ((!task && message.row_address === address) || Boolean(anchor.history_id && message.history_id === anchor.history_id)));
        if (!target || !result.page_cursor || (anchor?.chat_id !== undefined && anchor.chat_id !== room.chatId)
          || (result.has_more && !result.next_cursor)) {
          throw new Error("Шлюз не вернул точную строку истории.");
        }
        this.jump = undefined;
        const destination = this.options.hostRoom?.(room, this) ?? this;
        if (destination !== this) this.historyNotice.set_label("");
        destination.presentAnchor(room, result, target, readAt);
        return;
      }
    } catch (error) {
      if (wanted()) this.historyNotice.set_label(this.historyFailure(error));
    } finally {
      if (this.jump === cancel) this.jump = undefined;
    }
  }

  private presentAnchor(room: Room, history: History, target: ChatRow, readAt: number): void {
    const changedRoom = room.chatId !== this.room.chatId || room.projectId !== this.room.projectId;
    this.enterRoom(room);
    this.opening = false;
    this.anchored = true;
    this.current = history.messages!;
    this.cursor = history.has_more ? history.next_cursor ?? undefined : undefined;
    this.incomplete = this.historyGap(history);
    if (changedRoom) this.historyRoom?.(room);
    this.historyIngress(this.current, readAt);
    this.finishIngressRecovery();
    this.renderHistory(false, target);
    this.renderStatus();
  }

  private historyFailure(error: unknown): string {
    if (error instanceof HttpError) {
      if (error.reason === "migrating") return "Шлюз переносит сохранённую историю. Повторите чтение позже.";
      if (error.reason === "history_source_unavailable") return "Часть сохранённой истории недоступна на шлюзе.";
    }
    return errorText(error);
  }

  private historyGap(history: History): boolean {
    const reasons = history.window?.truncated_by;
    return history.window?.complete === false && (!reasons?.length || reasons.some((code) => !["quota", "page"].includes(code)));
  }

  private async readHistory(): Promise<void> {
    if (this.disposed || this.anchored || (this.resetLatest && !this.widget.get_mapped())) return;
    if (this.reading) {
      this.dirty = true;
      return;
    }
    this.reading = true;
    this.welcome.historyPending();
    void this.welcome.refresh();
    const readAt = GLib.get_monotonic_time();
    const view = this.view;
    const revision = this.roomReads?.revision(this.room);
    const active = () => !this.disposed && view === this.view;
    const fullSpeechHistory = this.fullSpeechHistory;
    this.fullSpeechHistory = false;
    try {
      const chatId = this.room.chatId;
      // A delta cannot confirm an empty Main: its window covers only new rows.
      const emptyMain = chatId === 1 && !this.current.length && !this.archived.length;
      const after = fullSpeechHistory || emptyMain || this.ingress.waiting(chatId) || this.liveIngress.size ? undefined : this.after;
      let history: History | undefined;
      if (after) {
        try {
          const arrival = await this.history(chatId, after);
          if (!active()) return;
          const gaps = arrival.window?.truncated_by?.some((cause) => /^(chat|progress)_/u.test(cause)
            && cause !== "progress_incomplete_live_line");
          if (Array.isArray(arrival.messages) && arrival.after_cursor && !gaps && arrival.window?.latest_message !== null) history = arrival;
        } catch (error) {
          if (!active()) return;
          if (error instanceof HttpError && ["history_view_changed", "history_delta_reset"].includes(error.reason ?? "")) {
            this.invalidHistoryChain = true;
            this.olderVersion++;
            this.loadingOlder = false;
            this.older.set_sensitive(false);
          }
        }
        if (!history) this.after = undefined;
      }
      const delta = Boolean(history);
      history ??= await this.history(chatId);
      if (!active()) return;
      const messages = history.messages ?? history.rows ?? [];
      if (!Array.isArray(history.messages ?? history.rows)) throw new Error("Шлюз не вернул страницу истории.");
      const goBottom = this.resetLatest;
      const reset = goBottom || this.invalidHistoryChain;
      if (delta) {
        const merged = new Map(this.current.filter((message) => !message.lifecycle_virtual).map((message) => [historyKey(message), message]));
        for (const message of messages) merged.set(historyKey(message), message);
        this.current = [...merged.values()].sort((a, b) => (a.ts ?? "") < (b.ts ?? "") ? -1 : (a.ts ?? "") === (b.ts ?? "") ? 0 : 1);
      } else if (reset || !this.olderRead) {
        if (reset) {
          this.archived = [];
          this.olderVersion++;
          this.loadingOlder = false;
        }
        this.olderRead = false;
        this.cursor = history.has_more ? history.next_cursor ?? undefined : undefined;
        this.current = messages;
      } else {
        const currentKeys = new Set(messages.map(historyKey));
        const oldKeys = new Set(this.archived.map(historyKey));
        this.archived.push(...this.current.filter((message) =>
          !message.lifecycle_virtual && !currentKeys.has(historyKey(message)) && !oldKeys.has(historyKey(message))));
        this.current = messages;
      }
      this.after = history.after_cursor || undefined;
      this.incomplete = this.historyGap(history);
      this.historyError = "";
      this.resetLatest = false;
      this.invalidHistoryChain = false;
      this.older.set_sensitive(true);
      this.historyIngress(messages, readAt);
      this.renderHistory(false, undefined, goBottom);
      this.welcome.historyRead(history.window?.complete === true);
      this.readPortalEpisodes();
      this.renderStatus();
      this.readWindow(history, revision, delta);
    } catch (error) {
      if (active()) {
        this.fullSpeechHistory ||= fullSpeechHistory;
        this.historyError = this.historyFailure(error);
        this.renderStatus();
      }
    } finally {
      if (view === this.view) {
        this.finishIngressRecovery();
        this.reading = false;
        if (this.dirty) {
          this.dirty = false;
          this.refresh();
        }
      }
    }
  }

  private async loadOlder(forOpening = false): Promise<boolean> {
    if (!this.cursor || this.loadingOlder || this.resetLatest || this.invalidHistoryChain) return false;
    if (!forOpening) { this.cancelJump(); this.endReadOpening(); }
    const view = this.view;
    const version = this.olderVersion;
    const readAt = GLib.get_monotonic_time();
    const active = () => !this.disposed && view === this.view && version === this.olderVersion;
    this.loadingOlder = true;
    this.older.set_sensitive(false);
    try {
      const cursor = this.cursor;
      const history = await this.history(this.room.chatId, cursor);
      if (!active()) return false;
      if (!Array.isArray(history.messages ?? history.rows)) throw new Error("Шлюз не вернул страницу истории.");
      if (history.has_more && (!history.next_cursor || history.next_cursor === cursor)) {
        throw new Error("Шлюз не продвинул курсор истории.");
      }
      const messages = history.messages ?? history.rows ?? [];
      this.archived.unshift(...messages);
      this.historyIngress(messages, readAt);
      this.olderRead = true;
      this.incomplete ||= this.historyGap(history);
      this.historyError = "";
      this.cursor = history.has_more ? history.next_cursor ?? undefined : undefined;
      this.renderHistory(true);
      this.renderStatus();
      this.readOlderWindow(history);
      return true;
    } catch (error) {
      if (!active()) return false;
      this.historyError = this.historyFailure(error);
      this.renderStatus();
      if (error instanceof HttpError && error.status === 409) {
        if (!this.anchored) this.showLatest();
      }
      return false;
    } finally {
      if (active()) {
        this.loadingOlder = false;
        this.older.set_sensitive(true);
      }
    }
  }

  private renderStatus(): void {
    const position = this.anchored ? " · Просмотр старой записи" : "";
    const count = this.incomplete ? " · История показана частично"
      : !this.current.length && !this.archived.length && !this.historyError ? " · История пуста" : "";
    const activity = this.typing ? " · Ouroboros печатает…" : "";
    const connection = this.socket.online ? "В реальном времени" : "Переподключение · история обновляется по HTTP";
    this.status.set_label([connection + position + count + activity, this.historyError].filter(Boolean).join("\n"));
    this.latest.set_visible(this.anchored || this.resetLatest);
  }

  private renderHistory(prepend = false, target?: ChatRow, forceBottom = false): void {
    this.older.set_visible(Boolean(this.cursor));
    const rows = new Map<string, ChatRow>();
    for (const message of [...this.archived, ...this.current]) {
      if (!visibleRow(message)) continue;
      const quiz = messageQuiz(message);
      if (quiz && message.task_id && !taskReferencePending(message)) this.questions.observe(message.task_id, quiz);
      const reference = message.system_type === "review_reference" ? reviewReference(message) : undefined;
      const key = reference ? `review:${reference.surface}:${reference.task}` : historyKey(message);
      if (reference) rows.delete(key);
      rows.set(key, this.liveSpoken.decorate(message));
    }
    this.routing.adopt(rows.values());
    const liveOwnerRows: ChatRow[] = [];
    for (const [id, { message }] of this.liveIngress) {
      const key = `owner:${id}`;
      const saved = rows.get(key);
      if (saved?.role === "user" && !saved.origin_projected) rows.set(key, {
        ...saved, ingress_accepted: true, ingress_pending: message.ingress_pending, ingress_dispatched: message.ingress_dispatched,
      });
      else if (!saved) liveOwnerRows.push(message);
    }
    const stored = [...rows.values()];
    const live = this.liveMedia.extra(stored);
    const recorded = new Set(stored.flatMap((message) => {
      const activity = delegatedActivity(message);
      return activity ? [delegatedKey(activity)] : [];
    }));
    for (const key of recorded) this.liveDelegated.delete(key);
    const savedNotices = stored.filter(hostNotice);
    for (const [key, notice] of this.liveNotices) {
      if (savedNotices.some(saved => sameHostNotice(notice, saved))) this.liveNotices.delete(key);
    }
    const ephemeral = new Set<ChatRow>(this.anchored || this.resetLatest ? []
      : [...live, ...this.liveDelegated.values(), ...liveOwnerRows, ...this.liveNotices.values()]);
    const presented: ChatRow[] = [...stored, ...ephemeral];
    this.welcome.setContent(this.anchored || presented.length > 0);
    if (ephemeral.size) presented.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
    const destinations = new Map<ChatRow, ProjectTarget>();
    const aliases = new Map<ChatRow, ChatRow>();
    if (this.room.chatId === 1) {
      const markers = new Map<ChatRow, ProjectTarget>();
      const bindings = new Map(this.bindings);
      for (const message of presented) {
        const marker = projectMarker(message);
        if (!marker) continue;
        markers.set(message, marker);
        if (!taskReferencePending(message) && message.system_type !== "project_completion_summary" && exactWorkTarget(message.task_id) && !bindings.has(message.task_id)) {
          bindings.set(message.task_id, marker);
        }
      }
      const primary = new Map<string, ChatRow>();
      for (const message of presented) {
        const task = taskReferencePending(message) ? undefined : message.task_id;
        if (exactWorkTarget(task) && !primary.has(task) && !originAddressed(message.system_type)
          && !message.is_progress && !message.lifecycle_virtual && !message.parent_task_id
          && (message.role === "user" || message.role === "assistant") && bindings.has(task)) primary.set(task, message);
      }
      for (const message of presented) {
        const task = taskReferencePending(message) ? undefined : message.task_id;
        const marker = markers.get(message);
        const bound = exactWorkTarget(task) ? bindings.get(task) : undefined;
        if (marker && (!task || message.system_type === "project_completion_summary" || marker.id !== bound?.id)) {
          destinations.set(message, marker);
        } else if (bound && task) {
          if (marker && !primary.has(task)) primary.set(task, message);
          const root = primary.get(task);
          if (root === message) destinations.set(message, bound);
          else if (root && marker) aliases.set(message, root);
        }
      }
    }
    const episodes = new Map<string, EpisodeFacts>();
    for (const message of [...this.archived, ...this.current]) noteEpisode(episodes, message);
    for (const detail of this.episodeDetails.values()) noteEpisode(episodes, detail, true);
    this.episodes = episodes;
    const { groups, past, actions } = episodeLayout(presented.filter((message) => !aliases.has(message)), episodes,
      (message) => message.role === "user" || Boolean(projectMarker(message) || destinations.has(message)));
    const controls = new Map([...actions].map(([task, message]) => [message, task]));
    const outcomes = new Map<string, ChatRow>();
    if (this.room.projectId) {
      for (const message of presented) {
        const task = episodeTask(message);
        if (!task || message.is_progress || !projectTaskPhase(message)) continue;
        if (message.system_type === "task_summary"
          || (!message.system_type && !message.msg_type && message.role === "assistant"
            && outcomes.get(task)?.system_type !== "task_summary")) outcomes.set(task, message);
      }
    }
    const outcomeRows = new Set(outcomes.values());
    const delivery = presented.flatMap((message) => {
      const id = message.client_message_id;
      return messageId(id) && ingressState(message) === "pending" && this.ingress.retryable(this.room.chatId, id)
        ? [[id, this.socket.online, this.ingressRetries.has(JSON.stringify([this.room.chatId, id]))]] : [];
    });
    const fingerprint = JSON.stringify([presented, this.liveMedia.version, delivery, [...episodes.values()], this.nestedExpanded,
      [...this.nestedChoices],
      [...this.episodeFeedback], [...this.episodePending.keys()],
      presented.map((message) => [destinations.get(message), aliases.get(message) && historyKey(aliases.get(message)!)])]);
    if (fingerprint === this.rendered && !forceBottom && !target) return;
    const adjustment = this.scroll.get_vadjustment();
    const bottom = adjustment.get_upper() - adjustment.get_page_size();
    const value = adjustment.get_value();
    const follow = !target && (forceBottom || !this.rendered || bottom - value < 30);
    const view = this.view;
    this.rendered = fingerprint;
    this.readAloud.clearRows();
    this.contributionActions.resetRows();
    this.routing.resetRows();
    for (const [key, view] of this.skillProgressViews) {
      const identity = skillProgressIdentity(view.rawMessage) ?? key;
      if (view.widget.expanded) this.skillProgressExpanded.add(identity);else this.skillProgressExpanded.delete(identity);
      view.close();
    }
    this.skillProgressViews.clear();
    const progressKeys = new Set(presented.filter(skillProgressRow).map(message => skillProgressIdentity(message) ?? historyKey(message)));
    for (const key of this.skillProgressExpanded) if (!progressKeys.has(key)) this.skillProgressExpanded.delete(key);
    for (const view of this.dispatchFactsViews.splice(0)) view.close();
    for (const { key, view } of this.spokenViews.splice(0)) {
      if (view.widget.expanded) this.spokenExpanded.add(key);else this.spokenExpanded.delete(key);
      view.close();
    }
    const spokenKeys = new Set(presented.map(message => spokenReceiptIdentity(message) ?? historyKey(message)));
    for (const key of this.spokenExpanded) if (!spokenKeys.has(key)) this.spokenExpanded.delete(key);
    const dispatchKeys = new Set(presented.map(dispatchMessageKey));
    for (const key of this.dispatchFactsExpanded) if (!dispatchKeys.has(key)) this.dispatchFactsExpanded.delete(key);
    clear(this.list);
    let focus: any;
    const readRows: ReadRow[] = [];
    const activities = new Map<ChatRow, DelegatedActivity>();
    for (const message of presented) {
      const activity = delegatedActivity(message);
      if (activity) activities.set(message, activity);
    }
    const projections = projectDelegated([...activities.values()]);
    const widgets = new Map<ChatRow, any>();
    const previous = new Map<string, { panel: any; content: any }>();
    const nestable = (message: ChatRow) => !taskReferencePending(message) && !originAddressed(message.system_type)
      && message.system_type !== "project_question_pointer" && message.system_type !== "reminder";
    const nested = new NestedTasks(this.list, presented.filter(nestable),
      this.nestedExpanded, this.nestedChoices, this.openTask);
    for (const message of presented) {
      if (aliases.has(message)) continue;
      const chain = groups.get(message);
      if (chain) this.mountEpisodes(chain, episodes, previous);
      const activity = activities.get(message);
      const projected = activity ? projections.get(activity) : undefined;
      if (projected?.hidden && (!target || historyKey(message) !== historyKey(target))) continue;
      const widget = this.messageRow(message, projected, destinations.get(message), controls.get(message),
        outcomeRows.has(message) ? projectTaskPhase(message) : "");
      widgets.set(message, widget);
      const earlier = past.get(message);
      const disclosure = earlier ? previous.get(earlier) : undefined;
      if (disclosure) {
        disclosure.content.append(widget);
        if (target && historyKey(message) === historyKey(target)) disclosure.panel.set_expanded(true);
      } else nested.append(nestable(message) ? message.task_id : undefined, widget,
        Boolean(target && historyKey(message) === historyKey(target)));
    }
    for (const message of presented) {
      const widget = widgets.get(aliases.get(message) ?? message);
      if (!widget) continue;
      if (target && historyKey(message) === historyKey(target)) focus = widget;
      if (this.readView && !ephemeral.has(message)) readRows.push({ widget, id: message.history_id, address: message.row_address,
        revisions: message.room_revisions, version: message.room_revisions ? JSON.stringify(message) : undefined });
    }
    if (focus) {
      focus.add_css_class("card");
      focus.set_focusable(true);
      let frames = 0;
      this.viewport.add_tick_callback(() => {
        if (this.disposed || view !== this.view) return GLib.SOURCE_REMOVE;
        if (++frames <= 8 && !focus.get_height()) return GLib.SOURCE_CONTINUE;
        focus.grab_focus();
        this.viewport.scroll_to(focus, null);
        return GLib.SOURCE_REMOVE;
      });
    } else if (prepend || follow) {
      this.scroll.add_tick_callback(() => {
        if (!this.disposed && view === this.view) {
          const newBottom = adjustment.get_upper() - adjustment.get_page_size();
          adjustment.set_value(prepend ? newBottom - bottom + value : newBottom);
        }
        return GLib.SOURCE_REMOVE;
      });
    }
    this.readView?.setRows(readRows);
  }

  private mountEpisodes(chain: string[], episodes: Map<string, EpisodeFacts>,
    previous: Map<string, { panel: any; content: any }>): void {
    const box = column(6);
    box.set_margin_top(8);
    box.set_margin_bottom(8);
    box.set_margin_start(8);
    box.set_margin_end(8);
    const name = episodes.get(chain[0])?.name;
    box.append(label(name ? `Попытки задачи · ${name}` : "Попытки задачи", "heading"));
    for (const [index, task] of chain.entries()) {
      const heading = episodeTitle(task, index, episodes.get(task));
      const body = column(4);
      const current = index === chain.length - 1;
      if (current) {
        body.append(label(heading));
        box.append(body);
      } else {
        const panel = new Gtk.Expander({ label: heading, child: body, expanded: this.episodeExpanded.has(task) });
        panel.connect("notify::expanded", () => {
          if (panel.get_expanded()) this.episodeExpanded.add(task);
          else this.episodeExpanded.delete(task);
        });
        previous.set(task, { panel, content: body });
        box.append(panel);
      }
      if (this.openTask) {
        const open = button(current ? "Открыть текущую попытку" : "Открыть прежнюю попытку", () => this.openTask?.(task));
        open.set_halign(Gtk.Align.START);
        body.append(open);
      }
      if (current) this.mountContinuation(body, task);
      else if (this.episodeFeedback.has(task)) box.append(label(this.episodeFeedback.get(task)!, "dim-label"));
    }
    this.list.append(box);
  }

  private mountContinuation(box: any, task: string): void {
    const offer = this.episodes.get(task)?.offer;
    if (offer?.message) box.append(label(offer.message, "dim-label"));
    const feedback = this.episodeFeedback.get(task);
    if (feedback) box.append(label(feedback, "dim-label"));
    if (this.workState && (offer?.kind === "offer" || offer?.kind === "retry")) {
      const action = button(offer.kind === "retry" ? "Повторить продолжение" : "Продолжить задачу",
        () => void this.continueTask(task));
      action.set_halign(Gtk.Align.START);
      action.set_sensitive(!this.episodePending.has(task) && !this.workState.actions.busy(task));
      box.append(action);
    }
  }

  private messageRow(message: ChatRow, activity?: ActivityView, destination?: ProjectTarget, continuation?: string, phase = ""): any {
    const box = column(4);
    box.set_margin_top(8);
    box.set_margin_bottom(8);
    box.set_margin_start(8);
    box.set_margin_end(8);
    const completion = projectCompletion(message);
    const speaker = completion?.answer ? "assistant" : message.role;
    const sender = chatSender(message, speaker);
    const swarm = message.role === "user" && message.subagents_mode === "swarm";
    const details = [swarm ? "Рой" : "", message.ts].filter(Boolean).map(value => " · " + value).join("");
    const author = chrome(label(sender.russian + details, "dim-label"), "label", sender.english + "{details}",
      { details, ...(sender.sender === undefined ? {} : { sender: sender.sender }) });
    author.set_wrap_mode(Pango.WrapMode.WORD_CHAR);author.set_max_width_chars(64);author.set_selectable(true);box.append(author);
    const source = contactSource(message.presence_contact ?? message.quiz?.presence_contact);
    if (source) box.append(source);
    const notice = submissionNotice(message.system_type);
    if (notice) box.append(label(notice, "heading"));
    const retained = isRetainedWork(message);
    if (retained) box.append(label(savedWorkTitle, "heading"));
    if (phase) box.append(label(phase, "heading"));
    const relay = speaker === "assistant" ? relayContext(message.relay, address => void this.jumpToHistory(address),
      this.relayExpansion, `${this.room.chatId}:${historyKey(message)}`) : undefined;
    if (relay) box.append(relay.widget);
    const quote = !relay?.quoted ? replyQuote(message.reply_to, address => void this.jumpToHistory(address, address.startsWith("task:"))) : undefined;
    if (quote) box.append(quote);
    this.media.append(this.parent, box, message, this.liveMedia.dataFor(message));
    const words = completion?.body ?? (activity ? "" : mediaCaption(message));
    const renderText = (text: string) => chatTextView(text, { ...message, role: speaker }, this.gateway.base, href => {
      const route = chatDownloadRoute(href, this.gateway.base);
      if (!route) return false;
      if (!this.disposed) this.media.openDownload(this.parent, route);
      return true;
    }, diagramImageLoader(this.gateway));
    if (completion) renderProjectCompletion(box, completion, renderText);
    else if (words) box.append(renderText(words));
    if (phase && message.outcome_final === true) {
      const ended = projectTerminalTime(message.terminal_time);
      if (ended) box.append(label(ended, "dim-label"));
    }
    this.mountIngress(box, message);
    if (activity) renderDelegated(box, activity, (target, task, ref) =>
      this.reviews.publishedSource(this.parent, target, task, "Открыть сохранённый диапазон журнала", ref));
    renderExecutor(box, message);
    const missingSpeechReceipt = message.source === "live_call" && message.role === "assistant" && message.system_type === "model_narration" && !Object.hasOwn(message, "spoken");
    if (Object.hasOwn(message, "spoken") || missingSpeechReceipt) {
      const view = new SpokenReceiptView(message, missingSpeechReceipt), key = spokenReceiptIdentity(message) ?? historyKey(message);
      view.widget.expanded = this.spokenExpanded.has(key);this.spokenViews.push({ key, view });box.append(view.widget);
    }
    if (readDispatchFacts(message).present) {
      const dispatch = new DispatchFactsView(message), dispatchKey = dispatchMessageKey(message);
      dispatch.widget.expanded = this.dispatchFactsExpanded.has(dispatchKey);
      dispatch.widget.connect("notify::expanded", () => {
        if (dispatch.widget.expanded) this.dispatchFactsExpanded.add(dispatchKey);else this.dispatchFactsExpanded.delete(dispatchKey);
      });
      this.dispatchFactsViews.push(dispatch);box.append(dispatch.widget);
    }
    const routing = this.routing.mount(message);
    if (routing) box.append(routing);
    if (destination) {
      const open = button(`Открыть проект · ${destination.name || destination.id}`,
        () => void this.openProject(destination.id, destination.chatId));
      open.set_halign(Gtk.Align.START);
      box.append(open);
    }
    const replyText = words;
    if (speaker === "assistant" && !message.is_progress && !message.lifecycle_virtual && replyText?.trim()) {
      box.append(this.readAloud.controls(historyKey(message), replyText));
    }
    const quiz = messageQuiz(message);
    if (skillProgressRow(message)) {
      const progress = new SkillProgressView(message, this.openTask, task => this.reviews.history(this.parent, task, undefined, true));
      const key = historyKey(message);progress.widget.expanded = this.skillProgressExpanded.has(skillProgressIdentity(message) ?? key);
      this.skillProgressViews.set(key, progress);box.append(progress.widget);
    }
    const taskId = taskReferencePending(message) || skillProgressRow(message) || message.system_type === "reminder" ? undefined : message.task_id;
    if (quiz && taskId) {
      const question = button("Открыть вопрос", () => this.questions.show(taskId, quiz));
      question.set_halign(Gtk.Align.START);
      box.append(question);
    }
    const card = message.card;
    if (card?.card_id) {
      const chatId = this.room.chatId;
      const open = button(card.title || "Открыть карточку", () => this.cards.show(card, message.text ?? "", {
        append: (line) => this.appendCardDraft(chatId, line),
        focus: () => {
          if (!this.disposed && this.room.chatId === chatId) this.composer.grab_focus();
        },
      }));
      open.set_halign(Gtk.Align.START);
      box.append(open);
    }
    const review = message.review_group;
    if (review?.surface === "skill") {
      const open = button("Проверки навыка…", () => this.reviews.skill(this.parent, review, taskId));
      open.set_halign(Gtk.Align.START);
      box.append(open);
    }
    const reference = reviewReference(message);
    const reviewOwner = reference?.task ?? taskId;
    if (exactWorkTarget(reviewOwner) && (reference || message.system_type === "body_adoption" || message.body_adoptions?.length
      || message.review_projection?.panels?.length || message.review_projection?.gaps?.length || message.plan_record || message.plan_objections)) {
      const open = button(reference?.surface === "plan_review" ? "План и ревью…" : "Ревью задачи…",
        () => this.reviews.history(this.parent, reviewOwner, message, true));
      open.set_halign(Gtk.Align.START);
      box.append(open);
    }
    if (message.late_evidence) this.reviews.lateEvidence(this.parent, box, taskId, message.late_evidence);
    if (continuation) this.mountContinuation(box, continuation);
    if (exactWorkTarget(taskId) && this.openTask) {
      const actions = row();
      const startReceipt = message.system_type === "task_not_started" || message.system_type === "task_start_unconfirmed";
      actions.append(button(startReceipt ? "Открыть запись попытки" : retained ? "Открыть сохранённую работу задачи" : "Открыть задачу",
        () => this.openTask?.(taskId)));
      box.append(actions);
    }
    if (message.row_address) {
      const reply = button("Ответить", () => {
        if (this.draft.pending) return;
        this.draft.reply = message.row_address;
        this.draftRevision++;
        this.renderDraft();
        this.composer.grab_focus();
      });
      reply.set_halign(Gtk.Align.START);
      box.append(reply);
      if (message.role === "assistant" && !message.is_progress && !message.lifecycle_virtual
        && !card && !quiz && !review && !message.summary_kind) {
        box.append(this.contributionActions.message({ address: message.row_address, text: actionText(replyText ?? "") }));
      }
    }
    box.append(new Gtk.Separator());
    return box;
  }

  private mountIngress(box: any, message: ChatRow): void {
    const state = ingressState(message);
    const id = message.client_message_id;
    if (!state || !messageId(id)) return;
    box.append(label(state === "pending" ? "Сохранено · Ожидает передачи" : state === "dispatched"
      ? "Сохранено · Передача в обработку началась" : "Сохранено · Передача не подтверждена", "dim-label"));
    const chat = this.room.chatId;
    if (state === "pending" && this.ingress.retryable(chat, id)) {
      const retry = button("Повторить передачу", () => this.retryIngress(id));
      retry.set_halign(Gtk.Align.START);
      retry.set_sensitive(this.socket.online && !this.ingressRetries.has(JSON.stringify([chat, id])));
      box.append(retry);
    } else if (state === "saved" && !message.text_placeholder && message.text?.trim()) {
      const words = message.text;
      const compose = button("В черновик как новое сообщение", () => {
        if (!this.appendCardDraft(chat, words)) {
          this.sendStatus.set_label("Сначала завершите текущую отправку.");
          return;
        }
        this.composer.grab_focus();
      });
      compose.set_halign(Gtk.Align.START);
      box.append(compose);
    }
  }

  private async attachFile(): Promise<void> {
    if (this.disposed) return;
    const draft = this.draft;
    if (draft.upload || draft.pending) return;
    const upload: NonNullable<Draft["upload"]> = { cancel: new Gio.Cancellable() };
    draft.upload = upload;
    draft.uploadNotice = undefined;
    this.draftRevision++;
    this.syncComposer();
    try {
      const file = await chooseFile(this.parent, undefined, upload.cancel);
      if (!file || this.disposed || upload.cancel.is_cancelled()) return;
      upload.name = file.get_basename() || "Вложение";
      upload.status = "Открываю файл…";
      if (draft === this.draft) this.syncUpload();
      const attachment = await this.gateway.upload<ChatUpload>("/api/chat/upload", file, undefined, undefined, {
        cancel: upload.cancel,
        verifyReceipt: verifyChatUpload,
        progress: (progress) => {
          upload.status = uploadProgressText(progress);
          if (!this.disposed && draft === this.draft) this.syncUpload();
        },
      });
      if (upload.cancel.is_cancelled() || this.disposed) {
        draft.uploadNotice = "Загрузка отменена.";
        if (this.disposed) await removePendingUpload(this.gateway, attachment.filename);
        else this.trackRemoval(draft, attachment);
        return;
      }
      draft.attachments.push(attachment);
      if (draft === this.draft) this.draftRevision++;
    } catch (error) {
      draft.uploadNotice = errorText(error);
    } finally {
      draft.upload = undefined;
      if (!this.disposed && draft === this.draft) this.renderDraft();
    }
  }

  private removeAttachment(attachment: ChatUpload): void {
    const draft = this.draft;
    if (draft.pending || !draft.attachments.includes(attachment)) return;
    // Remove the upload from the draft before submitting another message.
    draft.attachments = draft.attachments.filter((item) => item !== attachment);
    this.draftRevision++;
    if (!draft.attachments.some((item) => item.filename === attachment.filename)) this.trackRemoval(draft, attachment);
    this.renderDraft();
  }

  private trackRemoval(draft: Draft, attachment: ChatUpload): void {
    const { filename, display_name: name } = attachment;
    if (draft.removals?.some((entry) => entry.filename === filename)) return;
    const removal: UploadRemoval = { filename, name, state: "unknown", message: "" };
    draft.removals = [removal, ...(draft.removals ?? [])].filter((entry, index) =>
      index < 6 || entry.state === "removing" || entry.state === "unknown");
    void this.removeUpload(draft, removal);
  }

  private async removeUpload(draft: Draft, removal: UploadRemoval): Promise<void> {
    if (this.disposed || removal.state !== "unknown") return;
    removal.state = "removing";
    removal.message = "Удаляю незакреплённую загрузку…";
    if (draft === this.draft) this.renderRemovals();
    Object.assign(removal, await removePendingUpload(this.gateway, removal.filename));
    if (!this.disposed && draft === this.draft) this.renderRemovals();
  }

  private renderRemovals(): void {
    clear(this.uploadRemovals);
    const draft = this.draft;
    for (const removal of draft.removals ?? []) {
      const item = column(4);
      item.append(label([removal.name, removal.message].filter(Boolean).join(" · "), "dim-label"));
      if (removal.state === "unknown") {
        const retry = button("Повторить удаление", () => void this.removeUpload(draft, removal));
        retry.set_tooltip_text(removal.name);
        retry.set_halign(Gtk.Align.START);
        item.append(retry);
      }
      this.uploadRemovals.append(item);
    }
    this.removalPane.set_visible(Boolean(draft.removals?.length));
  }

  private renderDraft(): void {
    clear(this.draftInfo);
    const draft = this.draft;
    if (draft.reply) {
      this.draftInfo.append(button("Ответ · убрать цитату", () => {
        if (draft.pending) return;
        draft.reply = undefined;
        this.draftRevision++;
        this.renderDraft();
      }));
    }
    for (const attachment of draft.attachments) {
      if (attachment.view) this.media.attachment(this.parent, this.draftInfo, attachment.view);
      this.draftInfo.append(button(`Убрать · ${attachment.display_name}`, () => this.removeAttachment(attachment)));
    }
    this.renderRemovals();
    this.draftInfo.set_sensitive(!draft.pending);
    this.syncComposer();
  }

  private syncComposer(): void {
    const draft = this.draft;
    const command = this.commands && !draft.pending && runtimeCommand(draft.text);
    this.composer.set_editable(!draft.pending);
    this.attach.set_sensitive(!draft.pending && !draft.upload);
    this.send.set_label(draft.pending ? "Повторить отправку" : "Отправить");
    chrome(this.send, "label", draft.pending ? "Retry send" : "Send");
    this.send.set_sensitive(command ? (command.startsWith("/panic") ? this.commands!.canPanic() : !draft.commandPending)
      : this.socket.online && !draft.recovering && !draft.sendTimer && !draft.upload && !draft.settingsWaiting
        && Boolean(draft.text.trim() || draft.attachments.length));
    this.panicButton?.set_sensitive(this.commands?.canPanic() === true);
    this.discard.set_visible(Boolean(draft.pending && !draft.recovering && !draft.sendTimer));
    this.draftInfo.set_sensitive(!draft.pending);
    this.syncUpload();
    this.dictation.sync();
  }

  private syncUpload(): void {
    const { upload, uploadNotice } = this.draft;
    const running = Boolean(upload?.name);
    const canceled = upload?.cancel.is_cancelled();
    this.uploadBar.set_visible(running || Boolean(uploadNotice));
    this.cancelUpload.set_visible(running);
    this.cancelUpload.set_sensitive(!canceled);
    this.uploadStatus.set_label(running ? [upload?.name, canceled ? "Отменяю загрузку…" : upload?.status].filter(Boolean).join(" · ")
      : uploadNotice ?? "");
  }

  private submit(): void {
    if (this.disposed) return;
    const draft = this.draft;
    const command = this.commands && !draft.pending && runtimeCommand(draft.text);
    if (command) {
      if (!command.startsWith("/panic") && (draft.attachments.length || draft.upload)) {
        this.sendStatus.set_label("Команды управления не принимают вложения. Уберите файлы или отправьте их отдельным сообщением.");
        chrome(this.sendStatus, "label", "Control commands do not accept attachments. Remove the files or send them in a separate message.");
        return;
      }
      if (!draft.commandPending || command.startsWith("/panic")) void this.submitCommand(draft, command);
      return;
    }
    if (draft.recovering || draft.sendTimer || draft.upload || draft.settingsWaiting || !this.socket.online
      || (!draft.text.trim() && !draft.attachments.length)) return;
    const saving = this.roomCognition?.pending(cognitionScope(this.room));
    if (saving) {
      const view = this.view, revision = this.draftRevision, pending = draft.pending;
      draft.settingsWaiting = true;
      this.sendStatus.set_label("Жду подтверждения настроек комнаты…");
      this.syncComposer();
      void saving.then((result) => {
        draft.settingsWaiting = false;
        if (this.disposed || draft !== this.draft) return;
        this.syncComposer();
        if (view !== this.view) {
          this.sendStatus.set_label("Сообщение осталось в черновике.");
          return;
        }
        if (!result.ok) {
          this.sendStatus.set_label("Сообщение осталось в черновике. " + result.message);
        } else if (revision !== this.draftRevision || pending !== draft.pending) {
          this.sendStatus.set_label("Черновик изменился. Нажмите «Отправить» снова.");
        } else if (!this.socket.online) {
          this.sendStatus.set_label("Настройки сохранены. Дождитесь подключения и нажмите «Отправить» снова.");
        } else {
          this.sendStatus.set_label("");
          this.submit();
        }
      });
      return;
    }
    const pending: ChatSend = draft.pending ?? {
      type: "chat",
      sender_session_id: nativeSenderSessionId,
      client_surface: nativeClientSurface(this.widget),
      content: draft.text.trim(),
      chat_id: this.room.chatId,
      project_id: this.room.projectId,
      client_message_id: GLib.uuid_string_random(),
      reply_to: draft.reply,
      attachments: draft.attachments.map(({ filename, display_name, mime }) => ({ filename, display_name, mime })),
    };
    try { this.ingress.track(pending); }
    catch (error) {
      this.sendStatus.set_label(`Не удалось сохранить отправку для повтора. ${errorText(error)}`);
      return;
    }
    draft.pending = pending;
    draft.receipt = undefined;
    if (!this.socket.send(pending)) {
      this.allowRetry("Связь прервалась. Можно повторить тот же запрос.", draft);
      return;
    }
    this.sendStatus.set_label("Ожидание подтверждения шлюза…");
    draft.sendTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
      draft.sendTimer = 0;
      if (draft === this.draft && draft.pending) {
        this.sendStatus.set_label("Подтверждение не пришло. Можно повторить то же сообщение.");
        this.syncComposer();
      }
      this.refresh();
      return GLib.SOURCE_REMOVE;
    });
    this.syncComposer();
  }

  private stopPageModules(): void {
    void stopHostModules(this.gateway);
    this.dictation.cancel(); this.readAloud.stop();
    this.status.set_label("Модули навыков остановлены на этом клиенте.");
  }

  private async stopGateway(): Promise<void> {
    if (this.disposed) return;
    this.stopPageModules();
    const pending = this.commands!.send("/panic", undefined, { cancel: this.commandCancel });
    this.syncComposer();
    const result = await pending;
    if (this.disposed) return;
    if (result.message) this.sendStatus.set_label(result.message);
    this.syncComposer();
  }

  private async submitCommand(draft: Draft, command: string): Promise<void> {
    if (command.split(/\s+/, 1)[0] === "/panic") this.stopPageModules();
    const original = draft.text, replyTo = draft.reply;
    draft.commandPending = (draft.commandPending ?? 0) + 1;
    const pending = this.commands!.send(command, undefined, { replyTo, cancel: this.commandCancel });
    this.syncComposer();
    const result = await pending;
    draft.commandPending--;
    if (this.disposed) return;
    if (result.accepted && draft.text === original && !draft.pending) {
      draft.text = "";
      if (!command.startsWith("/panic") && draft.reply === replyTo) draft.reply = undefined;
      if (draft === this.draft) { this.composer.set_text(""); this.renderDraft(); }
    }
    if (draft === this.draft) {
      if (result.message) this.sendStatus.set_label(result.message);
      this.syncComposer();
    }
    if (result.accepted && !command.startsWith("/panic")) this.refresh();
  }

  private clearSendTimer(draft: Draft): void {
    if (draft.sendTimer) GLib.Source.remove(draft.sendTimer);
    draft.sendTimer = 0;
  }

  private allowRetry(message: string, only?: Draft): void {
    for (const draft of only ? [only] : this.drafts.values()) this.clearSendTimer(draft);
    if (this.draft.pending && !this.draft.recovering && (!only || only === this.draft)) this.sendStatus.set_label(message);
    this.syncComposer();
  }

  private clearDraft(draft: Draft): void {
    this.clearSendTimer(draft);
    draft.pending = undefined;
    draft.recovering = false;
    draft.text = "";
    draft.reply = undefined;
    draft.attachments = [];
    if (draft !== this.draft) return;
    this.composer.set_text("");
    this.renderDraft();
  }

  private discardPending(): void {
    const draft = this.draft;
    if (!draft.pending || draft.recovering || draft.sendTimer) return;
    try { this.ingress.forget(draft.pending); }
    catch (error) {
      this.sendStatus.set_label(errorText(error));
      return;
    }
    this.clearDraft(draft);
    this.sendStatus.set_label("Повтор отменён. Результат исходной отправки может появиться в истории.");
  }
}
