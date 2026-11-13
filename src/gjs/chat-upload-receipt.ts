import { type ChatAttachment } from "./chat-media.js";
import { type DownloadIdentity, UploadReceiptError } from "./gateway.js";

export interface ChatUpload {
  ok?: boolean;
  filename: string;
  display_name: string;
  mime: string;
  size?: number;
  sha256?: string;
  view?: ChatAttachment;
}

export function verifyChatUpload(receipt: ChatUpload, sent: DownloadIdentity): void {
  if (receipt?.ok !== true || typeof receipt.filename !== "string" || !receipt.filename
    || receipt.filename !== receipt.filename.trim() || /[\\/\x00-\x1f\x7f]/u.test(receipt.filename)
    || [".", ".."].includes(receipt.filename) || typeof receipt.display_name !== "string" || typeof receipt.mime !== "string") {
    throw new UploadReceiptError("В квитанции нет пригодного имени загрузки.");
  }
  if (receipt.size !== sent.size || (receipt.sha256 !== undefined && receipt.sha256 !== sent.sha256)) {
    throw new UploadReceiptError("Размер или SHA‑256 в квитанции не совпали с отправленным файлом.");
  }
  if (receipt.view?.url !== undefined) {
    const url = receipt.view.url;
    const upload = typeof url === "string" ? /^\/api\/files\/download\?upload=([^&#]+)$/u.exec(url)?.[1] : undefined;
    let name = "";
    try { if (upload) name = decodeURIComponent(upload); } catch { /* A malformed URL cannot name this upload. */ }
    if (name !== receipt.filename) throw new UploadReceiptError("Ссылка в квитанции относится к другой загрузке.");
  }
}
