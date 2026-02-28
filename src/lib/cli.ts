const getArgValue = (args: string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
};

export const parseList = (value: string | undefined, fallback: string[]): string[] => {
  const raw = value?.trim();
  if (!raw) return fallback;

  return Array.from(
    new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
};

export const parseIntList = (value: string | undefined, fallback: number[]): number[] => {
  const parsed = parseList(value, fallback.map(String))
    .map((item) => Number(item))
    .filter((n) => Number.isInteger(n) && n > 0);

  return Array.from(new Set(parsed));
};

export const parseString = (
  args: string[],
  name: string,
  fallback: string,
): string => {
  return getArgValue(args, name) ?? fallback;
};

export const parseNumber = (args: string[], name: string, fallback: number): number => {
  const raw = getArgValue(args, name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const parseCSVArg = (args: string[], name: string): string | undefined => {
  return getArgValue(args, name);
};
