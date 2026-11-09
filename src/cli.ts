import { ApiClient } from "./api.js";
import { WsChat } from "./ws.js";

/**
 * Дым без GUI: те же вызовы, что делает GTK-экран.
 *   node dist/cli.js check            — health + state
 *   node dist/cli.js chat "текст"     — отправить в Main и напечатать 3 ответа
 *   node dist/cli.js task "сделай X"  — создать задачу и показать id
 */
async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const api = new ApiClient();

  if (cmd === "check" || !cmd) {
    const health = (await api.health()) as { boot?: { phase: string } };
    console.log("health ok, boot:", JSON.stringify(health).slice(0, 200));
    const state = await api.state();
    console.log(
      `supervisor_ready=${state.supervisor_ready} workers_alive=${state.workers_alive}`,
    );
    const history = await api.chatHistory(1, 1);
    console.log(`history messages: ${history.messages?.length ?? 0}`);
    return;
  }

  if (cmd === "task") {
    const description = rest.join(" ") || "проверка связи из ts-клиента";
    const res = await api.createTask({ description, title: "ts-client check" });
    console.log("task:", JSON.stringify(res));
    return;
  }

  if (cmd === "chat") {
    const text = rest.join(" ") || "привет";
    await new Promise<void>((resolve, reject) => {
      const ws = new WsChat(undefined, (msg) => {
        if (msg["type"] === "chat") {
          console.log(`[${msg["role"]}] ${String(msg["content"]).slice(0, 300)}`);
        }
      });
      ws.connect();
      const t = setTimeout(() => {
        ws.close();
        resolve();
      }, 15000);
      t.unref?.();
      setTimeout(() => {
        try {
          ws.send(text, 1);
        } catch (e) {
          clearTimeout(t);
          reject(e);
        }
      }, 500);
    });
    return;
  }

  console.error("unknown command: check | chat <text> | task <text>");
  process.exitCode = 2;
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
