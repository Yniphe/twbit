export interface IrcMessage {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
  text: string;
}

const TAG_ESCAPES: Record<string, string> = { s: " ", ":": ";", r: "\r", n: "\n", "\\": "\\" };

export class IrcParser {
  private buffer = "";

  feed(data: string): IrcMessage[] {
    const lines = (this.buffer + data).split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    return lines.filter(Boolean).map((line) => this.parseLine(line));
  }

  private parseLine(line: string): IrcMessage {
    let rest = line;
    const tags: Record<string, string> = {};
    if (rest.startsWith("@")) {
      const end = rest.indexOf(" ");
      if (end < 0) throw new Error("Некорректные IRC-теги");
      for (const tag of rest.slice(1, end).split(";")) {
        const equals = tag.indexOf("=");
        const key = equals < 0 ? tag : tag.slice(0, equals);
        const value = equals < 0 ? "" : tag.slice(equals + 1);
        tags[key] = value.replace(/\\(.)/g, (_, char: string) => TAG_ESCAPES[char] ?? char);
      }
      rest = rest.slice(end + 1);
    }
    let prefix = "";
    if (rest.startsWith(":")) {
      const end = rest.indexOf(" ");
      if (end < 0) throw new Error("Некорректный IRC-префикс");
      prefix = rest.slice(1, end);
      rest = rest.slice(end + 1);
    }
    const trailing = rest.indexOf(" :");
    const [command = "", ...params] = (trailing < 0 ? rest : rest.slice(0, trailing)).split(" ");
    return { tags, prefix, command, params, text: trailing < 0 ? "" : rest.slice(trailing + 2) };
  }
}
