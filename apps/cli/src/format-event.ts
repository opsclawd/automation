import type { OrchestratorEvent } from '@ai-sdlc/shared';

export function formatEvent(event: OrchestratorEvent): string {
  const tsMatch = event.timestamp.match(/T(\d{2}:\d{2}:\d{2})/);
  const ts = tsMatch ? tsMatch[1] : event.timestamp.slice(0, 19);
  const meta =
    event.metadata && Object.keys(event.metadata).length > 0
      ? ' ' +
        Object.entries(event.metadata)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')
      : '';
  return `[${ts}] [${event.type}] ${event.message}${meta}\n`;
}
