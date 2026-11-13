import { detectCodeLanguage } from "./vendor/code-detector.js";

export const codeHighlightLimit = 32768;
const aliases: Record<string, string> = {
  javascript: "js", node: "js", nodejs: "js", mjs: "js", cjs: "js",
  ts: "typescript", tsx: "typescript-jsx", javascriptreact: "jsx", typescriptreact: "typescript-jsx", py: "python3", python: "python3", "python-repl": "python3",
  bash: "sh", zsh: "sh", ksh: "sh", shell: "sh", "shell-session": "sh", console: "sh",
  "c++": "cpp", cc: "cpp", cxx: "cpp", "c#": "c-sharp", cs: "c-sharp", csharp: "c-sharp",
  yml: "yaml", md: "markdown", dockerfile: "docker", objc: "objc", "objective-c": "objc", objectivec: "objc",
  rs: "rust", rb: "ruby", golang: "go", html: "html", markup: "html", vue: "html",
};
const plain = new Set(["text", "txt", "plaintext", "plain", "none"]);

export function selectCodeLanguage(source: string, hint: string | undefined, available: (id: string) => boolean,
  guess: (hint: string) => string | undefined = () => undefined): string | undefined {
  if (source.length > codeHighlightLimit) return undefined;
  const name = hint?.trim().split(/\s+/u)[0].toLowerCase().replace(/^language-/u, "") ?? "";
  if (plain.has(name)) return undefined;
  if (name) {
    const id = aliases[name] ?? name;
    if (available(id)) return id;
    const guessed = guess(name);
    if (guessed && available(guessed)) return guessed;
  }
  try {
    const detected = detectCodeLanguage(source);
    if (!detected) return undefined;
    const id = aliases[detected] ?? detected;
    return available(id) ? id : undefined;
  } catch { return undefined; }
}
