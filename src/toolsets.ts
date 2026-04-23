export type Toolset = 'messaging' | 'bitable' | 'docs' | 'calendar' | 'other';

const ALL: Toolset[] = ['messaging', 'bitable', 'docs', 'calendar', 'other'];

export function enabledToolsets(raw: string | undefined): Set<Toolset> {
  if (!raw || !raw.trim()) {
    // Default: all 4 named toolsets enabled ("other" is always enabled — catches self-check etc.)
    return new Set(['messaging', 'bitable', 'docs', 'calendar', 'other']);
  }
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const enabled = new Set<Toolset>(['other']); // other is always on
  for (const p of parts) {
    if ((ALL as string[]).includes(p)) enabled.add(p as Toolset);
  }
  return enabled;
}
