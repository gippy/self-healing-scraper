import type { PipelineEvent } from '../types.ts';

// In-memory store of recent pipeline events, with listeners for the SSE stream.

export type Listener = (event: PipelineEvent) => void;

export class EventStore {
    #events: PipelineEvent[] = [];
    #listeners = new Set<Listener>();
    readonly limit: number;

    constructor(limit = 2_000) {
        this.limit = limit;
    }

    push(event: PipelineEvent): void {
        this.#events.push(event);
        if (this.#events.length > this.limit) this.#events.splice(0, this.#events.length - this.limit);
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch (error) {
                console.warn('[store] listener failed:', (error as Error).message);
            }
        }
    }

    recent(): PipelineEvent[] {
        return [...this.#events];
    }

    forIssue(issueId: string): PipelineEvent[] {
        return this.#events.filter((e) => e.issueId === issueId);
    }

    // Issue IDs, newest first by their first event.
    issueIds(): string[] {
        const firstSeen = new Map<string, number>();
        this.#events.forEach((e, i) => {
            if (!firstSeen.has(e.issueId)) firstSeen.set(e.issueId, i);
        });
        // A rerun (new `received`) moves the issue to the top.
        this.#events.forEach((e, i) => {
            if (e.stage === 'received') firstSeen.set(e.issueId, i);
        });
        return [...firstSeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    }

    subscribe(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
}

export function logEvent(event: PipelineEvent): void {
    console.log(`[${event.shortId}] ${event.stage} ${event.status}: ${event.summary}`);
}
