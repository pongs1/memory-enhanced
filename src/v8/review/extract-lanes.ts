export interface ExtractLaneJob {
    jobId: string;
    narrativeRecordId: string;
    layer?: string | null;
    promptUnits?: Array<{ ordinal?: number | null }>;
}

function jobOrdinal(job: ExtractLaneJob): number {
    return Number(job.promptUnits?.[0]?.ordinal ?? 0);
}

function sortJobs<T extends ExtractLaneJob>(jobs: T[]): T[] {
    return jobs
        .slice()
        .sort(
            (a, b) =>
                a.narrativeRecordId.localeCompare(b.narrativeRecordId) ||
                String(a.layer || "").localeCompare(String(b.layer || "")) ||
                jobOrdinal(a) - jobOrdinal(b) ||
                String(a.jobId).localeCompare(String(b.jobId))
        );
}

export function partitionSerialExtractLanes<T extends ExtractLaneJob>(
    jobs: T[],
    _laneCount: number
): T[][] {
    if (jobs.length === 0) return [];

    const byNarrative = new Map<string, T[]>();
    for (const job of sortJobs(jobs)) {
        const key = `${job.narrativeRecordId}::${String(job.layer || "")}`;
        const list = byNarrative.get(key) || [];
        list.push(job);
        byNarrative.set(key, list);
    }

    const lanes: T[][] = [];
    for (const group of byNarrative.values()) {
        lanes.push(group);
    }
    return lanes;
}
