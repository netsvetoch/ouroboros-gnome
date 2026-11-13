import { CallMark } from "./gjs/call-mark.js";
import { type CallRoom, type CallView } from "./gjs/call-session.js";
import { GatewayNotices } from "./gjs/gateway-notices.js";
import { ActivityPage } from "./gjs/activity.js";
import { ChatPage, type Room } from "./gjs/chat.js";
import { showConnectionSettings as openSettings, type GatewaySettings, defaultGatewayBase as defaultBase, readConnectionSettings, writeConnectionSettings } from "./gjs/connection-settings.js";
import { FilesPage } from "./gjs/files.js";
import { Gateway } from "./gjs/gateway.js";
import { Adw, Gio, GLib, Gtk } from "./gjs/gi.js";
import { Projects } from "./gjs/projects.js";
import { Navigation } from "./gjs/navigation.js";
import { ProjectPanel } from "./gjs/project-panel.js";
import { ChatIngress } from "./gjs/chat-ingress.js";
import { NativeI18n, chrome, useNativeI18n } from "./gjs/native-i18n.js";
import { RoomReads } from "./gjs/room-reads.js";
import { RoomCognition } from "./gjs/room-cognition.js";
import { WorkState } from "./gjs/work-state.js";
import { OwnerQuestions } from "./gjs/owner-questions.js";
import { type ModelWait, OwnerAttention } from "./gjs/owner-attention.js";
import { SchedulesPage } from "./gjs/schedules.js";
import { ServerSettings } from "./gjs/settings.js";
import { TasksPage } from "./gjs/tasks.js";
import { alert, button, column, errorText, label } from "./gjs/ui.js";
import { WidgetsPage } from "./gjs/widgets.js";
import { stopWidgetSandboxes } from "./gjs/widget-sandbox.js";

function settingsPath(): string {
  return GLib.build_filenamev([GLib.get_user_config_dir(), "ouroboros-client", "settings.ini"]);
}

function loadSettings(): GatewaySettings {
  const fallback = {
    baseUrl: GLib.getenv("OUROBOROS_URL") ?? defaultBase,
    password: GLib.getenv("OUROBOROS_NETWORK_PASSWORD") ?? "",
    chatId: 1,
  };
  return readConnectionSettings(settingsPath(), fallback);
}

function saveSettings(settings: GatewaySettings): void {
  writeConnectionSettings(settingsPath(), settings);
}


async function main(argv: string[]): Promise<number> {
  const app = new Adw.Application({ application_id: "io.github.ouroboros.Client" });
  app.connect("activate", () => {
    if (app.active_window) {
      app.active_window.present();
      return;
    }
    const win = new Adw.ApplicationWindow({ application: app, title: "Ouroboros", default_width: 960, default_height: 680 });
    const toolbar = new Adw.ToolbarView();
    const toastOverlay = new Adw.ToastOverlay({ child: toolbar });
    const header = new Adw.HeaderBar();
    let settings = loadSettings();
    let gateway: Gateway | undefined;
    let chat: ChatPage | undefined;
    let projects: Projects | undefined;
    let navigation: Navigation | undefined;
    let projectPanel: ProjectPanel | undefined;
    let nativeI18n: NativeI18n | undefined;
    let notices: GatewayNotices | undefined;
    let roomReads: RoomReads | undefined;
    let roomCognition: RoomCognition | undefined;
    let workState: WorkState | undefined;
    let tasks: TasksPage | undefined;
    let files: FilesPage | undefined;
    let schedules: SchedulesPage | undefined;
    let activity: ActivityPage | undefined;
    let widgets: WidgetsPage | undefined;
    let serverSettings: ServerSettings | undefined;
    let currentView = "chat";
    let closingWindow = false;
    let showCall: ((key: string, room: CallRoom) => void) | undefined;
    let endCall: ((key: string) => void) | undefined;
    const settingsButton = new Gtk.Button({ icon_name: "emblem-system-symbolic", tooltip_text: "Настройки подключения" });
    const serverSettingsButton = new Gtk.Button({ icon_name: "preferences-system-symbolic", tooltip_text: "Настройки шлюза" });
    const refreshButton = new Gtk.Button({ icon_name: "view-refresh-symbolic", tooltip_text: "Обновить" });
    const logoutButton = new Gtk.Button({ icon_name: "system-log-out-symbolic", tooltip_text: "Завершить сетевой сеанс", visible: false });
    const callMark = new CallMark((key, room) => showCall?.(key, room), key => endCall?.(key));
    const navigationButton = new Gtk.Button({ icon_name: "open-menu-symbolic", tooltip_text: "Навигация", visible: false });
    navigationButton.connect("clicked", () => navigation?.toggle());
    settingsButton.connect("clicked", () => openSettings(win, settings, gateway, (updated, session) => {
      settings = updated;
      connect(session);
    }, saveSettings));
    logoutButton.connect("clicked", () => {
      const session = gateway;
      if (!session?.hasSession) return;
      logoutButton.set_sensitive(false);
      settingsButton.set_sensitive(false);
      void session.logout().catch((error) => {
        if (gateway === session && !closingWindow) alert(win, "Локальный сеанс завершён", errorText(error));
      }).finally(() => {
        if (gateway !== session || closingWindow) return;
        connect();
        settingsButton.set_sensitive(true);
      });
    });
    serverSettingsButton.connect("clicked", () => serverSettings?.show());
    refreshButton.connect("clicked", () => {
      navigation?.refresh();
      projectPanel?.refresh();
      if (currentView === "files") { void files?.refresh(); return; }
      if (currentView === "schedules") { void schedules?.refresh(); return; }
      if (currentView === "activity") { void activity?.refresh(); return; }
      if (currentView === "widgets") { void widgets?.refresh(); return; }
      void projects?.refresh();
      chat?.refresh();
      void tasks?.refresh();
    });
    header.pack_end(settingsButton);
    header.pack_end(logoutButton);
    header.pack_end(serverSettingsButton);
    header.pack_end(refreshButton);
    header.pack_start(callMark.widget);
    header.pack_start(navigationButton);
    toolbar.add_top_bar(header);
    win.set_content(toastOverlay);

    function disconnect(): Promise<unknown> | undefined {
      const previous = gateway;
      gateway = undefined;
      notices?.close();notices = undefined;
      nativeI18n?.close();
      nativeI18n = undefined;
      navigation?.close();
      navigation = undefined;
      navigationButton.set_visible(false);
      files?.close();
      schedules?.close();
      activity?.close();
      widgets?.close();
      serverSettings?.close();
      serverSettingsButton.set_sensitive(false);
      currentView = "chat";
      tasks?.close();
      projects?.close();
      roomReads?.close();
      roomReads = undefined;
      roomCognition?.close();
      roomCognition = undefined;
      workState?.close();
      workState = undefined;
      const callDrain = chat?.close();
      const projectDrain = projectPanel?.close();
      projectPanel = undefined;
      chat = undefined;
      showCall = undefined;
      endCall = undefined;
      callMark.clear();
      const widgetDrain = previous && stopWidgetSandboxes(previous);
      const drains = [callDrain, projectDrain, widgetDrain].filter((drain) => drain !== undefined);
      const draining = drains.length ? Promise.all(drains) : undefined;
      if (draining) void draining.finally(() => previous?.close());
      else previous?.close();
      return draining;
    }

    function connect(session?: Gateway): void {
      disconnect();
      const content = column();
      content.set_margin_top(12);
      content.set_margin_bottom(12);
      content.set_margin_start(12);
      content.set_margin_end(12);
      toolbar.set_content(content);
      try {
        gateway = session ?? new Gateway(settings.baseUrl, settings.password);
        const currentGateway = gateway;
        const currentI18n = new NativeI18n(currentGateway);
        nativeI18n = currentI18n;
        useNativeI18n(currentI18n);
        for (const [widget, source] of [[settingsButton, "Connection settings"], [serverSettingsButton, "Gateway settings"],
          [refreshButton, "Refresh"], [logoutButton, "End network session"], [callMark.open, "Open current call"],
          [navigationButton, "Navigation"]] as const) chrome(widget, "tooltip-text", source);
        logoutButton.set_visible(gateway.hasSession);
        logoutButton.set_sensitive(gateway.hasSession);
        serverSettingsButton.set_sensitive(true);
        let currentRoom: Room = { name: settings.chatId === 1 ? "Main" : `Чат ${settings.chatId}`, chatId: settings.chatId };
        const stack = new Adw.ViewStack({ vexpand: true });
        const currentIngress = new ChatIngress(gateway.base);
        let navigationBlocked = false;
        let roomNavigation = 0;
        const noteCall = (key: string, view: CallView) => {
          if (gateway === currentGateway) callMark.update(key, view);
        };
        const currentCognition = new RoomCognition(gateway);
        roomCognition = currentCognition;
        const currentWork = new WorkState(gateway);
        workState = currentWork;
        const currentQuestions = new OwnerQuestions(gateway, win, () => {
          activeChat().refresh();
          currentReads.refresh();
        });
        const currentAttention = new OwnerAttention(gateway, currentWork.actions, () => currentReads.refresh());
        const openSettings = () => serverSettings?.show();
        const currentReads = new RoomReads(gateway, () => {
          currentProjects.readStateChanged();
          currentChat.readAvailabilityChanged();
          currentPanel.chat?.readAvailabilityChanged();
        }, (snapshot, readAt) => {
          if (snapshot) currentChat.observeProjectBindings(snapshot, readAt);
          if (snapshot) currentPanel.chat?.observeProjectBindings(snapshot, readAt);
          currentChat.observeContinuations(snapshot);
          currentPanel.chat?.observeContinuations(snapshot);
          currentCognition.observeState(snapshot, readAt);
          currentWork.observe(snapshot, readAt);
          currentQuestions.observe(snapshot, readAt);
          currentAttention.observe(snapshot, readAt);
        });
        roomReads = currentReads;
        const openTaskHistory = (id: string, projectId?: string, chatId?: number) => {
          stack.set_visible_child_name("chat");
          activeChat().openTaskHistory(id, projectId, chatId);
        };
        const currentTasks = new TasksPage(win, gateway, () => currentRoom, (task, target) => {
          currentChat.projectBound(task, target);
          currentPanel.chat?.projectBound(task, target);
          currentTasks.roomChanged();
          currentReads.refresh();
          void currentProjects.refresh();
        }, openTaskHistory, currentWork, currentAttention, openSettings, (target) => {
          stack.set_visible_child_name("chat");
          void activeChat().openProject(target.id, target.chatId);
        }, (task) => currentChat.projectForTask(task), (task) => {
          currentChat.continuationChanged(task);
          currentPanel.chat?.continuationChanged(task);
        });
        tasks = currentTasks;
        const currentNotices = new GatewayNotices(win, toastOverlay, id => currentTasks.show(id));
        notices = currentNotices;
        const currentActivity = new ActivityPage(win, gateway, (id) => currentTasks.show(id), () => currentChat.requestPanic(),
          currentWork, currentQuestions, currentAttention, openSettings,
          (id, chatId) => openTaskHistory(id, undefined, chatId), (chatId) => serverSettings?.openWakeRoom(chatId));
        activity = currentActivity;
        const currentWidgets: WidgetsPage = new WidgetsPage(win, gateway, (tab) => activeChat().showPinnedWidget(tab));
        widgets = currentWidgets;
        const currentChat: ChatPage = new ChatPage(win, gateway, { chatId: 1, name: "Main" }, (frame) => {
          currentNotices.frame(frame);
          currentI18n.frame(frame);
          if (frame.type === "projects_changed") void projects?.refresh();
          const event = (frame.type === "log" ? frame.data : frame) as (Partial<ModelWait> &
            { type?: string; task_id?: string; predecessor_task_id?: string; _historical?: boolean }) | undefined;
          if (event?.type === "task_model_wait" && !event._historical && event.task_id) {
            currentAttention.frame(event.task_id, event as ModelWait);
            currentReads.refresh();
          }
          if (event?.type === "owner_continue_admitted" && !event._historical) {
            currentTasks.continuationChanged(event.predecessor_task_id);
            currentReads.refresh();
          }
          if (["chat", "photo", "video", "document", "links", "quiz", "quiz_state", "typing", "task_done",
            "projects_changed"].includes(frame.type)) currentReads.refresh();
          currentActivity.onFrame(frame);
          currentWidgets.frame(frame);
          serverSettings?.frame(frame);
        }, (id) => currentTasks.show(id), currentActivity.commands, () => {
          currentActivity.reconnected();
          currentWidgets.frame({ type: "extension_lifecycle" });
          currentReads.refresh();
          serverSettings?.reconnected();
          currentI18n.reconnect();
        },
        (_active, view) => noteCall("main", view), (name) => serverSettings?.openSkills(name), (skill) => {
          stack.set_visible_child_name("widgets");
          currentWidgets.focusSkill(skill);
        }, (room) => {
          currentRoom = room;
          currentTasks.roomChanged();
          currentProjects.selectHistoryRoom(room);
        }, currentReads, currentCognition, currentWork, currentQuestions, currentAttention, openSettings,
        { ingress: currentIngress, hostRoom, beginNavigation });
        chat = currentChat;
        const currentPanel: ProjectPanel = new ProjectPanel(win, gateway, (room) => {
          const page = new ChatPage(win, currentGateway, room, () => {}, (id) => currentTasks.show(id), currentActivity.commands,
            () => currentReads.refresh(), (_active, view) => noteCall("project", view),
            (name) => serverSettings?.openSkills(name), (skill) => {
              currentPanel.hide();
              stack.set_visible_child_name("widgets");
              currentWidgets.focusSkill(skill);
            }, selectRoom, currentReads, currentCognition, currentWork, currentQuestions, currentAttention, openSettings,
            { ingress: currentIngress, ownsSharedControllers: false, managesConnection: false, hostRoom, beginNavigation });
          page.setReadingBlocked(navigationBlocked);
          return page;
        }, () => { beginNavigation(); selectRoom(currentChat.currentRoom); currentChat.refresh(); });
        projectPanel = currentPanel;
        function activeChat(): ChatPage { return currentPanel.active ? currentPanel.chat ?? currentChat : currentChat; }
        function beginNavigation(): () => boolean {
          const revision = ++roomNavigation;
          currentChat.cancelNavigation();
          currentPanel.chat?.cancelNavigation();
          return () => revision === roomNavigation;
        }
        function selectRoom(room: Room): void {
          currentRoom = room;
          currentTasks.roomChanged();
          currentProjects.selectHistoryRoom(room);
        }
        function hostRoom(room: Room): ChatPage {
          beginNavigation();
          stack.set_visible_child_name("chat");
          let page: ChatPage;
          if (room.projectId) {
            currentChat.leaveQuestions();
            page = currentPanel.open(room);
          } else {
            if (currentPanel.active) currentPanel.hide();
            currentChat.setRoom(room);
            page = currentChat;
          }
          selectRoom(room);
          return page;
        }
        serverSettings = new ServerSettings(win, gateway, (id) => currentTasks.show(id), () => activeChat().refresh(),
          async () => (await currentActivity.commands.send("/restart")).message, currentCognition,
          (parent) => activeChat().showCallSettings(parent));
        const currentProjects = new Projects(win, gateway, settings.chatId, (room) => {
          hostRoom(room);
        }, currentReads);
        projects = currentProjects;
        showCall = (_key, room) => { hostRoom(room); };
        endCall = key => {
          if (key === "project") currentPanel.chat?.endCall();
          else currentChat.endCall();
        };
        const currentFiles = new FilesPage(win, gateway);
        files = currentFiles;
        const currentSchedules = new SchedulesPage(win, gateway, () => currentRoom,
          () => currentProjects.projectRooms(), (id) => currentTasks.show(id));
        schedules = currentSchedules;
        chrome(stack.add_titled_with_icon(currentChat.widget, "chat", "Чат", "mail-message-new-symbolic"), "title", "Chat");
        chrome(stack.add_titled_with_icon(currentTasks.widget, "tasks", "Задачи", "view-list-symbolic"), "title", "Tasks");
        chrome(stack.add_titled_with_icon(currentFiles.widget, "files", "Файлы", "folder-symbolic"), "title", "Files");
        chrome(stack.add_titled_with_icon(currentSchedules.widget, "schedules", "Расписания", "x-office-calendar-symbolic"), "title", "Schedules");
        chrome(stack.add_titled_with_icon(currentActivity.widget, "activity", "Активность", "utilities-system-monitor-symbolic"), "title", "Activity");
        chrome(stack.add_titled_with_icon(currentWidgets.widget, "widgets", "Виджеты", "view-grid-symbolic"), "title", "Widgets");
        stack.connect("notify::visible-child-name", () => {
          const view = stack.get_visible_child_name();
          if (currentView === "chat" && view !== "chat") currentChat.leaveQuestions();
          currentView = view ?? "chat";
          currentProjects.widget.set_visible(view === "chat" || view === "tasks");
          currentSchedules.setActive(view === "schedules");
          currentActivity.setActive(view === "activity");
          currentWidgets.setActive(view === "widgets");
          currentTasks.setActive(view === "tasks");
          if (view === "files") void currentFiles.refresh();
        });
        header.set_title_widget(null);
        content.append(currentProjects.widget);
        content.append(stack);
        toolbar.set_content(null);
        navigation = new Navigation(gateway, stack, content, (blocked) => {
          navigationBlocked = blocked;
          currentChat.setReadingBlocked(blocked);
          currentPanel.chat?.setReadingBlocked(blocked);
        });
        toolbar.set_content(navigation.widget);
        navigationButton.set_visible(true);
        serverSettings.checkSetup();
      } catch (error) {
        header.set_title_widget(null);
        content.append(label(errorText(error)));
        alert(win, "Ошибка подключения", errorText(error));
      }
    }

    win.connect("close-request", () => {
      if (closingWindow) return true;
      const draining = disconnect();
      if (!draining) return false;
      closingWindow = true;
      void draining.finally(() => {
        closingWindow = false;
        win.close();
      });
      return true;
    });
    win.present();
    connect();
  });
  return await app.runAsync(argv);
}

await main((globalThis as any).ARGV);
