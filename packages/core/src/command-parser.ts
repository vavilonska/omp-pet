export interface ParsedPetCommand {
  name: string;
  args: string[];
}

export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  const source = input.trim();

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const next = source[index + 1];
      const escapesSyntax = next === "\\" || next === quote || (!quote && !!next && /\s/.test(next));
      if (escapesSyntax && next) {
        current += next;
        index += 1;
      } else {
        current += "\\";
      }
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) throw new Error("Unclosed quote in /pet command");
  if (current) tokens.push(current);
  return tokens;
}

export function parsePetCommand(input: string): ParsedPetCommand {
  const [name = "show", ...args] = tokenizeCommandLine(input);
  return { name: name.toLowerCase(), args };
}
