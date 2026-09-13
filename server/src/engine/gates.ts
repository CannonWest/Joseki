import type { GateDecision } from '@joseki/shared';

interface Waiter {
  executionId: string;
  settle: (decision: GateDecision) => void;
  fail: (error: Error) => void;
}

/**
 * Where a paused run waits for a person. The executor registers a waiter
 * for the gate it stopped at; the socket handler settles it when the
 * decision arrives, or fails it on cancel. Waiters live in memory only —
 * a paused run does not survive a server restart.
 */
export class GateRegistry {
  private waiters = new Map<string, Waiter>();

  private key(executionId: string, nodeId: string): string {
    return `${executionId}:${nodeId}`;
  }

  /**
   * Wait for the decision at one gate. Rejects after `timeoutMs` when set,
   * or when the run is cancelled.
   */
  wait(executionId: string, nodeId: string, timeoutMs?: number): Promise<GateDecision> {
    const key = this.key(executionId, nodeId);
    if (this.waiters.has(key)) {
      return Promise.reject(new Error(`Already waiting on gate ${nodeId} of execution ${executionId}`));
    }
    return new Promise<GateDecision>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(key);
      };
      const waiter: Waiter = {
        executionId,
        settle: (decision) => { done(); resolve(decision); },
        fail: (error) => { done(); reject(error); }
      };
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(
          () => waiter.fail(new Error(`No decision within ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs
        );
        // A waiting gate must not keep the process alive on its own.
        timer.unref();
      }
      this.waiters.set(key, waiter);
    });
  }

  /** Deliver a decision. False when nothing is waiting at that gate. */
  resolve(executionId: string, nodeId: string, decision: GateDecision): boolean {
    const waiter = this.waiters.get(this.key(executionId, nodeId));
    if (!waiter) return false;
    waiter.settle(decision);
    return true;
  }

  /** Fail one waiting gate. False when nothing is waiting there. */
  fail(executionId: string, nodeId: string, reason: string): boolean {
    const waiter = this.waiters.get(this.key(executionId, nodeId));
    if (!waiter) return false;
    waiter.fail(new Error(reason));
    return true;
  }

  /** Fail every gate the execution is waiting at. Returns how many there were. */
  cancel(executionId: string, reason: string): number {
    let count = 0;
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.executionId !== executionId) continue;
      waiter.fail(new Error(reason));
      count++;
    }
    return count;
  }

  /** The gates currently waiting, optionally for one execution. */
  pending(executionId?: string): Array<{ executionId: string; nodeId: string }> {
    const out: Array<{ executionId: string; nodeId: string }> = [];
    for (const [key, waiter] of this.waiters) {
      if (executionId && waiter.executionId !== executionId) continue;
      out.push({ executionId: waiter.executionId, nodeId: key.slice(waiter.executionId.length + 1) });
    }
    return out;
  }
}

/** The registry the socket handler and the executor share. */
export const gates = new GateRegistry();
