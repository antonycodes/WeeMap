export type BuildInfo = {
  builtAt: number;
  commitSha: string | null;
};

export type LatestCommit = {
  committedAt: number;
  sha: string;
};

export function hasNewerCommit(buildInfo: BuildInfo, latestCommit: LatestCommit): boolean {
  return buildInfo.commitSha ? buildInfo.commitSha !== latestCommit.sha : latestCommit.committedAt > buildInfo.builtAt;
}

export async function getLatestCommit(signal?: AbortSignal): Promise<LatestCommit> {
  const response = await fetch('https://api.github.com/repos/antonycodes/WeeMap/commits/main', {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('commit-check');

  const data = (await response.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
  if (!data.sha || !data.commit?.committer?.date) throw new Error('commit-data');
  return { sha: data.sha, committedAt: Date.parse(data.commit.committer.date) };
}