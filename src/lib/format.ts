const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  day: "numeric",
  month: "short",
});

/** Formats an RDP UTC timestamp for UK readers, keeping the original string for `<time dateTime>`. */
export function formatTime(timestamp: string): string {
  return time.format(new Date(Date.parse(timestamp.replace(/(\.\d{3})\d+Z$/, "$1Z"))));
}

export function formatNumber(value: number, unit: string): string {
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 }).format(value)} ${unit}`;
}

export function formatPeriod(seconds: number): string {
  return seconds % 3600 === 0
    ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`
    : `${seconds / 60} minutes`;
}

export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const list = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" });

/** "a", "a and b", "a, b and c". */
export function listJoin(items: readonly string[]): string {
  return list.format(items);
}
