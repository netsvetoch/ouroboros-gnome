import { type Gateway, HttpError } from "./gateway.js";
import { object } from "./settings-write.js";
import { errorText } from "./ui.js";

type Result = { state: "deleted" | "missing" | "kept" | "refused" | "unknown"; message: string };

export async function removePendingUpload(gateway: Gateway, filename: string): Promise<Result> {
  try {
    const receipt = object(await gateway.json("DELETE", "/api/chat/upload", { filename }));
    if (receipt.ok === true && receipt.filename === filename) return { state: "deleted", message: "Удалён на шлюзе." };
    return { state: "unknown", message: "Шлюз не подтвердил удаление этого файла." };
  } catch (error) {
    if (error instanceof HttpError) {
      const body = object(error.body);
      if (body.ok === false && error.status === 404) return { state: "missing", message: "Шлюз сообщил, что файла уже нет." };
      if (body.ok === false && error.status === 409) return { state: "kept", message: "Шлюз сохранил файл. Он больше не числится в незакреплённых загрузках." };
      if ([400, 401, 403].includes(error.status)) return { state: "refused", message: `Шлюз отклонил удаление. ${errorText(error)}` };
    }
    return { state: "unknown", message: `Результат удаления неизвестен. ${errorText(error)}` };
  }
}

export interface UploadRemoval {
  filename: string;
  name: string;
  state: "removing" | Result["state"];
  message: string;
}
