// Who spent what.
//
// The spending ledger (`agent/evals/lib/ledger.ts`) totals the whole sweep.
// Reports want a cost per setup, and grade passes for different setups can
// overlap. `CostMeter` reads the total whenever a grade job starts or ends and
// splits each interval's spending equally among the jobs that were running,
// and each job's share equally among the setups it covers.

export class CostMeter {
  private readonly active = new Map<string, readonly string[]>();
  private readonly owed = new Map<string, number>();
  private last: number;
  private lost = 0;
  private readonly readSpent: () => number;

  constructor(readSpent: () => number) {
    this.readSpent = readSpent;
    this.last = readSpent();
  }

  private settle(): void {
    const now = this.readSpent();
    const delta = Math.max(0, now - this.last);
    this.last = now;
    if (delta === 0) {
      return;
    }
    if (this.active.size === 0) {
      this.lost += delta;
      return;
    }
    const perJob = delta / this.active.size;
    for (const owners of this.active.values()) {
      const perOwner = perJob / owners.length;
      for (const owner of owners) {
        this.owed.set(owner, (this.owed.get(owner) ?? 0) + perOwner);
      }
    }
  }

  /** A job starts. `owners` are the setup ids that share its cost. */
  start(job: string, owners: readonly string[]): void {
    this.settle();
    this.active.set(job, owners.length > 0 ? owners : ["unattributed"]);
  }

  end(job: string): void {
    this.settle();
    this.active.delete(job);
  }

  /** Dollars attributed to a setup so far. */
  costOf(setupId: string): number {
    this.settle();
    return this.owed.get(setupId) ?? 0;
  }

  /** Spending that happened while no job was running. */
  get unattributed(): number {
    this.settle();
    return this.lost;
  }
}
